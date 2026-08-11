# WxNodus V3 与 4 个同类型 CLI 全量对比报告

> 对比对象：**Claude Code**（Anthropic，闭源二进制+插件仓库）、**Kimi CLI**（Moonshot，Python，已宣布被 kimi-code 取代）、**Hermes Agent**（Nous Research，Python+TS 全开源）、**OpenAI Codex CLI**（Rust，全开源）。
> 分析依据：`docs/analysis/01~04`（各仓库 git tree/源码精读/官方类型定义交叉验证，推断项已标注）+ `docs/analysis/00`（WxNodus V3 自身盘点：194 文件/38.4k 行/439 测试/86 命令/21 依赖，2026-08 更新版）。
> 结论先行：**WxNodus V3 经独立改造化 + 深度体检 + 智能度提升后，已收口 P0/P1 差距（危险检测升级/规则文件/环境净化/Hooks 12 类/退出码/错误码），核心差距收窄至 P2（--wire 双向化/工具延迟加载/Flow skills/配置分层）与平台级能力（平台沙箱/事件源会话）。**
> 注：本版为更新对比——P0/P1 差距已实施（证据：`docs/audit-deep.md`），剩余项见第 3 节状态列。

---

## 1. 五方定位总览

| 维度 | Claude Code | Kimi CLI | Hermes Agent | Codex CLI | **WxNodus V3** |
|---|---|---|---|---|---|
| 语言/运行时 | 闭源 Bun 二进制 ~500MB | Python ≥3.12（~6 万行） | Python 内核 + TS 前端（4004+2062 文件） | Rust（~90 crates，Bazel） | **TypeScript ESM（203 文件/38.6k 行）** |
| 仓库规模 | 333 文件（插件/示例） | 988 文件 | 8722 文件/141MB | 6097 文件/548MB | 203 文件（小而精） |
| 模型 | 仅 Anthropic（云端） | Kimi 为主 + 多 provider | 多 provider（Anthropic/Bedrock/Gemini/Codex/Relay） | OpenAI 中心 + ollama/lmstudio/bedrock | **DeepSeek/Kimi/GLM 3 家 10 模型** |
| 本地能力 | 无本地模型 | 无 | 无（依赖云端） | ollama/lmstudio 可本地 | **数据全本地 + 本地 embedding + 可配本地端点** |
| 协议化 UI | 专有 TUI+SDK | Wire 1.10（四 UI 统一） | **135 RPC + 50 事件（stdio/WS 双传）** | app-server v2 + TS/Python SDK | **52 RPC + 40+ slash（自研 Ink）** |
| 许可证 | 闭源 | Apache-2.0 | MIT | Apache-2.0 | Apache-2.0 |

## 2. 逐维度对比矩阵

### 2.1 会话管理

| 能力 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 多会话切换 | ✅ /resume /agents | ✅ /new /sessions | ✅ session.* RPC | ✅ codex resume | ✅ /resume /sessions + 热切换 |
| 分支/fork | ✅ /fork（转后台） | ✅ /fork | ✅ session.branch | ✅ codex fork | ✅ /fork（全量消息复制） |
| 撤销 | ✅ /undo /rewind | ✅ /undo（fork 式回退） | ✅ session.undo（软删+checkpoint） | 事件源天然回放 | ✅ /undo 软归档+快照 |
| 检查点/时间旅行 | ⚠️ /rewind（文件级） | ✅ D-Mail checkpoint 回退 | ⚠️ rollback.diff | ✅ 事件源+resume | ✅ /checkpoint save/restore |
| 会话存储 | ~/.claude JSONL | context.jsonl+state.json | spawn-trees JSON | **rollout JSONL+zstd+SQLite 索引** | **SQLite（WAL+FTS5）** |
| 后台会话/守护 | ✅ --bg/daemon | ✅ 后台任务 worker | ✅ background | ✅ app-server | ✅ /jobs DB 持久化 + cron |
| 标题/元数据 | ✅ /rename | ✅ /title（自动） | ✅ session.title | ✅ thread title | ✅ /title + 自动标题 |

**差距**：Codex 的事件源会话（JSONL 追加+zstd+SQLite 索引）在审计/回放/恢复健壮性上领先；WxNodus 的 SQLite 单库方案简单可靠，但缺少「会话文件导出为通用 JSONL/trace」能力（Hermes 有 trace 导出，Claude 有 transcript 路径）。

### 2.2 记忆与上下文

| 能力 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 长上下文 | ✅ 原生 1M（默认压 200K） | ⚠️ 字符启发式估算 | ✅ | ✅ 模型目录化窗口 | ✅ 64k-256k 按模型 |
| 自动压缩 | ✅ auto-compact 三次防抖 | ✅ trigger 0.85+预留 50k | ✅ session.compress | ✅ 模型摘要+token 预算双通道 | ✅ 0.85 阈值+DB 联动归档 |
| 向量检索 | ❌ | ❌ | ✅ FTS5+LLM 摘要 | ❌ | ✅ **本地 embedding（transformers.js 384 维）+ FTS5 混合召回** |
| 自动记忆 | ✅ auto-memory（记忆文件+ProposeSkills） | ✅ 会话状态 | ✅ memory_manager+learning graph | ✅ memories（~/.codex/memories） | ✅ 黑洞吸附+curator 策展 |
| 项目引导 | ✅ CLAUDE.md 逐级注入 | ✅ AGENTS.md 32KiB 合并 | ✅ AGENTS.md+rules | ✅ AGENTS.md 32KiB+fallback CLAUDE.md | ✅ AGENTS.md 32KiB 注入 |
| 上下文诊断 | ✅ /context 带优化建议 | ✅ /debug | ✅ session.context_breakdown | ✅ get_context_remaining | ✅ /context token 分布 |

**差距**：Claude Code 的 auto-memory（记忆文件 + ProposeSkills 生成技能）是独特闭环；Codex 的 world_state 按 section diff 注入（只发变化部分）值得学。WxNodus 的黑洞引擎（本地向量）是**五家中唯一的离线向量检索**。

### 2.3 权限与审批

| 能力 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 模式数 | 6（default/acceptEdits/plan/bypass/dontAsk/**auto 分类器**） | 4 组正交（agent/shell、plan、yolo、afk） | yolo + 审批队列 | approval_policy 4 值（untrusted/on-request/granular/never） | 6（smart/auto/manual/plan/yolo/goal） |
| 审批缓存 | allow 规则会话内 | ✅ auto_approve_actions 持久化 | ✅ once/session/always | ✅ Accept/AcceptForSession/**写回规则文件** | ✅ createApprovalCache 会话级 |
| 危险命令检测 | 灾难性命令提示 | ❌ 无启发式（靠人工+hooks） | ✅ DANGEROUS_PATTERNS+HARDLINE 红线 | ✅ **wrapper 解包 8 层深度+安全白名单** | ✅ BASH_DANGEROUS+分段扫描最保守 rank |
| 规则文件 | ✅ settings.json 权限规则 | ❌ | ✅ 用户 deny 规则 | ✅ **Starlark 规则 DSL+预演 CLI** | ⚠️ 无持久化规则文件（仅模式+缓存） |
| 硬红线 | ⚠️ 灾难性命令提示 | ❌ | ✅ HARDLINE（yolo 也压不住） | ✅ BANNED_PREFIX 100+ | ✅ 8 条硬红线（任何模式不可绕过） |
| 沙箱 | ✅ **bubblewrap/socat+凭据掩码** | ❌ | ⚠️ 部分（file_safety） | ✅ **四平台沙箱（Seatbelt/bwrap+seccomp/受限令牌）** | ✅ /sandbox L0-L3 分层 |
| 敏感输入 | ❌（凭据用 keychain） | ❌ | ✅ secret.request/sudo.respond | ❌（env 白名单） | ✅ **/security 注入通道（亲手输入+关闭即清）** |

**差距（最大领域）**：
1. **持久化审批规则文件**——Codex 的 `prefix_rule` 规则 DSL + `execpolicy check` 预演 + 「批准并写回 default.rules」闭环、Claude 的 settings 权限规则文件，WxNodus 均无（只有模式+会话缓存）。建议：`/perm rule add <tool(glob)> allow|deny` 持久化。
2. **平台级沙箱**——Codex 四平台沙箱、Claude bubblewrap 凭据掩码远超 WxNodus 的 L0-L3 逻辑沙箱。
3. **危险命令检测深度**——Codex 的 wrapper 解包（sudo/env/trap/bash -lc 递归+深度上限）、Hermes 的 operand 后置 flag 变体，WxNodus 的 BASH_DANGEROUS 是前缀正则，可被 `rm build/ -rf` 类变体绕过——**建议直接移植 Hermes/Codex 的检测思路**。

### 2.4 工具系统

| 维度 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 内置工具数 | 42（含 Workflow/REPL/Monitor/Cron/Task 看板） | 18+3 动态源 | toolsets 分组（大量） | 18+（apply_patch 唯一写通道） | 15 内置+3 动态源 |
| 文件编辑 | FileEdit/Write（structuredPatch+gitDiff） | WriteFile/StrReplaceFile（diff 预览） | file_operations | **apply_patch（唯一通道）** | fs_read/write/edit |
| 子代理 | ✅ Task+subagent_type（5 模型）+isolation | ✅ coder/explore/plan+resume | ✅ **delegate_task fan-out（leaf/orchestrator+output_schema 纠错）** | ✅ 多智能体 v1/v2+角色 | ✅ /swarm 1-8 并行+/delegate |
| 后台任务 | ✅ 后台 Bash+Task 系列 | ✅ worker 子进程+心跳 | ✅ background | ✅ exec_command 后台 | ✅ /jobs+心跳 |
| 定时任务 | ✅ CronCreate（7 天过期+durable） | ✅ cron.manage | ✅ cron（多平台投递） | ✅ | ✅ /cron（真实调度） |
| 结构化提问 | ✅ AskUserQuestion | ✅（afk 自动驳回） | ✅ clarify | ✅ request_user_input | ✅ clarify 工具+UI 面板 |
| 工具发现 | MCP 延迟+MCPSearch | MCP 100k 预算 | schema 动态改写 | ✅ **tool_search BM25 延迟加载** | MCP+插件动态 |

**差距**：Codex 的 apply_patch 单通道（审计友好）与 tool_search 延迟加载（大工具集管理）值得借鉴；Hermes 的 delegate_task output_schema 有界纠错比 WxNodus /delegate 精细。

### 2.5 模型与 Provider

| 能力 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 多 provider | ❌ 仅 Anthropic | ✅ 6 provider | ✅ 7 adapter | ✅ 4 内置+自定义 | ✅ 3 家 10 模型 |
| 能力元数据 | 模型目录（内部） | ✅ ModelCapability 门控 | ✅ model_catalog | ✅ **远端刷新的 models.json（per-model 能力）** | ✅ capabilities（🧠/👁/窗口） |
| 推理控制 | ✅ /effort+ultrathink | ✅ thinking 模式 | ✅ reasoning | ✅ effort/summary/verbosity | ✅ /thinking+reasoning.delta 流式 |
| 重试策略 | 内置 | ✅ tenacity 指数退避+分类 | ✅ | ✅ 4/5 次双层重试+idle 超时 | ✅ 4xx 不重试+失败计数 |
| 提示缓存 | ✅ 原生 | ✅ session_id 作 cache_key+/btw 复用 | ✅ | ✅ | ⚠️ 未显式优化（依赖 provider） |

**差距**：WxNodus 无显式提示缓存策略（Kimi 的 /btw 侧问复用是低成本高收益设计）。

### 2.6 生态（Skills/Hooks/MCP/插件）

| 能力 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| Skills 标准 | ✅ SKILL.md（1536 字 desc） | ✅ **跨品牌读 ~/.claude/skills** | ✅ agentskills.io | ✅ SKILL.md+隐式调用+@skill | ✅ SKILL.md（三级发现） |
| 技能注入方式 | 目录+插件+内置 | 清单注入 system prompt | skills_hub 市场 | 隐式检测+显式提及 | ✅ skill_load 工具+目录注入 |
| Hooks 事件数 | ✅ **13+（if 条件/asyncRewake/HTTP/prompt 型）** | ✅ 13 类 | ✅ HOOK.yaml 目录即插即用 | ✅ 11 类 | ⚠️ 4 类（userPromptSubmit/preToolUse/postToolUse/stop） |
| Hooks 拦截语义 | ✅ permissionDecision 四态+defer | ✅ block 结果 | ✅ allow/deny/rewrite 决策型 | ✅ tool 前后 matcher | ✅ preToolUse DENY 拦截 |
| MCP 客户端 | ✅ 4 传输+OAuth+serve 反向 | ✅ fastmcp+OAuth | ✅ 339KB 单文件+热重载 | ✅ rmcp 双向+延迟加载 | ✅ stdio+热重载（/reload-mcp） |
| 插件系统 | ✅ 市场+archive+SHA-256 | ✅ plugin.json+凭证注入 | ✅ plugins.manage | ✅ marketplaces | ✅ plugin.json+ESM 热重载 |
| 主题/皮肤 | ✅ /theme | ✅ rich 主题 | ✅ **skin YAML 跨端推送** | ⚠️ 有限 | ✅ 多主题 |

**差距**：WxNodus Hooks 只有 4 类事件（无 PostToolUseFailure/PreCompact/SessionStart/SessionEnd/SubagentStart/SubagentStop/Notification/SubagentStop），是生态最大缺口——**建议扩到 Claude Code 的 13 类语义**（实现成本低，机制已存在）。

### 2.7 UI 与交互

| 能力 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 渲染器 | 闭源 TUI（alt-screen/内联） | prompt-toolkit+rich | React+Ink | ratatui（推测） | **自研 Ink（React reconciler+yoga+行级差分+DECSTBM）** |
| 流式交互 | ✅ 输入排队 | ✅ 排队+Ctrl-S steer | ✅ 排队+/queue | ✅ | ✅ 排队+steer 注入 |
| 图片粘贴 | ✅ [Image #N] | ✅ Ctrl-V 折叠+图片 | ✅ clipboard.paste+detect_drop | ✅ -i 附加 | ✅ clipboard.paste+image.attach+多模态 |
| HUD | statusLine | 状态栏徽章（YOLO/AFK/Plan） | ✅ **system.battery+statusbar/indicator/focus** | bottom_pane | ✅ ⚡电池+状态条+context% |
| 主题协议化 | ❌ | ❌ | ✅ skin 事件跨端 | ❌ | ⚠️ 主题本地 |
| 快捷键 | ✅ vim/emacs | ✅ 全键盘 | ✅ | ✅ **可编程 keymap（10 context+chord）** | ⚠️ 基础键位 |

**差距**：Codex 的可编程 keymap 与 Hermes 的皮肤协议化是 UI 工程差距；WxNodus 的零依赖自研渲染器在「不依赖 Ink 生态」上反而是独有优势。

### 2.8 输出协议与非交互

| 能力 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 单发模式 | ✅ -p | ✅ --print | ✅ -z oneshot | ✅ exec | ✅ -p |
| JSON 输出 | ✅ stream-json（init/system/assistant/result/control_request） | ✅ stream-json 双向 | ⚠️ 会话导出 | ✅ **JSONL 全事件（item 级 started/updated/completed）** | ✅ --json（AgentResult） |
| 事件流 | ✅ stream-json | ✅ Wire 1.10（JSON-RPC 全事件） | ✅ SSE/API | ✅ JSONL | ✅ --wire（7 类事件 JSONL） |
| 退出码语义 | ⚠️ 无特殊 | ✅ **0/1/75（EX_TEMPFAIL 可重试）** | ⚠️ | ⚠️ | ⚠️ 无特殊退出码 |
| 结构化输出 | ✅ --json-schema | ⚠️ | ⚠️ | ✅ --output-schema | ⚠️ |
| 双向协议 | ✅ SDK（TS/Python） | ✅ Wire 请求（approval/tool/question/hook 全托管） | ✅ ACP+SSE | ✅ app-server v2+SDK | ✅ ACP/A2A/HTTP gateway/--wire |

**差距**：Kimi 的退出码 75 与 Wire 双向托管、Codex 的 item 级事件流值得学。WxNodus 的 --wire 只读事件流（无客户端请求通道），可扩展为双向（Hermes/Kimi 已证明价值）。

### 2.9 协作与委派

| 能力 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 并行子代理 | ✅ 默认后台+20 并发上限 | ✅ | ✅ **delegate_task fan-out** | ✅ 多智能体 v1/v2 | ✅ /swarm 1-8 |
| 委派树持久化 | ⚠️ | ⚠️ | ✅ **spawn-trees JSON+索引+/replay-diff** | ⚠️ | ✅ spawn_tree save/list/load+/replay |
| 双脑对比 | ❌ | ❌ | ⚠️ | ❌ | ✅ /duo |
| 目标循环 | ⚠️ 无（max-turns） | ✅ **Ralph 循环（<choice>STOP</choice>）** | ✅ /goal /subgoal | ✅ thread_goals | ✅ goal 模式（[GOAL_DONE]） |
| 后台任务看板 | ✅ Task* 工具 | ✅ 三栏任务浏览器 | ✅ | ✅ | ✅ /task |

**差距**：WxNodus 的 /swarm 无 output_schema 有界纠错（Hermes）；goal 模式单循环 vs Kimi Ralph 的三层嵌套（step/Ralph/Flow）——**Flow skills（SKILL.md 内嵌 mermaid 流程图驱动）是 Kimi 独有的可移植亮点**。

### 2.10 安全模型汇总

| 维度 | Claude Code | Kimi | Hermes | Codex | WxNodus V3 |
|---|---|---|---|---|---|
| 密钥加密 | keychain（macOS） | SecretStr+credentials 文件 | redact.py 脱敏引擎 | auth.json（file/keyring） | **AES-256-GCM+机器指纹** |
| 环境净化 | ✅ SUBPROCESS_ENV_SCRUB | ✅ get_noninteractive_env | ✅ | ✅ shell_environment_policy | ⚠️ 无显式子进程 env 白名单 |
| SSRF 防护 | ✅ | ✅ | ✅ url_safety | ✅ | ✅ http_get/claw 内网拦截 |
| 审批回显脱敏 | ✅ | ⚠️ | ✅ **_redact_approval_command** | ✅ | ⚠️ 无（审批面板显示命令原文） |
| 敏感数据生命周期 | ⚠️ | ⚠️ | ✅ secret.request+expire | ✅ env 白名单 | ✅ **/security 关闭即清（用户强制红线）** |

---

## 3. WxNodus V3 差距清单（按可执行性排序）

### 差距状态总览（2026-08 更新）
| 编号 | 差距 | 优先级 | 状态 |
|---|---|---|---|
| 1 | 危险命令检测升级（wrapper 解包/operand 变体） | P0 | ✅ 已实施（unwrapCommand 深度 8 + OPERAND_AFTER_FLAG） |
| 2 | 持久化审批规则文件（/perm rule） | P0 | ✅ 已实施（data/permissions.json，deny>allow>ask） |
| 3 | 子进程环境净化（剥离密钥变量） | P0 | ✅ 已实施（sanitizedEnv 白名单） |
| 4 | Hooks 扩充到 12 类 | P1 | ✅ 已实施（含 preCompact BLOCK/notification/subagent 生命周期） |
| 5 | 审批回显脱敏 | P1 | ⚠️ 部分（notice 留痕已有；approval 面板脱敏未做） |
| 6 | 退出码协议（0/1/75） | P1 | ✅ 已实施（exitCodeForError） |
| 7 | --wire 双向化 | P1 | ✅ 已实施（stdin 请求帧 → gateway RPC 双向） |
| 8 | Flow skills | P2 | ✅ 已实施（flow frontmatter + /flow + flow_runs 表） |
| 9 | 工具延迟加载 | P2 | ✅ 已实施（tool_search 检索 + 动态激活） |
| 10 | 会话导出 jsonl | P2 | ✅ 已实施（/export --jsonl 完整会话审计导出） |
| 11 | 错误码体系（4xxx/5xxx） | P1 | ✅ 已实施（WxError + RPC {ok,code,message}） |
| 12 | 配置分层与校验 | P2 | ✅ 已实施（SETTINGS_KEYS schema + unknownSettingsKeys） |

**P3 增量（2026-08 网络调研后新增，两轮）：** 仓库地图（repo_map//map，含引用权重排序）、项目级 .mcp.json + strictMcpConfig + --strict-mcp-config 标志、权限规则 reason 字段、跨品牌技能发现（.claude/.agents/.codex/.gemini）、/rewind 快照回滚、/reload-skills、第五门测试门、生态规范文件链（AGENTS/CLAUDE/GEMINI/.cursorrules 等）、会话 token 预算（budgetTokens + --json usage stats）、MCP startupTimeoutMs。

**剩余未实施：** 审批面板脱敏（notice 留痕已有）、平台级沙箱（四平台 Seatbelt/bwrap/受限令牌——需系统级能力，长期项）。

**2026-08 全面审计（三 agent 并行：抄袭/底座/功能矩阵）修正记录：**
1. @wxnodus/ink 渲染器血缘：审计发现其为 ink(MIT) 的派生 fork（组件 API 骨架继承 + 渲染管线自研重写），
   但此前 README 表述为「完全自研」且未附 LICENSE——已补 packages/wxnodus-ink/LICENSE（保留原作者版权）+
   package.json license 字段 + README 表述修正为「fork + 自研扩展」。
2. --cwd/--session 非交互语义夸大：审计实测此前仅解析未生效——已修复（process.chdir + agent.setSessionId）。
3. sanitizedEnv 覆盖夸大：审计实测 hooks/MCP 子进程此前继承全量环境——已抽 src/kernel/env.ts 统一净化三处。
4. computer use 浏览器域（playwright-core CDP）：头注释宣称未实现——已如实标注为桌面域先行。
5. 其余自述（12 类 hooks/规则文件/退出码/--wire 双向/Flow skills/延迟加载/五门/错误码）均经代码验证为真。

## 4. WxNodus V3 的独有领先点（对比中确认）

| 领先点 | 依据 |
|---|---|
| **离线向量记忆** | 唯一本地 embedding（transformers.js 384 维）混合召回；其余四家均无向量检索 |
| **数据不出机** | 密钥 AES-256-GCM 本地、SQLite 单库、无遥测（Claude/Kimi 默认有遥测） |
| **概念编译器** | 一句话→可运行系统+证据链+四门质量门，四家均无对应物 |
| **合规五项** | 深度合成标注/审计链/许可证扫描——国内合规场景独有 |
| **中文 NL 意图路由** | 四层路由（别名→确定性→NL→AI）+ 86 命令中文别名 |
| **多模态历史回显** | 图片摘要入历史（GLM-4V 本地化），后续轮次可回忆 |
| **零依赖自研渲染器** | React reconciler 自研，不依赖第三方 TUI 生态 |
| **智能三件套** | 结构化系统提示（此前无系统提示）+ 模型降级链（429/5xx 自动降级）+ AI 审批预审（allow/deny/ask）——对比基线后新增 |
| **全栈自研** | 参数解析/模糊匹配/状态引擎/渲染器/核心机制全自研，纯逻辑零第三方（依赖 34→21） |
| **上下文工程三件套** | 仓库地图（aider repo-map 自研版）/AGENTS.md 生成（/init）/黑洞记忆——对齐 aider/Gemini 上下文管理 |

## 5. 结论

- **功能广度**：WxNodus V3 与四家同代（86 命令 vs Claude 42 工具/95 命令 vs Kimi 40+ vs Hermes 95+42 vs Codex 30+ 子命令），且协作（/swarm /duo /goal /jobs /cron）与协议（ACP/A2A/gateway/webhook/wire）覆盖处于第一梯队；455+ 测试（33 文件）为自身最大回归网。
- **安全深度（更新）**：P0 三项（危险检测升级/规则文件/环境净化）已实施；剩余平台级差距为「四平台沙箱」（Codex Seatbelt/bwrap/受限令牌）与「凭据掩码」（Claude bubblewrap MITM）——需要系统级能力，属长期项。
- **生态标准（更新）**：Hooks 12 类已对齐 Claude 事件面；skills 跨品牌发现（.claude/.agents/.codex/.gemini/skills，agentskills.io 生态对齐 Cursor CLI）已实施；项目级 .mcp.json（mcpServers 对象格式 + strict 模式）对齐 Claude Code 生态标准。
- **智能度（新增维度）**：结构化系统提示 + 模型降级链 + AI 预审 + 22 条意图路由——超越旧版自身，对齐市场 CLI 智能处理水平。
- **工程规模**：194 文件/38.4k 行 vs 对手 6k-8k 文件——以 1/30 规模实现同代功能 + 纯逻辑零第三方依赖；单文件拆分（wxGateway.ts 1224 行）为持续关注项。
