# Wire 协议（`--wire` / `--stream-json` 事件流）

> 版本：V1 · 与源码同步（契约单一事实源：`src/protocol/events.ts`、`src/cli/headlessGateway.ts`、`src/protocol/runs.ts`）。
> 可运行示例：`examples/wire-events.mjs`（最小消费者）、`examples/wire-approval-responder.mjs`（审批应答者）。

## 1. 启动

```bash
wxnodus -p "需求" --wire            # stdout 输出 JSONL 事件流；stdin 为帧通道
wxnodus -p "需求" --stream-json     # 别名，完全同构
```

## 2. stdout：事件流（每行一个 JSON 事件）

事件信封（`src/protocol/events.ts` 的 GatewayEvent，关键字段）：

```json
{ "schemaVersion": 1, "type": "agent.start", "ts": "…", "runId": "…",
  "correlationId": "…", "sessionId": "…", "source": "wire", "payload": { … } }
```

**契约要点**：

| 项 | 语义 |
|---|---|
| `agent.start` / `agent.message` / `agent.end` | 回合生命周期；任何回合结束必发 `agent.message`+`agent.end`（事件闭环纪律） |
| `agent.token` / `agent.reasoning.delta` | 流式增量（高频，不落盘） |
| `agent.tool` | 工具执行 start/complete（`toolId` 为工具调用 id） |
| `approval.request` | 审批弹窗广播，**`request_id` 是应答唯一依据**（`agent.tool` 的 toolId 不可混用） |
| `clarify.request` / `system.notice` | 澄清请求 / 系统通知 |
| `wire.response` | 对 stdin 请求帧的应答（method/ok/error.code） |
| `agent.result` | 终态，`wireFinal ∈ {succeeded, failed, blocked, incomplete, inconclusive, cancelled}`（六终态，`src/protocol/runs.ts`） |

## 3. stdin：请求帧（每行一个 JSON）

```json
{ "method": "approval.respond", "params": { "request_id": "<来自 approval.request>", "answer": "allow" } }
```

| method | params | 应答 |
|---|---|---|
| `approval.respond` | `request_id`, `answer: 'allow'|'session'|'deny'` | `wire.response` |
| `clarify.respond` | `request_id`, `answer: string` | `wire.response` |
| `sudo.respond` | `request_id`, `answer: string`（内存使用不落盘） | `wire.response` |

**fail-closed**：审批/澄清/密码/表单等待 stdin 帧超时 → 按 `deny` / 空串 / `null` 收口（绝不静默放行）。

## 4. 退出码协议

| 码 | 语义 |
|---|---|
| 0 | 成功（`agent.result.wireFinal === 'succeeded'`） |
| 1 | 失败/受阻（终态非 succeeded） |
| 42 | 输入错误（参数/配置不合法） |
| 53 | 轮次上限 |

（对齐 gemini headless 分类学，`src/cli/runCompletionGate.ts`。）

## 5. 消费方约束

- stdout 只写 JSONL（无杂讯）；stderr 为诊断通道。
- 退出码是协议的一部分：任何失败不得藏在 exit 0 后面。
- 事件可能乱序到达（并行工具批次）；按 `correlationId`/`runId` 聚合。
