# Serve 协议（`--serve` 本地 HTTP 网关）

> 版本：V1 · 与源码同步（契约面：`src/cli/serve.ts`、`src/presentation/http/`——csrfPolicy/httpSecurity/httpSessionIsolation/httpTokenStore）。
> 定位：本地桌面端/面板/第三方集成的开放面；**仅本机监听，绝不暴露公网**。

## 1. 启动与端面

```bash
wxnodus --serve            # 默认 http://127.0.0.1:4789
```

| 端点 | 认证 | 语义 |
|---|---|---|
| `GET /health/live` | 无 | 最小存活探针（不泄漏 dataDir/cwd/model/统计） |
| `GET /health` | Bearer | 完整状态（需 token） |
| `GET /flow` | 无 | 管线流图可视化（纯静态零数据页：零外部资源 + 严格 CSP + no-store；六阶段流图标注真实实现文件锚点） |
| `POST /rpc` | Bearer + CSRF | `{ method, params }` → 会话 RPC（跨源状态修改被 CSRF 拒绝） |
| `GET /events` | Bearer | SSE 事件流（与 wire 同源事件总线） |
| `/mcp` | Bearer + CSRF | incoming MCP Streamable HTTP facade（与 `--mcp-server` 同一 ports 构造） |

## 2. 三重防护（默认开启，fail-closed）

1. **Bearer 鉴权**：启动时生成/读取本地 token（`httpTokenStore`），所有业务端点要求 `Authorization: Bearer <token>`；
2. **CSRF 判定**（`csrfPolicy.ts`）：状态修改请求校验 Origin/预检，跨源即拒（`HTTP_CSRF_BLOCKED`）——防恶意网页驱动本地命令；
3. **会话所有权**（`httpSessionIsolation.ts` + `serve_session_ownership` 表）：session 与调用方 principal 绑定，跨 principal 访问被拒。

## 3. `/flow` 管线流图（可视化，2026-08-27）

- **静态模式**：浏览器打开 `http://127.0.0.1:4789/flow` 即得六阶段管线流图（用户输入入队 → 策略裁决 → 模型调用 → 工具执行 → 事件流 → 审计），每阶段标注真实实现文件路径；页面零外部资源、严格 CSP、`Cache-Control: no-store`，不含任何会话数据。
- **实时模式**：`/flow?session_id=<sid>` 打开后在页内输入 `--serve` token（仅存本页 sessionStorage）——浏览器 EventSource 无法携带 Authorization 头，页面用**同源 fetch 流式读取** `/events`（Bearer 不变、网关认证面不弱化）；事件按类型点亮对应阶段并累计计数（`agent.start`→入队、`agent.token/message`→模型、`agent.tool`→工具、`agent.end/run.final`→审计）。
- 页面实现：`src/presentation/http/flowPage.ts`（纯函数渲染 + 阶段/事件映射常量，7 测试锁定零外部资源与无注入面）。

## 4. RPC 方法面

`POST /rpc` 的 `method` 走网关 RPC 注册表（`src/application/gatewayService.ts` 装配），含会话（run/历史/列表）、命令（command 白名单）、模型/成本/配置等——**方法白名单制**，未注册方法返回错误码。

## 5. 消费方约束

- 只信任 127.0.0.1 监听面；反向代理/端口转发会破坏 CSRF 前提，禁止。
- SSE 重连按 `Last-Event-ID` 语义消费；token 泄漏即视为本机失陷。
- 会话 RPC 与 `--wire` 的事件流共享终态语义（六终态，`src/protocol/runs.ts`）。
