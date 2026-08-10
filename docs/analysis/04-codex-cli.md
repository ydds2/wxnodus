# OpenAI Codex CLI 全量构造 + 代码设计分析

> 分析对象：GitHub `openai/codex`（默认分支 `main`）
> 分析方式：GitHub REST API（repo 元信息 / recursive git tree）+ `raw.githubusercontent.com` 源码精读 + 仓库 docs/（2026-05 前完整版）+ CHANGELOG 交叉核对
> 数据日期：2026-08-09（pushed_at 2026-08-10）
> 说明：`developers.openai.com` 官方文档站对自动化抓取返回 403，文中引用的 docs 内容取自仓库 `docs/` 目录在 2026-05-03 被"移除本地文档"（commit `67849d950d84`）之前的完整版本（commit `2d9ee9dbe90b` / `e0d7ac51d30d` 等），其余以源码为准；个别无法从源码确认处标注【待验证】。

---

## 1. 定位与架构总览

### 1.1 仓库基本盘（GitHub API 实测）

| 项 | 值 |
|---|---|
| full_name | openai/codex |
| description | Lightweight coding agent that runs in your terminal |
| language | **Rust**（`codex-rs/` 6393 个文件）+ TypeScript/JS（`sdk/`、`codex-cli/` npm 包装）+ Starlark（bazel） |
| license | Apache-2.0 |
| default_branch | main |
| size | 547,973 KB（≈548 MB，含 vendored 依赖，如 v8、bazel 缓存产物） |
| 文件规模 | 6097 blobs / 833 dirs（recursive tree 未截断） |
| 创建 | 2025-04-13 |
| stars / forks / open issues | ~105k / ~15.9k / ~12.2k（抓取时点） |
| 构建系统 | **Bazel**（`MODULE.bazel`、`BUILD.bazel`、`defs.bzl`、`rbe.bzl`、`.bazelversion`）+ 每个 crate 保留 Cargo.toml；另有 `flake.nix`、`justfile`、`pnpm-workspace.yaml` |

### 1.2 顶层目录职责

- `codex-rs/` — Rust 主体（约 90 个 crate）
- `codex-cli/` — npm 包装（`bin/codex.js`、`build_npm_package.py`），用于 `npm i -g @openai/codex`
- `sdk/` — TypeScript SDK + Python SDK + Python runtime（供 IDE 扩展/桌面端编程调用）
- `docs/` — 已退化为指向 developers.openai.com 的 stub（2026-05-03 起）
- `.codex/` — OpenAI 自己 dogfooding 的配置：`skills/`（codex-bug、code-review 等 14 个 SKILL.md 技能）、`environments/environment.toml`
- `.github/`、`scripts/`、`tools/`、`third_party/`、`patches/` — CI 与工具链

### 1.3 Rust crate 分层（核心 → 外围）

**入口层**
- `codex-rs/cli` — 主二进制 `codex`：子命令分发（exec/review/login/mcp/plugin/app-server/doctor/sandbox/execpolicy/resume/fork/...）、`main.rs`(4511 行)、`doctor/`、`mcp_cmd/`、`plugin_cmd/`、`app_cmd/`、`debug_sandbox/`
- `codex-rs/exec` — 非交互二进制 `codex exec`：`cli.rs`（clap 定义）、`event_processor*.rs`（human/jsonl 两种输出）、`exec_events.rs`（JSONL 事件模型）、`tests/suite/`（approval_policy、resume、sandbox、output_schema、ephemeral、hooks…）

**领域核心**
- `codex-rs/core` — 最大单体：agent 循环（`session/`、`codex_thread.rs`、`thread_manager.rs`）、工具 handlers（`tools/handlers/`）、审批决策（`exec_policy.rs`）、补丁安全（`safety.rs`）、压缩（`compact.rs`、`compact_token_budget.rs`）、MCP（`mcp.rs`）、skills（`skills.rs`）、hooks（`hook_runtime.rs`）、上下文组装（`context/`、`context/world_state/`）、web_search、多智能体（`agent/`、`tools/handlers/multi_agents*.rs`）、realtime 语音
- `codex-rs/tui` — 交互 TUI：`app/`（会话生命周期、历史分页、事件分发）、`chatwidget/`、`bottom_pane/`（composer、approval overlay、command popup、file search）、`keymap/`（10 种 keymap context）、`history_cell/`（消息渲染快照测试）
- `codex-rs/protocol` — 共享类型层：`ToolName`、`SessionMeta`、`AskForApproval`、`approvals.rs`（审批事件）、`items.rs`、`permissions.rs`、`models.rs`（PermissionProfile/ResponseItem）、`exec_output.rs`、`parse_command.rs`、`thread_id.rs`、`session_id.rs`
- `codex-rs/config` — `config.toml` schema（`config_toml.rs` 1059 行全字段）、配置分层加载（`loader/`：system/cloud/user/profile/cwd/tree/repo）、`permissions_toml.rs`、`mcp_types.rs`、`hook_config.rs`、`tui_keymap.rs`、`requirements_layers/`（enterprise 约束）、`strict_config.rs`

**执行与安全**
- `codex-rs/execpolicy` — Starlark 风格规则引擎（`prefix_rule`）+ CLI `codex execpolicy check`
- `codex-rs/shell-command` — bash/PowerShell 解析（`bash.rs`、`powershell.rs`）、命令安全分类（`command_safety/is_dangerous_command.rs`、`is_safe_command.rs`、windows 变体）
- `codex-rs/sandboxing` — 跨平台沙箱编排（`manager.rs`：SandboxType 选择、`landlock.rs`、`bwrap.rs`、`seatbelt.rs`、`windows.rs`）
- `codex-rs/linux-sandbox` — Linux 沙箱 helper 二进制（bubblewrap + seccomp + legacy landlock + 代理路由）
- `codex-rs/windows-sandbox-rs` — Windows 受限令牌沙箱（restricted token + ACL + WFP 防火墙 + elevated 后端 + conpty）
- `codex-rs/process-hardening`、`codex-rs/shell-escalation`、`codex-rs/bwrap`

**持久化**
- `codex-rs/rollout` — 会话 JSONL 录制（`recorder.rs`）、冷数据 zstd 压缩（`compression.rs`）、会话索引（`session_index.rs`）、`reverse_jsonl_scanner.rs`
- `codex-rs/state` — SQLite：`threads`/logs/memories/goals/queue/thread_history 六库 + 47 个迁移（`migrations/0001..0047`）
- `codex-rs/thread-store` — 线程 CRUD/搜索/历史物化/分叉（`local/`：`thread_history.rs`、`search_threads.rs`、`rollout_migration/`）
- `codex-rs/message-history`、`codex-rs/agent-graph-store`、`codex-rs/thread-manager-sample`、`codex-rs/history`

**模型与集成**
- `codex-rs/model-provider`（客户端）、`model-provider-info`（`ModelProviderInfo` schema）、`models-manager`（`models.json` 打包目录 + 远端目录刷新）
- `codex-rs/login` — OAuth 登录（PKCE/设备码/本地回调服务器）、`auth/storage.rs`（auth.json）、`keyring-store`
- `codex-rs/chatgpt` — ChatGPT 云端 agent 客户端（apply_command、get_task）
- `codex-rs/mcp-server`（把 codex 自身暴露为 MCP server）、`rmcp-client`（官方 Rust MCP SDK 封装）、`codex-mcp`（MCP 工具元数据/过滤/命名）
- `codex-rs/app-server` + `app-server-protocol`（v2 协议：thread/turn/config/mcp/plugin/fs/review/realtime/remote_control）+ `app-server-daemon` + `app-server-transport` — 桌面/IDE 集成层
- `codex-rs/exec-server` — 远端执行环境服务（NOISE 加密中继、远端文件系统/进程、`environments`）
- `codex-rs/codex-api`、`codex-backend-openai-models`、`codex-client` — OpenAI 后端 API 客户端（模型目录、cloud config bundle）
- `codex-rs/ext/`（extension-api、agent、connectors）、`core-plugins`（插件/marketplace 管理）、`skills`/`skills-extension`、`prompts`（模板）、`features`（feature flag 注册表）、`otel`、`analytics`、`apply-patch`（92 个文件，完整独立子工程）

---

## 2. 全量功能清单（按类别穷尽）

### 2.1 CLI 顶层子命令（`codex-rs/cli/src/main.rs`）

| 子命令 | 说明 |
|---|---|
| `codex`（无参数） | 交互模式（TUI） |
| `codex exec [PROMPT]` | 非交互执行（见 2.4） |
| `codex review` | 非交互代码评审（`--uncommitted` / `--base BRANCH` / `--commit SHA [--title]`，互斥） |
| `codex login / logout / login status` | ChatGPT 账号 OAuth 或 API key 登录；`--api-key`、`--with-access-token`、`--device-auth`、`--experimental_issuer/--experimental_client-id` |
| `codex mcp` | MCP 管理：`add/get/list/remove/login/logout`（list/get 支持 `--json`） |
| `codex plugins` | 插件管理（`plugin_cmd.rs`：add/remove/list 等） |
| `codex mcp-server` | 以 stdio MCP server 模式运行 codex（对外暴露为 MCP 工具） |
| `codex app-server` | 实验：桌面/IDE 后台服务（daemon bootstrap/start/restart/stop/version、`--remote-control`、`--listen stdio://|unix://|ws://IP:PORT|off`、generate-ts / generate-json-schema） |
| `codex app` | 启动桌面 App（`desktop_app/mac.rs`、`windows.rs`） |
| `codex sandbox {linux\|macos}` | 在沙箱内跑命令做实验（`--full-auto`），legacy 别名 `codex debug seatbelt/landlock` |
| `codex execpolicy check` | 规则预演（见 2.3） |
| `codex doctor` | 环境/运行时/git/线程清单/更新检查 |
| `codex resume [ID\|name] [--last] [--all] [--include-non-interactive] [PROMPT]` | 恢复会话（picker 或 `--last` 直达） |
| `codex fork` / `codex archive` / `codex unarchive` / `codex delete`（`--force`） | 会话分叉/归档/恢复/删除 |
| `codex inspect` / `codex migrate` | 检视/迁移旧版本地会话到分页线程历史 |
| `codex completions` / `codex update` | shell 补全 / 自更新 |
| `codex cloud-task` | 实验：浏览 Codex Cloud 任务并在本地应用改动 |
| `codex debug` | `debug models`（模型目录 JSON）、`debug prompt`、`debug app-server`、`debug replay-trace`、`debug clear-memories` |
| `codex features` | 检视 feature flags |
| 内部：`responses-proxy`、`stdio-to-uds`、`exec-server`、`logs-client` | 内部/实验工具 |

**共享 flags（`codex-rs/utils/cli/src/shared_options.rs`，交互与 exec 共用）**

```
-i, --image FILE[,FILE...]        附加图片到首条 prompt
-m, --model MODEL                 模型
    --oss                         使用开源 provider
    --local-provider {lmstudio|ollama}
-p, --profile NAME                叠加 $CODEX_HOME/<name>.config.toml
-s, --sandbox {read-only|workspace-write|danger-full-access}
    --approve-for-me (alias --not-so-yolo)   审批走自动评审（auto-review）代理
    --dangerously-bypass-approvals-and-sandbox (alias --yolo)
    --dangerously-bypass-hook-trust
-C, --cd DIR                      工作根目录
    --add-dir DIR                  额外可写目录（可重复）
-c, --config key=value            通用 TOML 覆盖（key 可带点，如 model_providers.x.base_url）
```
`--full-auto` 出现在 2025-10 版 docs（等价 `--sandbox workspace-write` + on-request）；当前 `shared_options.rs` 已无该 flag，疑似被 `--approve-for-me`/`-s`+`-c` 组合取代【待验证】。

### 2.2 模式（mode）

- **交互模式（默认）**：TUI 对话，多轮、审批弹窗、斜杠命令。
- **非交互 exec 模式**：`codex exec "PROMPT"`，无审批弹窗，默认 read-only 沙箱。
- **评审模式**：`codex exec review` / `codex review`，基于 rubric 提示词（`codex-rs/prompts/templates/review/rubric.md`、`review_request.rs`、`review_exit.rs`）。
- **plan/auto 模式**：源码中体现为 `update_plan` 工具 + `model_reasoning_effort`/`plan_mode_reasoning_effort` 配置；协作模式 `CollaborationMode`（协议层另有 `collaboration_mode_presets.rs`）。早期版本"plan mode 默认用低推理模型"的机制当前版本未在 config_toml 顶层见到独立 `plan_mode` 开关（有 `plan_mode_reasoning_effort`），【部分待验证】。
- **自动评审（auto-review）**：`--approve-for-me` → `approvals_reviewer="auto_review"` + `approval_policy="on-request"` + `sandbox_mode="workspace-write"`（`shared_options.rs::take_auto_review_config_overrides`），由 `auto_review_denials.rs`、`GuardianAssessmentEvent`（`protocol/approvals.rs`）实现"守护者"风险分级。
- **多智能体（collaboration / multi-agent）**：`spawn_agent/wait_agent/close_agent/send_input/resume_agent`（v1）与 `spawn/wait/interrupt_agent/list_agents/send_message/message_tool/followup_task`（v2，`tools/handlers/multi_agents_v2/`）；`[agents]` 配置（角色、`max_concurrent_threads_per_session`、默认子模型、nickname）。
- **realtime 语音模式**：`[realtime]` 配置（WebSocket/WebRTC、voice、`experimental_realtime_ws_model` 等），`core/src/realtime_*.rs`。

### 2.3 审批策略（approval policy + execpolicy 规则）

**approval_policy 取值（`codex-rs/protocol/src/protocol.rs:916` AskForApproval）**

| 值 | 语义 |
|---|---|
| `untrusted` | 只自动放行"已知安全"的只读命令（`is_safe_command()` 白名单），其余一律问人 |
| `on-request`（默认；alias `on-failure`） | 模型自行决定何时请求升级权限；命令在沙箱内失败时可再问是否在沙箱外重试 |
| `granular` | 细粒度开关：`sandbox_approval`、`rules`、`skill_approval`、`request_permissions`、`mcp_elicitations`（`GranularApprovalConfig`，`protocol.rs:943`），关掉的类别直接拒绝（不弹窗） |
| `never` | 永不询问；失败直接返回模型（exec 非交互默认即此） |

**execpolicy 规则文件（`codex-rs/execpolicy/`）**

- 语法：Starlark 风格
  ```starlark
  prefix_rule(
      pattern = ["git", ["push", "fetch"]],   # 有序 token，列表=候选项
      decision = "prompt",                     # allow | prompt | forbidden，默认 allow
      justification = "why this rule exists",  # 可选，禁止类规则建议写替代命令
      match = [["git","push","origin","main"]],    # 加载时校验"必须命中"（单测）
      not_match = [["git","status"]],              # 加载时校验"必须不命中"
  )
  host_executable(name = "git", paths = ["/opt/homebrew/bin/git", "/usr/bin/git"])
  ```
- 文件位置：`$CODEX_HOME/rules/*.rules`（常量 `RULES_DIR_NAME="rules"`、`RULE_EXTENSION="rules"`、`DEFAULT_POLICY_FILE="default.rules"`，`codex-rs/core/src/exec_policy.rs`）；启动时加载全部 `.rules`。
- 决策聚合：**取最严** `forbidden > prompt > allow`（`policy.rs::Evaluation::from_matches`，`Decision` 带 Ord）。
- 匹配语义：先精确首 token；`resolve_host_executables=true` 时允许绝对路径回退到 basename 规则（受 `host_executable()` 白名单约束）；无规则命中时走"未匹配命令启发式"（见 5.2）。
- 网络规则：`network_rule`（host、protocol: http/https/socks5_tcp/socks5_udp、decision、justification），编译为 allow/deny 域列表（`compiled_network_domains`）。
- 工具：`codex execpolicy check --rules a.rules [--rules b.rules] [--resolve-host-executables] [--pretty] CMD...`，输出 JSON `{"matchedRules":[{...}],"decision":"allow|prompt|forbidden"}`；无命中时 `{"matchedRules":[]}`。
- 审批记忆（缓存）机制：
  - **一次性放行**：`Accept`（只本次）；
  - **本次会话放行**：`AcceptForSession`（`CommandExecutionApprovalDecision`，`app-server-protocol`）；
  - **永久记住**：`AcceptWithExecpolicyAmendment` → `append_amendment_and_update()` 把 `prefix_rule(pattern=[...], decision="allow")` **写回 `~/.codex/rules/default.rules`** 并热更新内存 Policy（`exec_policy.rs:439`、`amend.rs`）；网络同理 `ApplyNetworkPolicyAmendment`。
  - 模型侧差异：`AllowPrefixRules::{Honor,Ignore}` —— 对"cyber 模型"或复杂解析（heredoc 等）场景禁止自动生成 amendment（`exec_policy.rs` auto_amendment_allowed 逻辑）。
  - 会话内命中 allow 规则的命令可**绕过沙箱**（`bypass_sandbox: commands.iter().all(|c| 有显式 allow 规则)`，`exec_policy.rs:420`）。

### 2.4 非交互 exec（`codex-rs/exec/`）

**flags**（`exec/src/cli.rs`）：`--json`（alias `--experimental-json`）、`-o/--output-last-message FILE`、`--output-schema FILE`（JSON Schema 结构化输出）、`--ephemeral`（不落盘）、`--skip-git-repo-check`、`--ignore-user-config`、`--ignore-rules`、`--strict-config`、`--color {always|never|auto}`、`-i/--image`；PROMPT 支持 stdin（`-` 或管道）。
**子命令**：`exec resume [SESSION_ID|--last] [--all] [-i] [PROMPT]`、`exec fork SESSION_ID [-i] [PROMPT]`、`exec review`。
**输出**：默认 stderr 流式进度、stdout 只写最终消息（可管道）；`--json` 输出 JSONL 事件（见 4.4）；`-o` 写最终消息到文件；`--output-schema` 时最终消息为 JSON。
**默认**：无审批（never）、read-only 沙箱、需要 git 仓库。

### 2.5 会话（session）与恢复

- 存储：`~/.codex/sessions/rollout-<yyyy-mm-ddThh-mm-ss>-<uuid>.jsonl`（首行 `SessionMetaLine`，之后逐行 item；冷数据压缩为 `.jsonl.zst`，追加时自动物化，`rollout/compression.rs`）；归档到 `sessions/archived_sessions/`。
- SQLite 索引：`state_5.sqlite`（`threads` 表：id/rollout_path/created_at/source/model_provider/cwd/title/sandbox_policy/approval_mode/tokens_used/git_sha/…，`state/migrations/0001_threads.sql`）、`thread_history_1.sqlite`（分页历史物化）、`logs_2.sqlite`、`memories_1.sqlite`、`goals_1.sqlite`、`queue_1.sqlite`。
- 恢复方式：交互 `codex resume`（picker；`--last` 直达最近会话；`--all` 跨 cwd；`--include-non-interactive`）、`codex fork`；非交互 `codex exec resume --last`；退出时打印提示 `To continue this session, run codex resume <name|id>`（`utils/cli/resume_command.rs`）。
- `--ephemeral`：不写任何会话文件。
- 会话元数据（`protocol/protocol.rs:2855 SessionMeta`）：session_id、id、forked_from_id、parent_thread_id、timestamp、cwd、originator、cli_version、source、thread_source、agent_nickname、agent_role、agent_path、model_provider、base_instructions、git 信息等。

### 2.6 上下文管理

- token 预算：`model_context_window`、`model_max_output_tokens`、`model_auto_compact_token_limit`（+`_scope`）、`rollout_budget`、`token_budget_context.rs`。
- 压缩（`core/src/compact*.rs`）：模型摘要压缩（`prompts/templates/compact/` 的 `SUMMARIZATION_PROMPT`/`SUMMARY_PREFIX`）、token 预算压缩（开新 context window，`compact_token_budget.rs`）、远端压缩（`compact_remote*.rs`，云侧）；自动压缩窗口 `AutoCompactWindowIds`（可恢复）；`COMPACT_USER_MESSAGE_MAX_TOKENS=20000`；compaction 前后 hooks（`run_pre/post_compact_hooks`）；压缩以 `ContextCompactionItem` turn item 呈现。
- 上下文渲染：`context/world_state/`（按 section diff 渲染：tools、permissions、environment、agents_md、collaboration_mode、context_window_guidance…），只把变化部分注入下一条消息。
- AGENTS.md：自动发现（`agents_md_manager.rs`），`project_doc_max_bytes`（默认 32 KiB）、`project_doc_fallback_filenames`（如 CLAUDE.md）。
- 工作目录：`--cd/-C`、`--add-dir`；沙箱写根含 cwd + $TMPDIR + /tmp（可排除）。
- 工具：`get_context_remaining`、`new_context`、`compact`（TUI 命令）。

### 2.7 工具全表（`codex-rs/core/src/tools/handlers/`，2026-08 版本）

| 工具名（ToolName） | 签名要点 | 用途 |
|---|---|---|
| `shell_command` | `{command: string, cwd?}`（bash -lc 风格） | 跑 shell 命令（走沙箱+审批） |
| `exec_command` | 结构化：`{command, args, cwd, env?, timeout_ms?, background?}` | 新版统一 exec 工具（`experimental_use_unified_exec_tool` 特性；`unified_exec/`） |
| `write_stdin` | `{process_id, data}` | 向后台 exec 进程写 stdin（`unified_exec/exec_command.rs`） |
| `apply_patch` | freeform 文本 diff（lark 语法 `tools/handlers/apply_patch.lark`；`*** Begin Patch` 格式） | 唯一改文件通道（`core/src/apply_patch.rs` + `apply-patch` crate + `prompts/apply_patch_tool_instructions.md`） |
| `update_plan` | `{plan: [{description, status}]}` | 待办清单（`plan.rs`、`protocol/plan_tool.rs`；TodoListItem） |
| `request_permissions` | `{permissions}`（fs/network/command 三类） | 主动申请升级权限 |
| `request_user_input` | `{question, options?}` | 向用户提问（`[tools] experimental_request_user_input` 开关） |
| `request_plugin_install` / `list_available_plugins_to_install` | `{plugin_id, reason}` | 模型提议安装插件/连接器（含 approval kind 元数据） |
| `tool_search` | `{query, limit=8}` | 对"延迟加载"工具做 BM25 检索（`tools/src/tool_search.rs`、`tool_discovery.rs`） |
| `get_context_remaining` / `new_context` | 无参 / `{instructions?}` | 查剩余 token / 主动开新上下文窗口 |
| `spawn_agent` / `wait_agent` / `close_agent` / `send_input` / `resume_agent` | 多智能体 v1（`multi_agents/`） | 派生子代理、等待、收尾、投递输入 |
| `spawn` / `wait` / `interrupt_agent` / `list_agents` / `send_message` / `message_tool` / `followup_task` | 多智能体 v2（`multi_agents_v2/`） | 同上，v2 后端（`agent/`、`agent-graph-store`） |
| `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` | MCP 资源（`mcp_resource/`） | 枚举/读取 MCP 资源（新工具，配合 tool_search） |
| `view_image` | `{path}` | 附加工作区内图片（`[tools] view_image=true` 启用） |
| `web_search`（WebSearch spec） | `{queries}` | 一方 web 搜索（`[tools] web_search=true` 启用；`hosted_spec.rs`、`web_search.rs`） |
| `sleep` | `{duration_ms}` | 等待（后台任务/轮询） |
| `clock.curr_time` | 无参（namespace `clock`） | 当前时间（`handlers/current_time.rs`） |
| `test_sync_tool` | 云端测试同步（`test_sync.rs`） | Codex Cloud 任务回传 |
| MCP 工具（动态） | `mcp__<server>__<tool>`（legacy 前缀）或 namespaced `<server>.<tool>` | 注册的 MCP server 工具；可延迟加载，经 tool_search 暴露 |
| 扩展工具 | extension API 注册（如 `web.run` 独立 web 搜索 namespace、`extension_echo`） | `ext/extension-api` |
| collab 工具（exec 事件层） | spawn_agent/send_input/wait/close_agent | 子代理协作（`CollabTool`，`exec_events.rs`） |

**与早期版本差异**：内置 `bash`/`read`/`write`/`web_fetch`/`repo_map`/`task`/`fetch`/`view_image`(旧版内建) 已被移除或重构 —— 当前文件通道只有 `apply_patch`，命令通道是 `shell_command`/`exec_command`，web 检索靠一方 `web_search` + 扩展工具；`repo_map`/`web_fetch` 在本仓库源码中已无实现（grep 确认）。

### 2.8 模型与 provider

- 内置 provider：`openai`、`amazon-bedrock`、`ollama`（localhost:11434/v1）、`lmstudio`（localhost:1234/v1）（`model-provider-info/src/lib.rs::built_in_model_providers`）。
- `[model_providers.<id>]` 字段：name、base_url、env_key、env_key_instructions、experimental_bearer_token、auth（command 生成 token）、aws（SigV4：profile/region/…）、**wire_api（仅 `responses`；`chat` 已移除，见 `WireApi` 反序列化 `CHAT_WIRE_API_REMOVED_ERROR`）**、query_params、http_headers、env_http_headers、request_max_retries(默认4)、stream_max_retries(默认5)、stream_idle_timeout_ms(默认300000)、websocket_connect_timeout_ms、requires_openai_auth、supports_websockets、supports_standalone_web_search。
- 模型目录：`models-manager/models.json` 打包 + 启动时从后端刷新（`debug models`、`models_endpoint.rs`）；条目含 context_window、auto_compact_token_limit、truncation_policy、tool_mode（`code_mode_only`）、multi_agent_version、reasoning_summary_format、default_reasoning_level、verbosity 等（2026-08 目录已含 gpt-5.6-sol 等）。
- 推理控制：`model_reasoning_effort`（minimal/low/medium/high）、`plan_mode_reasoning_effort`、`model_reasoning_summary`（auto/concise/detailed/none）、`model_verbosity`（low/medium/high）、`model_supports_reasoning_summaries`、`service_tier`、`personality`（none/friendly/pragmatic）。
- 认证：`--oss/--local-provider`、`CODEX_API_KEY`（仅 exec）、`OPENAI_BASE_URL`（覆盖 openai 内置 provider）、`chatgpt_base_url`、`forced_login_method`、`forced_chatgpt_workspace_id`。
- Amazon Bedrock：`[model_providers.amazon-bedrock]`（catalog、auth.command、mantle 代理），`codex login --bedrock-api-key`。

### 2.9 TUI 特性（`codex-rs/tui/`）

- 布局：chatwidget（历史+composer）、bottom_pane（footer 状态行、approval overlay、command popup、file search popup、feedback view、hooks browser、memories settings）、pets（`app/pets.rs`，角落小宠物）、agent picker / agent status feed / agent navigation。
- 历史：分页加载（`history_pagination.rs`、`history_ui.rs`）、`resize_reflow`、安全缓冲（`safety_buffering.rs`，防止内容突变滚动错乱）、transcript 导出（`transcript_export.rs`）。
- 斜杠命令：`/approvals`、`/model`、`/status`、`/compact`、`/resume`、`/exit`、`/help` 等（`bottom_pane/command_popup.rs`、`slash_input.rs`）【具体清单待验证】。
- 快捷键：**完全可配置** keymap，10 个 context（global/chat/composer/editor/vim_normal/vim_operator/vim_text_object/pager/list/approval），`[tui] keymap.<context>.<action>`，支持 F1–F24、两键 chord（`config/src/tui_keymap.rs`、`tui/src/keymap/`）；`/keymap` 交互式设置（`keymap_setup/`）。
- 通知：`[tui] notifications`（终端转义码，agent-turn-complete / approval-requested）；顶层 `notify`（外部程序 + JSON 参数）。
- 主题：通过 config/feature 控制（`experimental_features_view.rs`、`/experimental` 菜单）；未发现完整主题系统【部分待验证】。
- 其他：vim 模式文本编辑、`@` 提及（mentions_v2，@skill/@plugin/@agent）、composer 历史搜索、effort 状态行、`--hide_agent_reasoning`/`show_raw_agent_reasoning`。

### 2.10 MCP

- 配置：`[mcp_servers.<name>]`，支持 stdio（`command`/`args`/`env`/`env_vars`/`cwd`）与 streamable HTTP（`url`/`bearer_token_env_var`/`http_headers`/`env_http_headers`）；`enabled`（默认 true）、`required`（exec 下启动失败即退出）、`startup_timeout_sec`（默认10）、`tool_timeout_sec`（默认60）、`supports_parallel_tool_calls`、`enabled_tools`/`disabled_tools`、`default_tools_approval_mode`、`tools.<name>` 逐工具审批、OAuth（`oauth`/`scopes`/`oauth_resource`，RFC 8707）。
- 客户端：`rmcp-client`（官方 Rust MCP SDK 包装，experimental flag 切换）+ legacy 客户端；工具名净化/去重/命名空间（`codex-mcp/src/tools.rs`，legacy `mcp__` 前缀、sha1 截断防超长）；`openai/fileParams` 本地路径掩码（`mcp_openai_file.rs`）。
- 工具暴露模型：`ToolExposure`（Direct/Deferred/Hidden/CodeModeOnly…，`tools/src/tool_executor.rs`、`spec_plan.rs`），大工具集走"延迟加载 + tool_search 检索"。
- CLI：`codex mcp add/get/list/remove/login/logout`；`codex mcp-server` 反向把 codex 变 MCP server。
- 审批：MCP 工具调用按 server/工具粒度审批（`McpToolCallItem`、`mcp_tool_approval_templates.rs`、elicitation `ElicitationRequest`）。

### 2.11 沙箱（`codex-rs/sandboxing/` + 平台实现）

- 平台后端（`manager.rs::get_platform_sandbox`）：
  - **macOS**：`SandboxType::MacosSeatbelt`，`sandbox-exec` + `seatbelt_base_policy.sbpl` / `seatbelt_network_policy.sbpl` 模板；
  - **Linux**：`SandboxType::LinuxSeccomp`，`codex-linux-sandbox` helper（`linux-sandbox/`：bubblewrap（系统或打包）--ro-bind / --bind 读写根 + 独立网络命名空间 + seccomp 过滤；legacy 路径 `--use-legacy-landlock` 用 Landlock LSM；`--allow-network-for-proxy` 时开独立 netns + 代理路由（`proxy_routing.rs`、`proxy_lifecycle.rs`））；
  - **Windows**：`SandboxType::WindowsRestrictedToken`（实验，`windows-sandbox-rs/`：受限令牌 + 工作区 ACL（`workspace_acl.rs`）+ WFP 防火墙（`wfp.rs`）+ 提权后端（`elevated/`）+ conpty（`conpty/`）+ 沙箱用户（`sandbox_users.rs`）；未启用时强制降级 read-only）。
- 模式（`SandboxMode`）：`read-only`（默认，全盘只读+禁网）、`workspace-write`（cwd+$TMPDIR+/tmp 可写；`[sandbox_workspace_write]`：`writable_roots`、`network_access`(默认false)、`exclude_tmpdir_env_var`、`exclude_slash_tmp`；含 `.git/` 的写根其 `.git/` 目录只读 → `git commit` 需审批）、`danger-full-access`（无沙箱）。
- 环境变量：子进程内 `CODEX_SANDBOX=seatbelt`、`CODEX_SANDBOX_NETWORK_DISABLED=1`（`core/src/spawn.rs`）。
- spawn 加固（`core/src/spawn.rs`）：`cmd.env_clear()+envs()`、非继承变量过滤（`is_non_inheritable_env_var`）、shell 工具 stdin 置 null（防 ripgrep 等读 stdin 挂起）、`kill_on_drop`、Linux `prctl` 父进程死亡信号（SIGTERM 传染子进程树）、detach from tty。
- 违规记录：`violation.rs`（FileSystem/Network 违规事件、`is_likely_sandbox_denied` 判定）。
- 调试：`codex sandbox linux|macos [--full-auto] CMD...`、`codex debug seatbelt/landlock`、`codex doctor`。

### 2.12 日志与审计

- `~/.codex/logs/`（`log_dir` 可配）；`state` 的 `logs_2.sqlite`（log_db，按进程/线程分区+清理迁移）。
- `[otel]`：OpenTelemetry 日志事件（`codex-rs/otel/`），事件目录：`codex.conversation_starts`、`codex.api_request`、`codex.sse_event`、`codex.user_prompt`（默认脱敏）、`codex.tool_decision`（approved/approved_for_session/denied/abort）、`codex.tool_result`；exporter `none`/`otlp-http`/`otlp-grpc`。
- `[analytics]`、`[feedback]`（app-server 场景 opt-in）。
- `codex doctor` 线程清单（`doctor/thread_inventory.rs`）。
- 审计：`state/src/audit.rs`；会话 `rollout` JSONL 可 `jq/fx` 直接查看（`rollout/src/recorder.rs` 头注释）。

### 2.13 其他功能

- **hooks**（`[hooks]`、`hook_config.rs`）：lifecycle hooks（tool 前后、compact 前后、turn、通知类 11 类事件 matcher）；`--dangerously-bypass-hook-trust`；enterprise `requirements.toml` 里 `allow_managed_hooks_only`（忽略用户/项目/会话 hooks）。
- **skills**：`.codex/skills/**/SKILL.md`（frontmatter：name/description；工作流正文），隐式调用检测（`detect_implicit_skill_invocation_for_command`）+ 显式 `@skill` 提及 + `[skills]` 配置 + 系统技能 `~/.codex/skills/.system`（marker 指纹增量安装）；`codex list-skills`。
- **plugins/marketplaces**：`[plugins]`、`[marketplaces]`（git/npm 源、`marketplace_add/remove/upgrade`）、远端目录（`remote/`）、`tool_suggest`（发现候选插件）。
- **桌面/IDE**：`codex app` 桌面壳；`app-server` daemon（UDS/stdio/ws 传输、remote-control、attestation、`codex app-server generate-ts|json-schema`）；`sdk/typescript` + `sdk/python`；协议 v2（thread/turn/config/mcp/plugin/fs/review/realtime/environment/remote_control…）—— VS Code/Cursor/Windsurf 扩展即基于此。
- **远端执行环境**：`codex exec-server`（NOISE 加密中继、`environment.toml`、capability discovery、远端文件系统/进程、sandboxed_file_system）、`--remote URL --environment-id ID`。
- **Cloud 协同**：`cloud-task`、`chatgpt`（云端 agent）、`remote_control`、`thread_goals`（目标驱动，`state/goals_migrations/`）、`memories`（`[memories]`，`~/.codex/memories`）。
- **密钥/凭据**：`[keyring-store]`（`cli_auth_credentials_store: file|keyring`）、`mcp_oauth_credentials_store`、`mcp_oauth_callback_port/url`、`aws-auth`（Bedrock）。
- **shell 环境策略**：`[shell_environment_policy]`（`inherit: all|core|none`、`ignore_default_excludes`、`exclude`、`set`、`include_only`；默认剔除名含 KEY/SECRET/TOKEN 的变量）。
- **工作区信任**：`projects.<path>.trust_level="trusted"`；`cwd/tree/repo` 层 config 在未信任目录不生效。

---

## 3. 场景覆盖

| 场景 | 用法 | 机制落点 |
|---|---|---|
| 交互编码 | `codex`（信任目录后默认 workspace-write+on-request） | `tui/` + `core/session/` |
| 脚本/管道 | `codex exec "..."`，stdout 仅最终消息；`-o file` | `exec/event_processor_with_human_output.rs` |
| 机器可读输出 | `codex exec --json`（JSONL 流事件）、`--output-schema`（结构化 JSON）、`execpolicy check --pretty` | `exec/exec_events.rs`、`event_processor_with_jsonl_output.rs` |
| CI | `codex exec --sandbox read-only --approval-policy never`（等价默认）+ `--skip-git-repo-check` + `--ephemeral` | exec 默认行为 |
| 沙箱隔离 | `codex sandbox linux/macos` 实验；生产走 `--sandbox` | `sandboxing/` |
| 会话恢复 | `codex resume [id] [--last]`、`exec resume --last`、`--resume` 提示行、`fork` | `rollout/`、`thread-store/` |
| 安全审批流 | `/approvals` 面板、命令审批弹窗、`--approve-for-me` 自动评审 | `tui/bottom_pane/approval_overlay.rs`、`core/exec_policy.rs` |
| 无头自动化（yolo） | `--dangerously-bypass-approvals-and-sandbox`（容器内二次沙箱） | `shared_options.rs` |
| IDE/桌面 | `codex app`、app-server daemon、SDK | `app-server/`、`sdk/` |
| 云端任务 | `codex cloud-task`、exec-server 远端环境 | `chatgpt/`、`exec-server/` |

---

## 4. 代码设计细节（源码路径）

### 4.1 审批决策流（`codex-rs/core/src/exec_policy.rs`）

```
模型发起 shell_command/exec_command 调用
  → commands_for_exec_policy(command)        # bash -lc 降级解析出 argv 列表（exec_policy.rs:844）
  → Policy::check_multiple_with_options(..., resolve_host_executables=true)
       ├─ 精确前缀规则命中 → 取最严 Decision
       └─ 无规则命中 → heuristics_fallback = render_decision_for_unmatched_command()（exec_policy.rs:727）
  → 按 Decision 分派（create_exec_approval_requirement_for_command, :312）：
       Forbidden → ExecApprovalRequirement::Forbidden{reason}（含 dangerous 匹配+建议）
       Prompt    → prompt_is_rejected_by_policy(approval_policy, prompt_is_rule) 判定能否弹窗
                   （Never → 转 Forbidden；Granular 按 rules/sandbox_approval 分流）
                   可弹窗 → NeedsApproval{reason, proposed_execpolicy_amendment}
       Allow     → Skip{bypass_sandbox: 所有子命令都有显式 allow 规则}
  → 用户决策（Accept / AcceptForSession / AcceptWithExecpolicyAmendment / ApplyNetworkPolicyAmendment / Cancel）
  → 持久化：append_amendment_and_update() 写 default.rules + 热更新 ArcSwap<Policy>（信号量互斥）
```
补充：`parse_command.rs::ParsedCommand`（Read/ListFiles/Search/Unknown）用于把命令解析为可读语义；`command_canonicalization.rs` 规范化命令（如 `ls -l` 等价形式）。

### 4.2 会话文件格式（`codex-rs/rollout/`）

- 文件：`~/.codex/sessions/rollout-<ISO日期>-<uuid>.jsonl`，追加写（`recorder.rs::open_rollout_for_append`），首行 `SessionMetaLine`（`SessionMeta` + git），随后每行一个 `ThreadItem`（`protocol/items.rs` 的序列化）。
- 冷数据压缩为 `.jsonl.zst`（`compression.rs`；后台 worker 压缩，追加时物化回明文），`reverse_jsonl_scanner.rs` 支持从尾部反向扫描。
- SQLite 索引（`state/migrations/0001_threads.sql`）+ `thread_history_1.sqlite`（`thread_history_migrations/`）物化"分页历史"，`thread-store/src/local/thread_history/` 提供 segment 分页/turn 定位；旧格式迁移 `rollout_migration/`（canonicalizer/rollback/replay）。
- 恢复=从 rollout 路径重建 `Session`（`thread_manager.rs::resume_thread_from_rollout`），压缩历史可被 `compact_remote` 请求拉回。

### 4.3 工具执行模型（agent loop）

- `core/src/session/session.rs`（Session 状态机）+ `turn_context.rs` + `codex_thread.rs`（`CodexThread::submit()` 双向消息流）+ `thread_manager.rs`（线程生命周期/子代理/分叉）。
- 工具注册表：`core/src/tools/registry.rs`（`ToolRegistry`，trusted/external 注册、碰撞检测、`ToolExposure`）；路由 `tools/router.rs`；并行工具调用 `tools/parallel.rs`；`tools/lifecycle.rs`（pre/post 生命周期，hooks 挂在工具调用上）。
- Responses API 工具声明：`tools/src/responses_api.rs`、`tool_spec.rs::create_tools_json_for_responses_api`；工具调用以 `ResponseItem`/`TurnItem` 事件流回放（`stream_events_utils.rs`）。
- 命令执行 runtime：`tools/runtimes/shell.rs`（+ `unix_escalation.rs`、`zsh_fork_backend.rs`）、`tools/runtimes/apply_patch.rs`、`tools/runtimes/unified_exec.rs`；输出截断 `EXEC_OUTPUT_MAX_BYTES`（`core/src/exec.rs`），shell 工具 `background_terminal_max_timeout`。
- 世界状态渲染：`context/world_state/mod.rs`（环境/权限/工具 namespace/AGENTS.md 等 section，按 diff 注入）。

### 4.4 输出协议 JSON 字段（`codex-rs/exec/src/exec_events.rs`）

顶层事件（`#[serde(tag="type")]`）：
```
thread.started   {thread_id}
turn.started     {}
turn.completed   {usage:{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens}}
turn.failed      {error:{message}}
item.started/updated/completed {item:{id, ...details(flatten, tag "type")}}
error            {message}
```
item details（snake_case type 字段）：`agent_message{text}`、`reasoning{text}`、`command_execution{command,aggregated_output,exit_code,status:in_progress|completed|failed|declined}`、`file_change{changes:[{path,kind:add|delete|update}],status}`、`mcp_tool_call{server,tool,arguments,result{content,_meta,structured_content},error,status}`、`collab_tool_call`、`web_search`、`todo_list`、`error`。
配套：`-o` 输出最终消息（`event_processor.rs::handle_last_message`）、`--output-schema` 走结构化输出（exec tests `output_schema.rs`）。

### 4.5 sandbox 实现路径

- 入口：`core/src/tools/sandboxing.rs`（ExecApprovalRequirement 决定是否进沙箱/升级）→ `sandboxing/src/manager.rs::SandboxManager`（按 `SandboxType` 生成命令包装）→ 平台实现：
  - `seatbelt.rs`（macOS：`sandbox-exec -p profile`，profile 由 `permission_profile` 编译）
  - `landlock.rs`（Linux：`create_linux_sandbox_command_args_for_permission_profile` → `codex-linux-sandbox --sandbox-policy-cwd --command-cwd --permission-profile <json> [--use-legacy-landlock] [--allow-network-for-proxy] -- CMD`）
  - `linux-sandbox/src/linux_run_main.rs`：bubblewrap 参数组装（ro-bind/bind 根、unshare-user/net）+ seccomp +（legacy）landlock + 代理生命周期
  - `windows-sandbox-rs`：`setup_main`（提权 setup：防火墙规则、沙箱用户、运行时 bin）+ `command_runner`（受限令牌执行、ACL、conpty 伪终端）
- 权限模型：`protocol/models.rs::PermissionProfile`（Managed/Disabled/External + FileSystem/Network sandbox policy + writable roots）与 `[permissions]` 配置文件（`config/permissions_toml.rs`）编译对齐；Windows 未启用沙箱时 `derive_permission_profile` 强制降级 read-only。

### 4.6 认证与密钥（`codex-rs/login/`）

- `auth/storage.rs`：`$CODEX_HOME/auth.json`（`AuthDotJson`），可选 keyring 后端（`keyring-store`）；`device_code_auth.rs`（设备码）、`pkce.rs` + `server.rs`（本地回调）、`token_data.rs`（token 刷新）。
- 凭据源优先级：`CODEX_API_KEY`（仅 exec）→ provider `env_key` 环境变量 → ChatGPT 登录 token（OAuth）；`auth/manager.rs` 统一注入。

---

## 5. 安全模型

1. **三层防线**：execpolicy 规则（allow/prompt/forbidden）→ 未匹配命令启发式（安全白名单 / 危险命令黑名单）→ 平台沙箱兜底（read-only/workspace-write/danger-full-access）。审批只在沙箱边界被跨越或规则要求时出现。
2. **危险命令检测**（`shell-command/src/command_safety/is_dangerous_command.rs`）：`rm -f/--force`（ForcedRm 单独标记）、`sudo`/`env`/`trap` 解包递归、`bash -lc`/`zsh`/`powershell -EncodedCommand` 等 8 层 wrapper 深度上限；`exec_policy.rs::BANNED_PREFIX_SUGGESTIONS` 列出 100+ 条禁止建议前缀（解释器 -c/-e 全家桶）。安全白名单（`is_safe_command.rs`）：cat/cd/echo/grep/head/ls/pwd/wc/… 只读命令，`find` 排除 `-exec/-delete/-fls`，`rg` 排除 `--pre/-z`，`git` 仅 status/log/diff/show/branch 且校验全局选项（`-C/-c/--git-dir` 防绕过），`sed -n N,Mp` 特判，`bash -lc` 纯命令组合（`&& || ; |`）逐条校验。
3. **审批动作三类**：`Accept`（一次）/`AcceptForSession`（会话内）/`AcceptWithExecpolicyAmendment`（写回 rules 文件永久化）；拒绝类：`Cancel`；网络：`ApplyNetworkPolicyAmendment`（allow/deny 主机，写入 rules）。Granular 模式可整体关闭某类弹窗（转为拒绝）。
4. **沙箱边界**：写根白名单（cwd+$TMPDIR+/tmp，可扩展）、网络默认禁、`.git/` 只读、`CODEX_SANDBOX_*` 环境变量暴露给模型可见、子进程 `env_clear`+白名单环境、父进程死亡信号、stdin 置 null；Linux 默认 bubblewrap+seccomp（独立 netns），macOS Seatbelt，Windows 受限令牌（实验）。
5. **密钥配置**：`auth.json`（file 或 keyring）、`env_key` 环境变量、`experimental_bearer_token`（源码注释明确"不鼓励，仅程序化场景"）、`CODEX_API_KEY`（仅 exec）；`shell_environment_policy` 默认剥离含 KEY/SECRET/TOKEN 的变量传给子进程；`history.jsonl` 0600 权限。
6. **hook 信任**：hooks 需持久化信任，`--dangerously-bypass-hook-trust` 显式跳过；enterprise `requirements.toml` 可 `allow_managed_hooks_only`。
7. **配置信任链**：cwd/tree/repo 层 config 在未信任目录被禁用；`--strict-config` 拒绝未知字段；`requirements_layers/` 对企业约束（模型、权限、规则、hooks）做校验（`constraint.rs`、`strict_config.rs`）。

---

## 6. 独有特性清单

1. **execpolicy 规则 DSL**：Starlark `prefix_rule` + 内建 match/not_match 单测 + `codex execpolicy check` 预演 CLI + 运行时"批准并永久白名单"写回机制，业界独有。
2. **事件源会话（rollout）**：追加式 JSONL + zstd 冷压缩 + SQLite 索引 + 线程历史物化 + 反向扫描，支持可靠 resume/fork/archive/search/migrate。
3. **分层配置 + 企业约束**：admin/system/cloud/user/profile/cwd/tree/repo 八层叠加，未信任目录禁用下层，`requirements.toml` 强制约束。
4. **Guardian 自动评审**（`--approve-for-me`）：AI 分级（guardian risk assessment）代替人工审批。
5. **多智能体 v1/v2** + 角色（`[agents.<role>]`、nickname）+ 目标（thread_goals）协作体系。
6. **统一 exec 工具**（exec_command+write_stdin+后台进程）替代裸 bash，输出结构化。
7. **MCP 延迟加载 + tool_search(BM25)** 与 ToolExposure 四态管理海量工具。
8. **远端执行环境**（exec-server：NOISE 加密中继、sandboxed FS/process）+ Cloud 任务回传（test_sync）。
9. **app-server 协议 v2 + TS/Python SDK + 桌面 daemon** 的完整 IDE/桌面集成层。
10. **技能系统**：SKILL.md frontmatter + 隐式调用检测 + `@skill` 提及 + 系统技能指纹缓存。
11. **OTel 结构化事件目录**（含默认脱敏）与 `notify` 外部通知 JSON 协议。
12. **模型目录化**：远端刷新的 model catalog（context window/truncation policy/tool_mode/multi-agent 版本等 per-model 能力）。
13. **shell 环境策略**（inherit/exclude/set/include_only 四步过滤）。
14. **可编程 keymap**（10 上下文 + chord + F1–F24 + vim 全套）。

---

## 7. 限制/短板

1. **OpenAI 中心化**：模型目录、部分功能（web_search 一方搜索、auto-review、远端压缩、cloud config）依赖 OpenAI 后端；`wire_api` 仅剩 responses（chat completions 被移除），自建 provider 门槛提高。
2. **Windows 沙箱仍为实验**：restricted-token 后端未启用时强制 read-only，Windows 上 workspace-write 体验受限。
3. **内置工具收缩**：`web_fetch`/`repo_map` 等已移除，web 能力依赖一方 `tools.web_search`（需配置开启）或插件/扩展，自托管 web 检索需自行接 MCP。
4. **仓库体量与构建复杂度**：Bazel 为主、6k+ 文件、vendored v8，源码构建门槛高；docs 已外迁至闭源站点（仓库内只剩 stub），自托管文档困难。
5. **默认保守**：workspace-write 默认禁网；exec 默认 read-only + 需要 git 仓库；初次使用需信任流程。
6. **审批记忆粒度粗**：execpolicy 是前缀匹配（无参数级/正则匹配、无 per-flag 区分），`rm -rf` 与 `rm -rf /tmp/x` 同规则。
7. **规则 DSL 能力有限**：README 自述"先覆盖 prefix_rule 子集，更丰富语言后续才来"；无 if/else、无环境变量展开。
8. **`--full-auto` 等文档 flag 与源码不一致**【待验证】；文档站 403 导致外部文档核对受限。
9. **本地多用户/权限治理**：依赖企业云配置（cloud bundle/requirements），纯本地无 RBAC。
10. 依赖方：`find` 安全校验等启发式复杂，误报/漏报边界需要持续维护（12k+ open issues 中相当部分是安全/沙箱类）。

---

## 8. 与我们可借鉴的差异亮点

1. **规则引擎 = 策略即代码 + 单测**：`prefix_rule(pattern, decision, match, not_match)` 把"审批策略"变成可加载、可预演（`execpolicy check`）、可写回的文件；决策聚合语义（forbidden>prompt>allow）清晰。→ 我们的审批层可学：规则文件 + CLI 预演 + 运行时热更新（`ArcSwap<Policy>`）。
2. **"批准并记住"的闭环**：一次审批可选择永久写回规则文件，且对不同模型（Honor/Ignore）与复杂解析场景做抑制，防"一条 allow 打穿全部"。
3. **命令安全分析深度**：wrapper 解包（sudo/env/trap/bash -lc/powershell 编码）、git 全局选项防绕过、`bash -lc` 纯命令组合逐条校验、包装深度上限——远比"危险字符串黑名单"可靠。
4. **事件源会话 + 压缩归档**：JSONL 追加（崩溃安全）+ 冷 zstd + SQLite 索引 + 反向扫描，天然支持 resume/fork/search/审计回放；`--ephemeral` 提供无痕模式。
5. **权限配置文件分层**：`[permissions]` 命名 profile（`PermissionProfile`）→ 编译到平台沙箱参数，一处定义三端（Seatbelt/bwrap+seccomp/RestrictedToken）生效。
6. **统一 exec 工具 + 结构化输出**：exec_command/write_stdin/后台终端 + `--output-schema` 结构化约束 + JSONL 全事件流（item 级 started/updated/completed），集成友好。
7. **沙箱环境策略**：`shell_environment_policy` 白名单化子进程环境、`CODEX_SANDBOX_*` 信号变量、父进程死亡信号链——"沙箱边界要可观测、可传染"。
8. **上下文按 section diff 注入**（world_state）：只把变化部分写入下一次请求，配合 `get_context_remaining`/`new_context`/自动压缩窗口，长会话 token 控制精细。
9. **工具发现分层**：小工具集直给、大工具集延迟加载 + BM25 `tool_search` + 命名空间暴露，解决 MCP 工具爆炸问题。
10. **企业约束层**（requirements.toml 对模型/权限/规则/hooks 的强制约束 + `strict_config`）——多租户部署时"用户可配但不可越界"的样板。

---

### 附录：关键源码路径速查（均相对仓库根）

- CLI 入口/子命令：`codex-rs/cli/src/main.rs`
- 共享 flags：`codex-rs/utils/cli/src/shared_options.rs`、`approval_mode_cli_arg.rs`、`sandbox_mode_cli_arg.rs`
- exec：`codex-rs/exec/src/cli.rs`、`event_processor*.rs`、`exec_events.rs`
- 审批/策略：`codex-rs/core/src/exec_policy.rs`、`safety.rs`；`codex-rs/execpolicy/src/{policy,rule,decision,amend,parser}.rs`；`codex-rs/protocol/src/approvals.rs`、`protocol.rs`(AskForApproval:916)
- 命令安全：`codex-rs/shell-command/src/command_safety/{is_safe_command,is_dangerous_command}.rs`、`bash.rs`、`powershell.rs`
- 沙箱：`codex-rs/sandboxing/src/{manager,landlock,bwrap,seatbelt,windows}.rs`；`codex-rs/linux-sandbox/src/linux_run_main.rs`；`codex-rs/windows-sandbox-rs/src/`
- 会话：`codex-rs/rollout/src/{recorder,compression,session_index}.rs`；`codex-rs/state/migrations/`；`codex-rs/thread-store/src/local/`
- 工具：`codex-rs/core/src/tools/{registry,router,sandboxing}.rs`、`handlers/`、`runtimes/`；`codex-rs/tools/src/`
- 配置：`codex-rs/config/src/{config_toml,types,permissions_toml,mcp_types,hook_config,tui_keymap,loader/mod}.rs`
- 模型：`codex-rs/model-provider-info/src/lib.rs`、`models-manager/models.json`
- 集成：`codex-rs/app-server/`、`app-server-protocol/src/protocol/v2/`、`exec-server/`、`codex-rs/mcp-server/`、`rmcp-client/`、`codex-mcp/`
