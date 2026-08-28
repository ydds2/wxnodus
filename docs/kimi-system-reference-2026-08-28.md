# kimi-cli 完整体系参考目录（Phase 1 · 2026-08-28）

> **定位**：本目录是「迁移 kimi code CLI 完整体系过来进行参考」的落地物——**机制与锚点的系统化目录，不迁移任何代码**（AGENTS.md「参考不抄袭」红线）。每条：kimi 机制 + 锚点 + wxnodus 现状对照 + 裁决（已对齐/待自研/有意不做）。
> **勘察范围**：`cli-compare/kimi-cli/src/kimi_cli/` 全量（顶层 14 模块 + 22 子包；本轮逐一清点，关键文件亲验）。
> **后续**：Phase 2 按「待自研」列实施（见文末选型）；差距台账（kimi-gap-alignment-ledger.md）继续跟踪 T/UI 项。

## 1. 体系总图（22 子包 + 顶层模块）

| 子包 | 规模 | 职责（亲验） | wxnodus 对照 | 裁决 |
|---|---|---|---|---|
| `soul/`（15） | 核心 | 回合状态机（kimisoul 2e.x 八步）、toolset（去重/canonical）、context（历史+token 计数+pending 预估）、compaction（ratio/reserved 双触发+preserved 保底）、dynamic_injection（归一化/注入）、approval、btw 旁路问答、slash、denwarenji | kernel/agent.ts + llmStream + historyNormalize + memory 压缩 | ✅ 已对齐（B/C/D/E/F 批次+台账）；compaction 双触发 ours=ctxBase−reserve+ratio 语义等价且多 micro 级 |
| `subagents/`（9） | 子代理 | LaborMarket 注册表、launch spec/instance **持久化 store**（重启恢复）、builder/runner、git_context（explore 注入仓库上下文）、output | kernel spawnSub + subagentTypes + w2-10 恢复契约测试 + 首轮 autoInject（结构/技能） | ✅ 基本对齐（def.model/baseURL/mode/工具白名单已有；恢复走 w2-10 契约） |
| `background/`（8） | 后台 | TaskSpec(kind: bash/agent)/Runtime/Control/ConsumerState、manager(725行)、worker、store、summary | kernel/taskRunner /jobs（真进程/子代理/双线）+ cron + jobs.complete 回流（B） | ✅ 对齐；kimi summary（长输出自动摘要）≈ ours offload+蒸馏（默认关），形态不同价值等价 |
| `hooks/`（5） | 钩子 | engine(371行)：**声明式 matcher**（事件值匹配）、command/type 两类钩子、OnTriggered/OnResolved 回调、**wire hook**（钩子经 wire 由客户端执行） | kernel/hooks.ts：preToolUse/postToolUse/sessionStart/stop/preCompact/postCompact/notification/userPromptSubmit + P2-15 接线 | ⚠️ **待自研 P2-A：声明式 matcher**（现须在 handler 内自写 if）；wire hook 有意不做（headless 客户端钩子属 --wire 前端职责） |
| `notifications/`（7） | 通知 | manager/store/**持久化 store**/notifier/llm（注入）/wire（投递） | noticeQueue 回流+hook 通知+T4 severity | ⚠️ 小差距：通知不持久（跨重启丢未消费通知）——durable queue 已保用户消息，通知可同待遇；**P2-C 候选** |
| `approval_runtime/`（3） | 审批 | Request/ResponseKind/Source 记录+事件+root_hub 集成 | permissions 四模式+三层策略+会话授权+autoReview+审批桥 | ✅ 对齐且更深（P1-4 排序裁决/autoReview） |
| `acp/`（9） | ACP | Agent Client Protocol 全实现（含 checkpoint 语义） | kernel/acp.ts 单文件 | ✅ 够用（IDE 面非主体；差异记录） |
| `wire/`（8） | 事件线 | 双向帧协议、hook 请求、DisplayBlock | --wire stream-json + headlessGateway + completionTransport | ✅ 对齐 |
| `ui/`（32）+`vis/`（6） | TUI | _blocks（T1-T4 锚点）、prompt（T5）、theme | presentation/tui 薄层 T1-T12 | ✅ 台账全绿 |
| `cli/`（10） | 命令面 | 命令注册/补全 | commands/registry SLASH+NL 路由+T11 补全 | ✅ 对齐 |
| `tools/`（26） | 工具 | 工具面 | kernel/tools 45+ | ✅ |
| `utils/`（37） | 工具库 | — | 各层 lib | ✅ |
| `web/`（14）+`vis/` | Web UI/可视化 | 浏览器面 | --serve /flow 静态页 | 🚫 有意不做（非 CLI 主体；--serve 已是开放面） |
| `auth/`（3） | 登录流 | 账号/OAuth | 密钥 AES-GCM 本地制 | 🚫 有意不做（数据不出机定位） |
| `telemetry/`（4） | 遥测 | — | 本地 crashes+doctor | 🚫 有意不做（不出机） |
| `skill/`+`plugin/`+`prompts/` | 生态 | 技能/插件/提示 | skills.ts+plugins.ts+/market 只收不出 | ✅ |
| 顶层 | | agentspec（yaml+Inheritance+builtin）、config、session/fork/session_state、share、llm、app、mcp_oauth | agents .md 定义+fork/checkpoint/lineage+/bundle 分享 | agentspec≈对齐（model/baseURL/mode/tools）；**mcp_oauth → P2-B：MCP server 鉴权头**（砍 OAuth 流程：headers+env 引用，凭证不落盘）——修复审计 C 级「MCP HTTP 配置无鉴权头」 |

## 2. 关键机制锚点速查（Phase 2 实施依据）

- **hooks matcher**：`hooks/engine.py:33`（`matcher: str = ""`）·`:97-110`（trigger(matcher_value=…)）；`(all)` 显示语义 `:179`
- **mcp_oauth**：`mcp_oauth.py:10-24`（share_dir/mcp-oauth 0700 目录 + FileTreeStore 本地凭证存储——**只取「本地凭证目录+权限」思想，不做 OAuth 流**）
- **compaction 双触发**：`soul/compaction.py:64-75`（ratio OR reserved）；preserved 保底 `:111-157`（max_preserved_messages=2）
- **subagent 持久 store**：`subagents/store.py:1-20`（_AgentLaunchSpecPayload/_AgentInstanceRecordPayload）
- **background kinds**：`background/models.py:8`（`TaskKind = Literal["bash","agent"]`）·TaskControl `:73`
- **session fork**：`session_fork.py:1-25`（turn 枚举+CHECKPOINT_USER_PATTERN+选择器）

## 3. Phase 2 选型（本轮自研实施）

| 项 | 来源锚点 | 自研方案（原创） | 排除 |
|---|---|---|---|
| **P2-A hooks 声明式 matcher** | engine.py:33,97 | hooks 配置 schema 扩展：每钩子可选 `matcher`（前缀/通配，preToolUse 按工具名、notification 按类型值）；引擎命中才调 handler——用户不再手写 if | wire hook（客户端执行）不做 |
| **P2-B MCP server 鉴权头** | mcp_oauth.py 本地凭证思想 + 审计 C 级 | MCP server 配置支持 `headers`（值支持 `env:NAME` 引用）；HTTP 类 server 连接时注入；密钥经 env/vault 不落盘明文 | OAuth 授权流不做（云端交互） |
| P2-C 通知持久化 | notifications/store.py | **本轮不做**（durable queue 已保用户消息主链；通知丢失影响小，登记台账观察项） | — |

## 4. 有意不做清单（长期有效，与产品约束对齐）

web/vis 浏览器 UI · auth 账号流 · telemetry 云遥测 · OAuth（MCP/模型两端）· wire 客户端钩子——均违背「数据不出机/CLI 主体/只收不出」之一或多。
