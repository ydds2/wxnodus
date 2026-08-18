# wxnodus --serve 协议（桌面端/面板契约，v1）

> supremacy 2.5 协议加固（2026-08-18）。桌面端/外部面板的机器接口：HTTP + SSE。
> 数据源单一事实原则：会话列表与 `/sessions --json`、IDE 插件共用同一数据出口
> （`kernel/sessionLineage.listSessionsStructured`）。
> 实现锚点：`src/cli/serve.ts`；契约测试：`tests/kernel-serve.test.ts` + `tests/cli-serve-protocol.test.ts`。

## 0. 启动与安全

```bash
wxnodus --serve                      # 绑定 127.0.0.1（仅本机）
WXNODUS_SERVE_PORT=4789              # 端口（缺省 4789）
WXNODUS_SERVE_TOKEN=<token>          # Bearer token（未配置时除 /health/live 外全部 401——fail-closed）
WXNODUS_SERVE_ORIGINS=<逗号分隔>     # CORS origin allowlist（浏览器端面板用；永不 *）
```

- 认证：除 `/health/live` 外全部要求 `Authorization: Bearer <token>`（timingSafeEqual 比较）。
- CSRF：带 Origin 的跨源请求先过 allowlist 判定（跨源携带有效 token 也拒绝）。
- 请求体上限 1MB（超限 413）。

## 1. 路由

| 路由 | 认证 | 说明 |
|---|---|---|
| `GET /health/live` | 无 | 最小存活探针（零泄漏：不含 dataDir/model/统计） |
| `GET /health` | Bearer | 完整状态（model/dataDir/cwd/messages 计数） |
| `GET /events` | Bearer | SSE 事件流（见 §2） |
| `POST /rpc` | Bearer | JSON-RPC（见 §3） |
| `POST/GET/DELETE /mcp` | Bearer | W3 MCP facade（Streamable HTTP，装配时挂载） |

## 2. SSE 事件（GET /events）

首事件 `ready`；此后按发生顺序推送。格式：`event: <名>\ndata: <JSON>\n\n`。

| event | data 字段 | 语义 |
|---|---|---|
| `ready` | `{connected:true}` | 连接建立（首事件） |
| `agent.start` / `agent.token` / `agent.message` / `agent.tool` / `agent.error` / `agent.end` | 与 --wire 同源（`docs/wire-protocol.md` §1） | 回合事件实时转发 |
| `system.notice` | `text` | 系统提示（压缩/降级/沙盒等） |
| `voice.transcript` | 语音字段 | 语音转写（启用时） |
| **`session.changed`** | `{sessionId, reason: 'chat'\|'command', ts}` | **会话变更广播（supremacy 2.5）**——/rpc chat/command 完成即推；面板据此刷新会话列表（重新拉 `sessions` RPC 即可，无需轮询） |

## 3. RPC（POST /rpc：`{method, params}`）

| method | params | 返回 | 状态码口径 |
|---|---|---|---|
| `chat` | `{prompt, session_id?}` | `{ok, text, turns, interrupted}` | completionTransport 映射（0 语义的 HTTP 版：succeeded 200 / failed 422 / cancelled 499 …） |
| `command` | `{command}` | `{ok, output, error}` | 同上 |
| `memory.search` | `{query, limit?}` | `{ok, hits}` | 200 |
| `memory.recall` | `{session_id?}` | `{ok, messages}` | 200 |
| `sessions` | — | `{ok, sessions}` | 200 |

`sessions` 结构化行（与 `/sessions --json` 同形，桌面端历史树单一数据源）：

```json
{ "id": "s1", "title": "待办系统", "createdAt": 1755470000000, "updatedAt": 1755471000000,
  "msgCount": 42, "firstUser": "帮我做一个待办系统", "forkedFromId": null, "forkCount": 2 }
```

## 4. 桌面端接入建议（施工图）

1. 会话历史树：`POST /rpc {method:"sessions"}` → 结构化列表（含血缘/分支数——树形渲染直接可用）。
2. 实时性：`GET /events` 订阅 `session.changed` → 触发一次 sessions 拉取（事件驱动，无轮询）。
3. 对话：`POST /rpc {method:"chat"}`；审批交互走**--wire 帧语义的等价物**——当前 serve 下审批在服务端超时 fail-closed（deny）：
   **诚实边界（supremacy 2.5 口径）**：serve 模式暂不支持交互审批（chat RPC 内审批缺省 deny——
   与 --wire 的 stdin 帧通道不同）。桌面端需要交互审批时，用 --wire 宿主模式（IDE 插件同款桥接，
   `packages/vscode-ext/src/extension.ts` 参考实现）——serve 的审批 RPC 通道列入后续协议版本。
4. 数据不出机：全部绑定 127.0.0.1；token 未配置即 401（绝不静默开放）。
