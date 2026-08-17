# wxnodus --wire / --stream-json 事件流协议（v1）

> 机器可读 schema 文档。`--wire` 与 `--stream-json` 是同一事件流的两个名字（后者为
> gemini/kimi 命名对齐的别名，`src/cli/args.ts` 解析后并入 wire，单一事实源）。
> 参考实现：kimi-cli `examples/kimi-cli-stream-json`、gemini `--output-format stream-json`。
> 契约锚点：`src/cli/index.ts` wire 分支（事件订阅 → 双向帧 → agent.run → agent.result → 退出码）、
> `src/protocol/completionTransport.ts`（终态→退出码共享表）、`tests/cli-wire-alias.test.ts`。

## 0. 总则

- 输出通道：**stdout 只承载 JSONL 事件行**（每行一个 JSON 对象），诊断信息走 stderr。
- 启动：`wxnodus -p "<需求>" --wire`（或 `--stream-json`）。
- 双向性：stdout 出事件流；**stdin 进请求帧**（审批/澄清/密码应答），stdout 回 `wire.response`。
- 终止：流以一行 `agent.result` 收尾；退出码见 §4。任何 failure 不藏在 exit 0 后面。

## 1. 事件行 schema

每行 = `{"type": "<事件名>", ...载荷字段}`（载荷直接铺平在顶层，字段以各事件实际 emit 为准）。

| type | 载荷字段 | 语义 |
|---|---|---|
| `agent.start` | `sessionId`, `prompt` | 回合开始（agent.ts:913） |
| `agent.token` | `text` | 流式文本分片（增量） |
| `agent.message` | `content` | 整段消息（流末完整文本） |
| `agent.tool` | `name`, `args?`, `phase: 'start'\|'complete'`, `ok?`, `ms?`, `toolId`, `session_id` | 工具调用开始/完成 |
| `agent.error` | `message` | 回合级错误 |
| `agent.end` | `ok`, `turns` | 回合结束标记（最终文本另由 agent.message 承载） |
| `system.notice` | `text` | 系统提示（压缩/降级/进度） |
| `agent.result` | `ok`, `text`, `turns`, `interrupted`, `wireFinal` | **终态行（恒为最后一行）** |
| `wire.response` | `method`, `ok`, ...RPC 返回字段 / `error: {code}` | stdin 请求帧的应答 |

`wireFinal ∈ succeeded | failed | blocked | incomplete | inconclusive | cancelled`；
若前端投影管线与共享表漂移，`wireFinal = 'FRONTEND_COMPLETION_MISMATCH'`（fail-closed）。

## 2. 请求帧（stdin → stdout 应答）

每行一个 JSON：`{"method": "<RPC 方法>", "params": {...}}`。

| method | params | 用途 |
|---|---|---|
| `approval.respond` | `{request_id, answer: "allow"\|"deny"\|...}` | 应答工具审批弹窗 |
| `clarify.respond` | `{request_id, answer}` | 应答澄清提问 |
| `sudo.respond` | `{request_id, ...}` | 应答 sudo 弹窗 |
| `secret.respond` | `{request_id, ...}` | 应答密钥输入弹窗 |

规则：
- gateway/frontend 全部装配完成前到达的帧 → 回 `{"type":"wire.response","method":…,"ok":false,"error":{"code":"WIRE_GATEWAY_NOT_READY"}}`（KF-027，绝不静默吞掉）。
- 非 JSON 行或无 method 字段的帧被忽略。
- 应答超时由服务端 fail-closed（deny/''/null）。

## 3. 退出码（completionTransport 共享表）

| 退出码 | 终态 | 含义 |
|---|---|---|
| 0 | succeeded | 完成 |
| 1 | failed | 失败（422） |
| 2 | blocked | 被阻断（409） |
| 3 | incomplete | 未完成（424） |
| 4 | inconclusive | 无结论（503） |
| 130 | cancelled | 被中断（499） |

## 4. 可运行示例

- `examples/wire-events.mjs`：最小消费者——spawn + 逐行解析事件流 + 终态退出码透传。
- `examples/wire-approval-responder.mjs`：审批应答消费者——识别 `agent.tool` 危险工具调用并回 `approval.respond`（演示帧通道）。

运行（仓库根）：`node examples/wire-events.mjs "帮我列一下当前目录"`

## 5. 已知边界（诚实声明）

- `--wire` 需要 `-p`（单发模式）；交互 TUI 内不走 wire。
- `--wire` 模式下 stdin 是**帧通道**，不是管道素材（stdin 管道模式在 wire 下禁用）。
- 事件载荷为「当前 emit 的铺平快照」，非稳定 JSON Schema 版本化——消费方应容错读取（未知字段忽略）；跨版本破坏性变更会写入 CHANGELOG。
