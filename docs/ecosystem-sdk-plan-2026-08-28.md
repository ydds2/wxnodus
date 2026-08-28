# 竞品完整体系普查与 wxnodus SDK 无云端方案（2026-08-28）

> **任务（用户 2026-08-28）**：① 查阅同类型 agent 工具与 CLI 的完整体系构建；② 基于 wxnodus 现状列出缺少部分；③ 给出 wxnodus SDK 搭建方案——**明确不建云端中心**。
> **证据纪律**：竞品锚点取自本地克隆（`Desktop\cli-compare\`）本轮亲验；wxnodus 锚点为本会话累计核验（architecture-2026-08-27.md + 源码）。

---

## 1. 竞品完整体系矩阵（六大件普查）

体系六件 = ①核心引擎 ②交互 TUI ③headless/CI ④本地服务面 ⑤SDK/编程面 ⑥扩展生态。本轮重点补查 ④⑤（前几轮已覆盖 ①②③）。

| 产品 | ④本地服务面 | ⑤SDK/编程面 | ⑥扩展生态 | 锚点（本轮亲验） |
|---|---|---|---|---|
| **opencode** | `opencode serve --hostname --port`（SDK 默认 **127.0.0.1:4096**） | **两层**：`packages/sdk/js`（**OpenAPI 生成客户端** `gen/` + `openapi.json` 单一事实源）+ `createOpencodeServer()`（cross-spawn 拉起本地 serve，配置经 `OPENCODE_CONFIG_CONTENT` env 注入）；另有 `sdk-next`/`core`（进程内） | plugin/function/slack/desktop/web/storybook/enterprise… 40+ 包 | opencode sdk/js 的 server.ts（spawn+hostname/port/env）与 client/gen 模块 |
| **gemini-cli** | a2a-server 包 | **进程内 SDK**：`@google/gemini-cli-sdk` → `GeminiCliAgent` 类，`session()`/`resumeSession(id)`，`for await (chunk of session.sendStream(...))` 流迭代器；`SDK_DESIGN.md` 明示 hooks/skills/subagents/**ACP 尚未进 SDK**（分层交付） | vscode-ide-companion、devtools | gemini sdk 包 SDK_DESIGN.md（状态表+示例）与 agent 模块 |
| **codex** | `app-server`（Rust JSON-RPC 服务，IDE/桌面 App 集成面，30+ 模块：config_manager/command_exec/attestation…） | JSON-RPC 协议优先（app 客户端自实现）；`exec --json` headless 事件流 | IDE 扩展、skills 目录 | `codex-rs/app-server/src/`（模块清单） |
| **kimi-cli** | acp 子包 | agentspec.py（agent 定义文件生态）、hooks 引擎、notifications | skills/agents 文件 + hooks | `src/kimi_cli/`（acp/agents/agentspec/hooks/notifications） |
| **crush** | csync（会话同步）/dns | 无正式 SDK（charm 生态绑定） | theme/plugin 体系 | `internal/`（csync/dns/discover…） |
| **aider** | — | Python 包可直接 import（历史知识，未本轮复核 ⚠️） | 浏览器驱动 | — |

**共性结论（直接回答「无云端可行性」）**：六家 SDK/服务面**无一以云端中心为前提**——opencode spawn 本地 serve、gemini 进程内嵌、codex 本地 JSON-RPC；身份=本机回环+token/env，分发=包管理器，发现=stdout/env 握手。云端（OAuth/云会话）在各家都是**可选增强而非 SDK 前提**。wxnodus「数据不出机」定位与主流 SDK 形态天然兼容。

---

## 2. wxnodus 现状对照（已有面盘点）

| 六件 | wxnodus 现状 | 锚点 |
|---|---|---|
| ①核心引擎 | kernel 110 文件（循环/流式/压缩/权限/记忆/子代理），可靠性第一梯队 | kernel-eval-2026-08-27.md |
| ②交互 TUI | 薄层 kimi 风格 TUI（T1–T12 台账全绿） | presentation/tui/ + 差距台账 |
| ③headless/CI | `-p`（退出码 0/1/42/53）·`--wire` stream-json·stdin 管道 | cli/index.ts 分流 |
| ④本地服务面 | `--serve`：**仅绑 127.0.0.1**，端口 4789（env 可覆盖），`WXNODUS_SERVE_TOKEN` Bearer+CSRF+会话所有权，`/rpc`+`/events` SSE+`/flow`；`--mcp-server`（stdio 与 `/mcp` HTTP 同一 ports）；ACP；A2A；execServer | cli/serve.ts:5-10 · wxnodusMcpServer.ts:16-21,73-95 |
| ⑤SDK/编程面 | **雏形但未成包**：protocol/ 契约层 + cliComposition 组合根可编程 + headlessGateway；MCP 能力门 surfaces（session/memory 已交付，build/verify/evidence/browser/computer/forge 标记 future） | WXNODUS_MCP_SURFACES |
| ⑥扩展生态 | skills/hooks/agents 文件（.wxnodus/agents/*.md）/插件本地运行时//market 开放生态聚合（只收不出）/vscode-ext 0.2.0/eval 任务库 10 | 相关模块 |

---

## 3. 缺口清单（对照矩阵，分级）

### P0（SDK 成包前提）

| # | 缺口 | 现状差距 | 参考形态 |
|---|---|---|---|
| G-1 | **正式 SDK 包（@wxnodus/sdk）不存在** | 有零件（serve/wire/protocol）无客户端包： typed client、spawn-attach、流消费封装全缺 | opencode `sdk/js`（spawn+client） |
| G-2 | **spawn 握手协议** | `--serve` 的 token 只能经 env 预置（`WXNODUS_SERVE_TOKEN` 未配则 401）——父进程拉起子进程后**无法安全拿到 token/端口** | opencode：spawn 后固定端口；更好形态：`--serve --sdk` 在 stdout 打印一行握手 JSON `{port,token,pid,version}`（token 随机生成不落盘） |
| G-3 | **协议版本协商** | RPC/事件流无版本号与能力协商（MCP 侧已有 `wxnodus://capabilities` 资源雏形，HTTP/wire 面无） | codex JSON-RPC serverInfo 版本；capabilities 升格为三面通用 |

### P1（体系完整性）

| # | 缺口 | 说明 |
|---|---|---|
| G-4 | 进程内嵌入 API 未稳定化 | `createCliComposition`/`createAgent` 事实上是 gemini `GeminiCliAgent` 等价物，但无 semver 承诺面/入口导出/SDK 文档——进程序集成只能读源码 |
| G-5 | MCP surfaces 大半标记 future | build/verify/evidence/browser/computer/forge 未交付——「把 wxnodus 当 MCP 工具用」（多语言 SDK 替代路）能力面窄于 CLI 面 |
| G-6 | stream-json 事件消费规范缺失 | `--wire` 事件流无 typed 消费端/重连语义文档（SDK 的核心增值之一） |
| G-7 | CI/自动化配方缺失 | 无 GitHub Action/预提交/管道官方示例（竞品均有 CI 用例文档） |
| G-8 | 密钥注入规范未文档化 | env 密钥链已有（WXNODUS_*_KEY）但 SDK 场景（CI 容器）的注入/最小权限指引缺 |

### P2（可选增强，均不涉云）

| # | 缺口 | 说明 |
|---|---|---|
| G-9 | Python/多语言客户端 | 不自建——**经 MCP 面**达成（G-5 补齐后任何 MCP 客户端语言即 SDK） |
| G-10 | serve 多实例/端口冲突策略 | 固定 4789 无 --port 冲突回退（args 有 --port，serve env 亦有；SDK spawn 需随机端口+握手回传，与 G-2 合并解决） |
| G-11 | 事件回放 SDK 化 | events.jsonl 可重放但无 SDK 侧 replay API |

---

## 4. SDK 方案：本地三层（无云端中心）

**设计原则**（源自普查结论+产品四约束）：回环绑定不变、token 本机随机不落盘、分发走 npm、扩展分享走 `/bundle`（只收不出）、云端能力永不进入 SDK 依赖路径。

```
┌─ 层 3 协议适配层（任何语言/编辑器/Agent）────────────────┐
│  MCP server（--mcp-server stdio + /mcp HTTP）             │
│  + ACP + A2A —— wxnodus 即工具/即协作端                    │
├─ 层 2 本地服务层（@wxnodus/sdk，opencode 模式）───────────┤
│  spawn('wxnodus', ['--serve','--sdk'])                    │
│   → 子进程 stdout 一行握手 {port,token,pid,version,caps}   │
│   → typed client：POST /rpc（Bearer token）+ /events SSE  │
│   → 会话/审批/事件流/取消 全量映射 protocol/ 契约类型       │
│   → kill(pid) 生命周期托管（signal 透传）                   │
├─ 层 1 进程内嵌入层（@wxnodus/core，gemini 模式）──────────┤
│  export { createCliComposition, createAgent }             │
│  + WxnodusAgent 门面类（session()/sendStream() 迭代器）     │
│  —— semver 承诺面 = protocol/ + 组合根签名，文档化锁定      │
└──────────────────────────────────────────────────────┘
```

**关键机制**：
1. **握手（G-2）**：`--serve --sdk` 模式下 token 改为随机生成、stdout 单行 JSON 回传（仅父进程可见——stdout 管道私有性即安全边界），不写 env/不落盘；退出时随进程消亡。回环绑定保持硬编码 127.0.0.1。
2. **版本协商（G-3）**：`protocol/` 增 `PROTOCOL_VERSION` 常量，进握手 JSON 与 `/health` 响应；SDK 端不匹配即快失败并提示版本区间（MCP `wxnodus://capabilities` 资源升格复用）。
3. **typed client 生成路线**：不引 OpenAPI 栈——直接以 `src/protocol/*.ts` 契约类型为单一事实源，SDK 包 re-export + 薄 fetch/SSE 封装（类型漂移由 typecheck:tests 同仓锁定，优于 codegen 双事实源）。
4. **MCP 面 = 多语言 SDK**（G-5/G-9）：按能力门逐面交付 build/verify/evidence（browser/computer 维持高危默认关），任何 MCP 宿主（Python/Go/编辑器/其他 agent）零成本接入——这是「无云端多语言」的最短路径。
5. **分发与分享**：npm 发 `@wxnodus/sdk`/`@wxnodus/core`（无账号体系要求）；定制集成经 `/bundle` 离线整包流转（约束一既有通道）。

### 落地卡（估时）

| 卡 | 内容 | 量级 |
|---|---|---|
| S-1 | `--serve --sdk` 握手模式（随机 token+stdout JSON+PROTOCOL_VERSION）+ 测试 | 1 天 |
| S-2 | `@wxnodus/sdk` 包：spawn-attach + typed client（rpc/events/审批应答/取消/kill）+ 集成测试（真实 spawn 子进程） | 2-3 天 |
| S-3 | `@wxnodus/core` 门面：WxnodusAgent（session/sendStream 迭代器，gemini 形态）+ semver 面文档 | 1-2 天 |
| S-4 | MCP surfaces 补齐 build/verify/evidence + 能力协商三面统一 | 2-3 天 |
| S-5 | CI 配方（Action/预提交示例）+ SDK README + 密钥注入指引 | 1 天 |

顺序：S-1→S-2（核心闭环）→S-4（多语言面）→S-3/S-5（收口）。

---

## 5. 结论

- **「无云端 SDK」是主流形态而非妥协**——opencode/gemini/codex 三家 SDK 全部本地（spawn/进程内/本地 RPC），wxnodus 既有 127.0.0.1+token serve、MCP 双向、protocol 契约层已覆盖三层中的两层的零件；
- **真正缺的是成包与握手**：G-1~G-3（SDK 包/stdout 握手/版本协商）三件做完，wxnodus 即具备与 opencode 同级的本地 SDK；MCP 面补齐（G-5）后天然获得多语言；
- 全程零云端依赖：分发 npm、发现 stdout、身份本机 token、分享 /bundle——与「数据不出机」「只收不出」两约束完全自洽。
