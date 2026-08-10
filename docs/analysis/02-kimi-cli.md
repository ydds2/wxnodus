# Moonshot Kimi CLI 全量构造与代码设计分析

> 分析对象：GitHub `MoonshotAI/kimi-cli`（默认分支 `main`），以 2026-08-03 的仓库快照为准
> 分析方法：GitHub REST API（元信息 + 完整 git tree）+ raw.githubusercontent.com 逐文件阅读源码 + 官方文档（`docs/en/`，VitePress 中英双语）
> 数据点：v1.49.0（`pyproject.toml`），11.1k stars / 1.29k forks，Apache-2.0，创建于 2025-10-15，最近推送 2026-08-03，open issues 835

---

## 1. 定位与架构总览

### 1.1 定位

> "Kimi CLI is an AI agent that runs in the terminal, helping you complete software development tasks and terminal operations. It can read and edit code, execute shell commands, search and fetch web pages, and autonomously plan and adjust actions during execution."

Kimi CLI 是月之暗面（Moonshot AI）出品的终端 AI agent（coding agent + 通用终端 agent），定位与 Claude Code / Codex CLI / Gemini CLI 同类。**重要**：README 顶部官方公告其正在演进为下一代产品 **Kimi Code CLI**（`MoonshotAI/kimi-code`），本项目将逐渐淡出（"This project will be gradually wound down"），新安装会自动迁移配置与会话——即本仓库处于"维护期 + 被替代中"的状态。

- 语言/运行时：**Python ≥ 3.12**（pyproject `requires-python = ">=3.12"`；pyright/ty 按 3.14 检查）
- 打包：`uv_build` 构建系统、`uv.lock` 工作区；PyInstaller 单文件二进制（`kimi.spec`）；Nix（`flake.nix`）
- 入口：`[project.scripts] kimi = "kimi_cli.__main__:main"`（同时提供 `kimi-cli` 别名）
- 核心第三方依赖（`pyproject.toml`）：`typer`（CLI 框架）、`prompt-toolkit`（交互输入）、`rich`（渲染）、`kosong`（自研 LLM 抽象，workspace 内）、`pykaos`（自研远程执行抽象，workspace 内）、`agent-client-protocol`（ACP SDK）、`fastmcp`（MCP 客户端）、`keyring`、`fastapi/uvicorn/scalar-fastapi/websockets`（Web UI）、`ripgrepy`（Grep 后端）、`trafilatura`（网页正文提取）、`tenacity`（重试）、`streamingjson`（流式工具参数）、`loguru`（日志）、`pydantic`、`tomlkit`、`jinja2`（提示词模板）、`aiohttp/aiofiles/httpx`、`pillow`、`pyyaml`

### 1.2 仓库规模（git tree 精确统计，988 个跟踪文件 / 181 个目录）

| 区域 | 文件数 | 说明 |
|---|---|---|
| `src/kimi_cli/` | 254 | 主包（估算约 6 万行 Python） |
| `tests/` + `tests_e2e/` + `tests_ai/` | 244 | 单元 / e2e / AI 冒烟测试（`inline-snapshot` 快照断言） |
| `web/` | 181 | Web UI（React + TypeScript，FastAPI 后端） |
| `vis/` | 45 | Agent 追踪可视化器（React + TS） |
| `packages/` | 81 | 自研库（kosong / kaos / kimi-code） |
| `docs/` | 77 | VitePress 文档（en/zh 双语，含 `llms.txt` 入口） |
| `examples/` | 27 | 自定义 soul、自定义工具、stream-json、wire 消息、插件样例 |
| `.agents/skills/` | 11 | 官方自有 skill（codex-worker、pull-request、release 等） |
| `klips/` | 14 | 官方小技巧合集（markdown） |

### 1.3 目录分层职责（Monorepo）

| 路径 | 职责 |
|---|---|
| `src/kimi_cli/app.py` | `KimiCLI` 应用门面：装配 Config/OAuth/LLM/Runtime/Agent/Soul，统一四种 UI 运行入口（`run_shell` / `run_print` / `run_acp` / `run_wire_stdio`） |
| `src/kimi_cli/cli/` | Typer CLI 定义：主命令参数、子命令（`login/logout/acp/term/mcp/plugin/export/info/web/vis` 及隐藏的内部 worker 命令）；`_lazy_group.py` 惰性子命令加载 |
| `src/kimi_cli/soul/` | **核心**。`kimisoul.py`（agent 主循环 + Ralph/Flow 循环）、`agent.py`（Agent/Runtime 装配）、`approval.py`（审批）、`slash.py`（soul 级斜杠命令）、`toolset.py`（工具注册/去重/MCP 桥）、`compaction.py`（上下文压缩）、`context.py`（JSONL 上下文/checkpoint）、`message.py`（消息校验）、`btw.py`（侧问）、`denwarenji.py`（D-Mail 时间旅行）、`dynamic_injection*.py`（动态提示注入） |
| `src/kimi_cli/approval_runtime/` | 审批运行时：请求记录、等待器、跨 UI 广播（`runtime.py`、`models.py`） |
| `src/kimi_cli/tools/` | 内置工具实现（`agent/ ask_user/ background/ dmail/ file/ plan/ shell/ think/ todo/ web/`）+ 工具加载器 |
| `src/kimi_cli/agents/` | 内置 agent 规格（`default/`：agent/coder/explore/plan 的 YAML + `system.md` 系统提示词；`okabe/` 彩蛋人格） |
| `src/kimi_cli/subagents/` | 子代理系统：labor market 注册表、foreground/background runner、实例 store、git 上下文注入 |
| `src/kimi_cli/background/` | 后台任务：manager、worker 子进程、store、summary、agent_runner（后台 agent 任务） |
| `src/kimi_cli/notifications/` | 通知系统：后台任务完成 → 通知 sink（`llm`/`wire`/`shell`） |
| `src/kimi_cli/wire/` | Wire 协议：JSON-RPC 2.0 服务器、消息类型、RootWireHub 广播、wire.jsonl 记录 |
| `src/kimi_cli/acp/` | ACP（Agent Client Protocol）服务器：会话管理、工具映射、KAOS 桥、MCP 透传 |
| `src/kimi_cli/auth/` | OAuth（`oauth.py`，设备码 + 平台登录/登出）、平台注册表（`platforms.py`，managed model 同步） |
| `src/kimi_cli/ui/` | Shell TUI（`shell/`，prompt-toolkit+rich 自研）、Print UI（`print/`）、ACP UI（`acp/`）、主题（`theme.py`） |
| `src/kimi_cli/skill/` | Skills：发现/加载/`flow` 图（mermaid/d2 解析）、标准 skill 与 flow skill |
| `src/kimi_cli/hooks/` | Hook 引擎：13 类生命周期事件、config 级 shell 钩子 + wire 客户端钩子 |
| `src/kimi_cli/plugin/` | 插件系统：`plugin.json` 规格、安装/卸载、主机凭证注入（`plugin/manager.py`、`plugin/tool.py`） |
| `src/kimi_cli/web/` | Web UI 后端：FastAPI 应用、API 路由、runner（`kimi __web-worker` 子进程）、store |
| `src/kimi_cli/vis/` | 追踪可视化后端（Wire 时间线、上下文、用量统计） |
| `src/kimi_cli/telemetry/` | 匿名遥测：事件 sink、异步 transport、崩溃处理（`KIMI_DISABLE_TELEMETRY` 可关） |
| `src/kimi_cli/config.py` `session.py` `session_state.py` `metadata.py` `llm.py` `share.py` `constant.py` | 配置 / 会话 / 状态 / 目录元数据 / LLM 工厂与 token 估算 / 共享目录 / 常量 |
| `packages/kosong/` | 自研 LLM 抽象库（`generate`/`step`、ChatProvider 抽象、消息模型、工具模型），`contrib/` 含 openai/anthropic/google 适配 |
| `packages/kaos/`（pykaos） | 自研"KAOS"抽象：本地 + SSH 远程文件系统/执行（`local.py`、`ssh.py`）——支持在远程主机上跑 agent |
| `packages/kimi-code/` | 兼容别名包（`kimi_code` → `kimi_cli` 模块别名） |
| `sdks/kimi-sdk/` | 轻量 Python SDK（占位） |
| `web/`、`vis/` | React（Vite + TS）前端，web 由 FastAPI 提供静态资源与 OpenAPI（`web/openapi.json`，scalar 文档） |

### 1.4 运行时装配流（`app.py` `KimiCLI.create`）

```
load_config → OAuthManager → create_llm(provider/model/thinking) → Runtime.create(批准/通知/后台任务/技能发现)
→ load_agent(agent.yaml + 工具 + 插件 + MCP) → Context.restore(context.jsonl) → KimiSoul(agent, context)
→ 可选 plan_mode 激活 → HookEngine → 遥测 sink → 按 ui_mode 分派 run_shell/run_print/run_acp/run_wire_stdio
```

`soul/agent.py` 的 `Runtime` dataclass 是全局依赖容器（config、oauth、llm、session、approval、labor_market、environment、notifications、background_tasks、skills、subagent_store、approval_runtime、root_wire_hub），`KimiToolset.load_tools` 按构造器参数类型做依赖注入加载工具类（`kimi_cli.tools.shell:Shell` 形式的路径）。

---

## 2. 全量功能清单

### 2.1 模式系统

Kimi CLI **没有** Claude Code 式 `smart/auto` 模型选择模式。其"模式"是四组正交状态：

| 模式 | 语义 | 触发 |
|---|---|---|
| **Agent 模式 / Shell 模式**（输入模式） | Agent 模式输入交给 AI；Shell 模式把输入当本地 shell 命令直接执行（不离开 CLI） | `Ctrl-X` 切换；提示符 Agent=`✨`/`💫`（thinking）、Plan=`📋`、Shell=`$`。内置 shell 命令（`cd` 等）暂不支持（README 明示） |
| **Plan 模式**（只读研究+规划） | AI 只能用只读工具（Glob/Grep/ReadFile）探索，把实现计划写进专属 plan 文件，经 `ExitPlanMode` 提交用户审批；写工具在 plan 模式下拒绝（除 plan 文件本身） | `Shift-Tab`、`/plan [on|off|view|clear]`、`kimi --plan`、AI 主动 `EnterPlanMode`；`default_plan_mode=true` 可默认开启；状态持久化到 session |
| **YOLO 模式**（auto-approve） | 所有工具调用自动批准；仍允许 `AskUserQuestion` 提问 | `--yolo/--yes/-y/--auto-approve`、`/yolo`、`default_yolo=true`；状态栏黄色 YOLO 徽章 |
| **AFK 模式**（away-from-keyboard） | 隐式 auto-approve + 自动驳回 `AskUserQuestion`（无人在场，agent 自行判断）；`--print` 隐式开启 | `--afk`、`/afk`；`--print` 时以 `runtime_afk`（不持久化）注入；状态栏橙色 AFK 徽章 |
| **Thinking 模式** | 模型深度思考；可开关（模型支持时） | `--thinking/--no-thinking`、`/model` 交互选择；`kimi-k2-thinking-turbo` 等模型强制开启（`derive_model_capabilities`：模型名含 "thinking"/"reason" → `always_thinking`） |
| **Ralph 循环模式** | 同一 prompt 反复喂养的自动迭代循环，见 §4.1 | `--max-ralph-iterations N`（0 关 / -1 无限）或 config `loop_control.max_ralph_iterations` |

### 2.2 审批体系（approval）

- 审批响应三态：`approve` / `approve_for_session` / `reject`（`approval_runtime/models.py` `ApprovalResponseKind`）
- 审批缓存（**auto_approve_actions**，"Allow this session"）：session 级 `set[str]`，持久化在 `state.json`，恢复会话时自动还原
- 自动批准优先级：`is_auto_approve()` = yolo 或 afk → 免审批；否则 `action in auto_approve_actions` → 免审批（记 `approval_mode="auto_session"`）；否则弹审批面板
- 审批来源（ApprovalSource）：`foreground_turn` / `background_agent`（后台 agent 的审批也能路由到前台 UI）
- 审批动作（action）分类（工具名→action 字符串）：
  - `Shell`：`"run command"`、`"run background command"`
  - `WriteFile`/`StrReplaceFile`：`"edit file"`（工作区内）或 `"edit file outside of working directory"`（`tools/file/__init__.py` `FileActions`；`READ = "read file"` 已定义但读文件不弹审批）
  - `TaskStop`：`"stop background task"`
  - MCP 工具：`"mcp:<tool_name>"`
  - plan 文件写入自动免审批（`bind_plan_mode` 绑定）
- UI 选项（`ui/shell/visualize/_approval_panel.py`）：`Approve once` / `Approve for this session` / `Reject` / `Reject, tell the model what to do instead`（带反馈文本，反馈会作为 `ToolRejectedError.has_feedback` 传回模型引导下一次尝试）；数字键 1-4 快捷选择；`Ctrl-E` 展开截断内容
- 拒绝语义：根 agent 收到纯拒绝（无反馈）→ 直接结束 turn（`stop_reason="tool_rejected"`）；子代理收到拒绝 → 不结束，让模型换方案重试
- "Approve for this session" 生效时同时 resolve 队列中所有同 action 的 pending 请求（`approval.py` case `approve_for_session`）

### 2.3 会话体系（sessions）

- 存储布局：`~/.kimi/kimi.json`（工作目录元数据：`work_dirs`、`last_session_id`）→ `~/.kimi/sessions/<md5(work_dir)>/<session_id>/`，内含：
  - `context.jsonl` — 消息历史（含特殊行）
  - `wire.jsonl` — Wire 事件日志（用于回放/标题派生）
  - `state.json` — 会话状态（`SessionState`：approval 设置、plan_mode、additional_dirs、custom_title、todos、归档字段）
  - `subagents/` — 子代理实例目录
- 新建/切换/恢复：
  - 新建：直接 `kimi`（空会话退出自动删除）
  - 恢复最近：`kimi --continue/-C`
  - 恢复指定：`kimi --session/-S/-r <id>`（不存在则自动新建）
  - 交互挑选：`kimi --session`（无参，prompt_toolkit ChoiceInput 列表）
  - 运行时切换：`/new`（新建并切换）、`/sessions`（别名 `/resume`，`Ctrl-A` 切换 当前目录/全部目录 范围）、`/title <text>`（别名 `/rename`，首个 turn 后自动从用户消息生成标题，手动设置后不再覆盖）
  - 退出提示：`To resume this session: kimi -r <session-id>`
- `/undo`：回滚到历史某 turn 之前 → **fork 新会话**并预填该 turn 消息（原会话保留）；`/fork`：复制完整历史开新分支；`/clear`（别名 `/reset`）：清空上下文（不清会话状态）；`/export`：导出 Markdown（`kimi-export-<id8>-<ts>.md`，含元数据/概览/按 turn 完整历史）；`/import <file|session_id>`：导入上下文（敏感文件告警）
- 启动回放：恢复会话时 `ui/shell/replay.py` 回放历史（thinking 流可配置 `show_thinking_stream`）

### 2.4 上下文管理（token/压缩/记忆）

- token 计数：`Context` 内 `_token_count` + `_pending_token_estimate`（字符启发式估算：ASCII `(n+3)//4`、非 ASCII 每字符 1 token、媒体 2000）；LLM usage 回来后写 `{"role":"_usage","token_count":N}` 行校准
- 状态栏实时显示：`context: 42.0% (4.2k/10.0k)`
- 自动压缩：step 开头检查 `should_auto_compact`（`compaction.py`）：`token_count >= max_context_size * trigger_ratio`（默认 0.85）**或** `token_count + reserved_context_size >= max_context_size`（默认 50k 预留）
- 压缩算法（`SimpleCompaction`）：保留最后 2 条 user/assistant 消息，其余喂给 LLM（`COMPACTION_SYSTEM_PROMPT`）生成摘要，结果以 `COMPACTION_OUTPUT_PREFIX` 开头的 user 消息 + 保留消息重建历史；丢弃 ThinkPart；支持 `/compact <custom instruction>` 自定义保留重点；失败带重试（同 step 重试策略）；PreCompact/PostCompact 钩子
- checkpoint：`{"role":"_checkpoint","id":N}` 行；D-Mail 回退见 §4.2
- 记忆/技能：skills 按 scope 注入系统提示词（`KIMI_SKILLS`）；`AGENTS.md` 合并注入（root→leaf，32KiB 预算，`<-- From: path -->` 标注）
- `/debug`：显示消息数/token 数/checkpoint 数/完整历史

### 2.5 内置工具清单（`agents/default/agent.yaml`，默认全开；括号内为默认关闭项）

| 工具 | 类别 | 用途要点 |
|---|---|---|
| `Agent` | 子代理 | 派发子任务（`subagent_type`：coder/explore/plan；`model` 覆盖；`resume` 恢复实例；`run_in_background`）；仅根 agent 可用 |
| `AskUserQuestion` | 交互 | 结构化提问 1-4 问（每问 2-4 选项，系统自动加 "Other"），afk 时自动驳回 |
| `SetTodoList` | 规划 | 设置/读取 todo 列表（pending/in_progress/done），持久化到会话状态 |
| `Shell` | 执行 | 执行 shell 命令（`timeout` 默认 60s，前台上限 5min；`run_in_background=true` 转后台任务，上限 24h，需 description） |
| `TaskList` / `TaskOutput` / `TaskStop` | 后台任务 | 枚举（active_only）/ 读输出（可 block 等待）/ 停止后台任务 |
| `ReadFile` | 文件 | 读文件（行号+行范围） |
| `ReadMediaFile` | 文件 | 读图片/音频/视频（data URI，模型能力 gate） |
| `Glob` | 文件 | 通配匹配（工作区 + additional_dirs） |
| `Grep` | 文件 | 正则搜索（`ripgrepy`/ripgrep 后端） |
| `WriteFile` | 文件 | 写/覆盖/追加文件（diff 预览 + 审批；plan 文件免审批） |
| `StrReplaceFile` | 文件 | 精确字符串替换（diff 预览 + 审批） |
| `SearchWeb` | Web | Moonshot Search 服务搜索（config `services.moonshot_search`） |
| `FetchURL` | Web | 抓 URL 并 trafilatura 提取正文（`services.moonshot_fetch`） |
| `ExitPlanMode` | 规划 | plan 模式下提交计划审批（支持 2-3 个备选方案供用户选；afk 自动批准） |
| `EnterPlanMode` | 规划 | AI 主动申请进入 plan 模式（yolo 自动批准） |
| （`SendDMail`） | 时间旅行 | 向过去 checkpoint 发"D-Mail"（见 §4.2） |
| （`Think`） | 思考 | 显式思考工具（`thought` 参数，结果空返回，仅记录） |

另有三种动态工具来源：**MCP 工具**（`mcp:<name>`，100k 字符输出预算）、**Wire 外部工具**（客户端经 `initialize` 注册，`ToolCallRequest` 转发）、**插件工具**（`plugin/tool.py`，plugin.json 定义 + 主机凭证注入）。工具结果统一经 `ToolResultBuilder` 限长（默认 50k 字符 / 行 2000）。

### 2.6 模型调用（`llm.py` + `soul/kimisoul.py`）

- Provider 抽象（`kosong.chat_provider`）：`kimi`（官方）、`openai_legacy`、`openai_responses`、`anthropic`、`google_genai`/`gemini`、`vertexai`，测试用 `_echo`/`_scripted_echo`/`_chaos`
- 能力模型 `ModelCapability`：`image_in` / `video_in` / `thinking` / `always_thinking`；消息发送前 `check_message` 校验能力（不满足抛 `LLMNotSupported`）
- 流式：`kosong.step` 全流式（内容 + 工具参数增量），经 `on_message_part`/`on_tool_result` 回调直通 Wire
- 重试：`tenacity` + `wait_exponential_jitter(0.3~5s)`，`max_retries_per_step`（默认 3）；可重试错误 = `APIConnectionError/APITimeoutError`（可恢复）、`APIEmptyResponseError`、`APIStatusError` 429/500/502/503/504（`_is_retryable_error`）；重试时发 `StepRetry` wire 事件
- 错误分类（`classify_api_error`）：rate_limit(429)/auth(401,403)/overloaded(529)/5xx/4xx_client/context_overflow（"context length" 等关键词）/network/timeout/empty_response
- 恢复机制（`_run_with_connection_recovery`）：401 → 强制刷新 OAuth token 后重试；连接错误 → `RetryableChatProvider.on_retryable_error` 重建连接后重试一次
- token 预算：`estimate_request_tokens`（含 system prompt/工具 schema/历史/媒体）→ `compute_max_completion_tokens` 动态算 `max_completion_tokens`（`max_context_size - input - 1024 安全边距`），仅对 Kimi provider 生效（`_KimiRequestChatProvider`）
- 提示缓存：Kimi provider 以 `session_id` 作 `prompt_cache_key`；`/btw` 侧问复用同一 system prompt+历史+工具定义以最大化缓存命中
- 多模型：`config.models`/`providers` 字典 + `default_model`；`managed:` 前缀 provider（`auth/platforms.py`）自动从平台 `/models` 拉取模型列表刷新到 config（Kimi Code / moonshot.cn / moonshot.ai 三个内置平台）；env 覆盖 `KIMI_BASE_URL`/`KIMI_API_KEY`/`KIMI_MODEL_NAME`/`KIMI_MODEL_MAX_CONTEXT_SIZE`/`KIMI_MODEL_CAPABILITIES`/`KIMI_MODEL_TEMPERATURE`/`KIMI_MODEL_TOP_P`/`KIMI_MODEL_MAX_COMPLETION_TOKENS`/`KIMI_MODEL_THINKING_KEEP`/`OPENAI_BASE_URL`/`OPENAI_API_KEY`

### 2.7 终端 UI（自研，非 ink/react）

基于 **prompt-toolkit 3 + rich** 的自研 TUI（`ui/shell/prompt.py` `CustomPromptSession`），特性：

- 快捷键（`docs/en/reference/keyboard.md`，实现在 `ui/shell/keyboard.py`）：`Ctrl-X` 模式切换、`Shift-Tab` plan 模式、`Ctrl-O` 外部编辑器（`/editor` 或 `$VISUAL/$EDITOR`，自动探测 code--wait→vim→vi→nano，占位符展开/折叠）、`Ctrl-J`/`Alt-Enter` 换行、`Ctrl-S` steer（运行中即时注入）、`Ctrl-V` 粘贴（长文本自动折叠为 `[Pasted text #n]` 占位符；图片缓存为 `[image:...]` 随消息发送；视频插路径）、`Ctrl-E` 展开审批/计划全文、数字键 1-4/1-5 快速选择、`Ctrl-D` 退出、`Ctrl-C` 中断
- 流式期间交互：Enter 排队（`── input · 2 queued ──`，`↑` 召回编辑）、`Ctrl-S` 即时注入
- 补全菜单：`/` 斜杠命令（模糊匹配+别名）、`@` 文件路径（git 仓库用 `git ls-files`）
- 底部状态栏：时间、模式+模型名、YOLO（黄）/AFK（橙）/Plan（蓝）徽章、快捷键提示、context 用量、MCP 状态、后台任务数
- 审批面板（diff/shell 命令预览）、结构化问题面板（tab 切换多问题）、`/btw` 侧问模态面板、任务浏览器三栏 TUI（`/task`：任务列表/详情/输出预览，Enter/O 查看、S 停止、Tab 过滤、R 刷新、Q 退出）
- 会话选择器（`ui/shell/session_picker.py`）、启动欢迎卡片、`theme` 明暗主题（`ui/theme.py`，rich styles 全套）
- thinking 流：6 行滚动预览 + 结束提交完整 markdown（`show_thinking_stream` 可关）

### 2.8 非交互 / CI 能力（Print UI）

- `kimi --print -p "..."` 或 stdin 管道输入；隐式 afk（auto-approve + 问题自动处理）
- 输出格式：`text`（rich 渲染）或 `stream-json`（JSONL：assistant/tool 消息序列）；输入同样支持 `stream-json`（持续读 stdin 逐条处理，多轮）
- `--final-message-only` 只输出最终助手消息；`--quiet` = `--print --output-format text --final-message-only`
- **退出码协议**：`0` 成功；`1` 不可重试失败（配置/认证/额度）；`75`（EX_TEMPFAIL）可重试失败（429/5xx/超时）——脚本据此决定重试
- 后台任务等待：print 模式等待后台任务完成并自动重入 agent 处理结果（`print_wait_ceiling_s` 上限）

### 2.9 输出协议（Wire，`kimi --wire`）

- JSON-RPC 2.0 over stdio，协议版本 **1.10**（`wire/protocol.py`）
- 客户端→服务器请求：`initialize`（版本协商 + 外部工具注册 + 能力声明 `supports_question`/`supports_plan_mode` + 钩子订阅）、`prompt`（跑一个 turn）、`replay`（回放 wire.jsonl）、`steer`（注入运行中 turn）、`set_plan_mode`、`cancel`
- 服务器→客户端：`event` 通知（TurnBegin/TurnEnd/StepBegin/StepInterrupted/StepRetry/CompactionBegin/CompactionEnd/StatusUpdate/ContentPart/ToolCall/ToolCallPart/ToolResult/ApprovalResponse/SubagentEvent/BtwBegin/BtwEnd/SteerInput/PlanDisplay/HookTriggered/HookResolved）、`request` 请求（ApprovalRequest/ToolCallRequest/QuestionRequest/HookRequest，必须应答）
- 能力门控：客户端未声明 `supports_question` → 隐藏 `AskUserQuestion`；未声明 `supports_plan_mode` → 隐藏 plan 工具
- 错误码：`-32000` 已有 turn 进行中 / `-32001` LLM 未配置 / `-32002` 模型不支持 / `-32003` LLM 服务错误

### 2.10 ACP（Agent Client Protocol）

- `kimi acp` 子命令（`--acp` 已弃用）；ACP SDK `agent-client-protocol==0.8.0`，协议协商 v1（spec v0.10.8）
- 支持多会话（`ACPServer.sessions` 字典）、MCP 服务器透传（`acp/mcp.py`）、工具替换映射（`acp/tools.py`，Wire→ACP 工具桥）、KAOS 桥（`acp/kaos.py`）
- README 给出 Zed / JetBrains `~/.jetbrains/acp.json` 接入示例；需先 `/login`

### 2.11 MCP 支持

- `kimi mcp` 子命令组：`add --transport http|stdio [--auth oauth] [--header ...]`、`list`、`remove`、`auth`（OAuth 授权）
- 运行参数：`--mcp-config-file <file>`（可重复）、`--mcp-config <json>`；默认读全局 MCP 配置文件；README 支持标准 `mcpServers` 格式（url+headers / command+args）
- 实现：`fastmcp.Client`，工具注册为 `MCPTool`（名称 `mcp:<name>`），调用前走审批（action `mcp:<name>`），超时 `config.mcp.client.tool_call_timeout_ms`（60s），输出预算 `MCP_MAX_OUTPUT_CHARS=100_000`（文本截断、媒体超预算丢弃）；OAuth 服务器需要先 `kimi mcp auth <name>`（凭据存 `~/.kimi/mcp-oauth/`，启动时未授权标记 `unauthorized` 跳过）
- 延迟加载：shell 模式下 MCP 后台连接（`start_deferred_mcp_tool_loading`），`/mcp` 查看连接状态

### 2.12 Skills

- 类型：`standard`（SKILL.md 当提示词喂给模型）/ `flow`（SKILL.md 内嵌 Agent Flow 图，mermaid/d2 解析成节点图执行，`/flow:<name>` 驱动到 END 节点，`DEFAULT_MAX_FLOW_MOVES=1000`）
- 发现分层（`skill/__init__.py`）：`builtin`（打包自带 kimi-cli-help、skill-creator）→ `user`（`~/.kimi/skills`、`~/.claude/skills`、`~/.codex/skills` 品牌目录可合并、`~/.agents/skills`）→ `project`（项目根 `.kimi/.claude/.codex/.agents/skills`）→ `extra`（config `extra_skill_dirs`、`--skills-dir`、插件目录）
- 调用：`/skill:<name> [附加指令]`、`/flow:<name>`；技能清单注入系统提示词
- 内部实现与 Claude Code skill 兼容（品牌目录通用）

### 2.13 Hooks

- 13 类事件（`hooks/config.py`）：PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / Stop / StopFailure / SessionStart / SessionEnd / SubagentStart / SubagentStop / PreCompact / PostCompact / Notification
- config.toml 定义 `[[hooks]]`（event + command + matcher 正则 + timeout），命令收 JSON stdin；`block` 结果可拦截（如 PreToolUse 阻断工具、UserPromptSubmit 阻断 prompt）
- 双通道：服务器 shell 钩子 + Wire 客户端订阅（`HookRequest`，能力协商）；**fail-open**（钩子异常/超时默认放行，但 telemetry 失败不吞 block 结果）
- 生命周期：Stop 钩子可注入"停止理由"重跑一轮（`_stop_hook_active` 防死循环）

### 2.14 其他

- **后台任务**：`background/` 子系统——Shell/Agent 工具 `run_in_background=true`；独立 worker 子进程（`kimi __background-task-worker`，心跳 5s/失联 15s）；任务完成 → 通知注入 LLM（自动重入新 turn 处理结果）；`max_running_tasks=4`；退出默认杀死（`keep_alive_on_exit` 可保活）；`/task` 浏览器
- **插件**：`kimi plugin` 子命令；plugin.json 声明 config 注入（`{{host.api_key}}` 等主机凭证，OAuth token 自动刷新回注）；`examples/sample-plugin` 示例
- **子代理**：内置 coder/explore/plan 三种类型（YAML 声明工具白名单）；foreground/background 两种运行方式；实例可 `resume`（持久化 context）；explore 自动注入 git 上下文
- **/init**：临时子会话分析代码库生成 `AGENTS.md`
- **/btw**：侧问（隔离上下文、工具禁用、不写主历史、maxTurns=2）
- **/usage**（Kimi 平台配额）、**/feedback**、**/upgrade**（安装 kimi-code 并迁移）、**/web**（切到 Web UI）、**/vis**（追踪可视化）、**/reload**（热重载配置）、**/theme**、**/editor**、**/model**
- **Web UI**：FastAPI + React（`web/`），默认端口 5494，`/web` 切换，`kimi web` 子命令；**vis 可视化器**（`vis/`）：Wire 时间线、上下文消息、状态、统计
- **Kaos 远程执行**：`packages/kaos` 支持 SSH 后端，`KaosPath` 抽象（work_dir 可在远程主机）
- **遥测**：匿名事件（turn/tool/approval/compaction/api_error...），`KIMI_DISABLE_TELEMETRY` 或 `telemetry=false` 关闭

---

## 3. 场景覆盖

| 场景 | 支持方式 |
|---|---|
| 交互式 | Shell TUI：流式、steer/排队、审批面板、问题面板、任务浏览器、多会话切换、plan/yolo/afk 动态开关 |
| 非交互单发 | `--print -p "..."` / stdin；`--quiet` 纯最终输出；退出码 0/1/75 |
| 脚本/管道 | `--print --input-format=stream-json --output-format=stream-json`（JSONL 双向、多轮持续处理） |
| 结构化协议 | `--wire`（JSON-RPC 2.0，双向，外部工具/钩子/审批/问题全托管） |
| IDE 集成 | ACP 服务器（`kimi acp`，Zed/JetBrains 官方示例）；VS Code 扩展（moonshot-ai.kimi-code） |
| 多会话 | 每工作目录多会话；`-C`/`-S id`/picker/`/sessions`/`/new`/`/fork`/`/undo`；会话状态持久化 |
| 无人值守 | `--afk`（自动审批+自动驳回提问+plan 自动批准）；后台任务+完成通知自动续跑；`--print` 隐式 afk |
| 浏览器 | Web UI（React）+ vis 可视化器 |
| 远程 | KAOS SSH 后端（工作目录在远程机器） |
| zsh 集成 | 官方 `zsh-kimi-cli` 插件（Ctrl-X 切换 agent/shell 模式） |

---

## 4. 代码设计细节（源码机制）

### 4.1 Ralph 循环（目标循环）——`soul/kimisoul.py` `FlowRunner.ralph_loop`（L1800）

- **判定**：`KimiSoul.run` 中非斜杠命令输入时，若 `loop_control.max_ralph_iterations != 0` 则走 Ralph 循环（否则普通 `_turn`）
- **图结构**（通用 Flow 机制）：`BEGIN → R1(task 节点，label=用户原始 prompt) → R2(decision 节点) → CONTINUE→R2 / STOP→END`，`max_moves = max_ralph_iterations + 1`（-1 时 ≈10^15 近乎无限）
- **停止标记**：decision 节点要求模型以 `<choice>STOP</choice>`（或 CONTINUE）格式回复（`_build_flow_prompt` 尾部 "Reply with a choice using <choice>...</choice>"；`_match_flow_edge` 精确匹配标签）；R2 的 prompt 强调 "Only choose STOP when the task is fully complete... If you are not 100% sure, choose CONTINUE."
- 循环体：每次迭代 = 一次完整 `_turn`（内部仍是 step 循环）；无效 choice 会追加纠偏提示重试；`tool_rejected` 立即终止；总步数超 `max_moves` 抛 `MaxStepsReached`
- 文档（`docs/en/reference/kimi-command.md`）注明灵感来源 [ghuntley.com/ralph](https://ghuntley.com/ralph/)
- **注意：本仓库不存在 `[GOAL_DONE]` 标记**（全仓库 grep 无结果）；Kimi 用的是 `<choice>STOP</choice>`，且 goal 语义内嵌在用户 prompt 中，无显式目标注册/状态机

### 4.2 D-Mail 时间旅行（Checkpoint 回退）——`soul/denwarenji.py` + `soul/kimisoul.py` `BackToTheFuture`

- `Context.checkpoint()` 每步写 `{"role":"_checkpoint","id":N}` 到 context.jsonl（第一个 turn 还会追加 `CHECKPOINT N` 用户消息）
- `SendDMail` 工具（默认关闭）可发 `DMail(message, checkpoint_id)`；`DenwaRenji` 单槽缓存
- 若当前步有 D-Mail：`_step` 抛 `BackToTheFuture(checkpoint_id, messages)` → `_agent_loop` 捕获 → `context.revert_to(checkpoint_id)`（把 context.jsonl **旋转**为 `.1` 备份文件后重建到 checkpoint 为止）→ 注入 "You just got a D-Mail from your future self..." 系统消息 → 继续循环（"Back to the future"）
- 文件系统状态回滚明确 TODO 未实现（`DMail` 注释 "TODO: allow restoring filesystem state"）

### 4.3 审批缓存数据结构与持久化

- `ApprovalState.auto_approve_actions: set[str]`（`soul/approval.py`）
- 持久化：`Runtime.create` 读取 `session.state.approval.auto_approve_actions` 初始化，`_on_approval_change` 回调把 yolo/afk/actions 全量写回 `state.json`（`atomic_json_write`）
- `approve_for_session` 处理（`soul/approval.py` case）：`self._state.auto_approve_actions.add(action)` + 对 `ApprovalRuntime.list_pending()` 中同 action 的请求 `resolve(..., approved_via_session_cache=True)`（telemetry 记 `permission_mode="auto"`）
- `ApprovalRuntime`（`approval_runtime/runtime.py`）：`_requests: dict[id, record]`、`_waiters: dict[id, Future]`（多观察者共享计数）、订阅者回调 + `RootWireHub.publish_nowait` 广播 `ApprovalRequest/ApprovalResponse` 到所有 UI（shell/print/wire/acp/web 共用）；超时/来源取消 → `ApprovalCancelledError`

### 4.4 主 agent 循环（`KimiSoul._agent_loop` / `_step`）

- Turn 初始化：清空 stale steer → MCP 延迟加载（`MCPLoadingBegin/End`）→ step 循环（`max_steps_per_turn` 守卫）→ 每步：StepBegin → 自动压缩检查 → checkpoint → `_step`
- `_step` 子生命周期（注释编号 2e.1-2e.8）：通知投递（root，limit 4）→ 动态注入收集（plan/afk provider）→ 历史归一化（相邻 user 消息合并）→ LLM 调用（`kosong.step` + tenacity 重试 + 连接恢复）→ usage/StatusUpdate → 等所有工具结果（`result.tool_results()`，可被中断）→ `_grow_context`（shield 防中断）→ 结果判定：纯拒绝→停；D-Mail→回退；工具重复→force_stop；还有工具调用→继续；无工具调用→turn 结束
- 停止原因：`no_tool_calls` / `tool_rejected` / `tool_call_repeat`（`StepStopReason`）
- 每 turn 前 `oauth.ensure_fresh`；用户消息自动生成标题（50 字符截断，读-改-写防覆盖 web 并发修改）

### 4.5 工具调用去重/防死循环（`soul/toolset.py`）

- 同 step 内相同 (tool, canonical_args)（JSON 键排序规范化 + sha256 8 字符 hash）→ 等待原任务并复制结果（`dup_type="same_step"`）
- 跨 step 重复：渐进式 `<system-reminder>`（streak≥3 提示换法、≥5 列出重复计数、≥8 强提醒、**≥12 强制停止 turn**，`force_stop_turn` → `stop_reason="tool_call_repeat"`）
- 钩子集成：PreToolUse（可 block）→ 执行 → PostToolUse / PostToolUseFailure（fire-and-forget）

### 4.6 会话/上下文存储格式（`context.jsonl`）

- 每行一个 JSON：正常行 = kosong `Message`（pydantic 校验，坏行跳过）；特殊行 `{"role":"_system_prompt"}` / `{"role":"_usage","token_count"}` / `{"role":"_checkpoint","id"}`
- 恢复时按行重建 history + token 计数 + checkpoint 号；系统提示词缺省时原子前置写入（临时文件替换）
- `Session.is_empty()`：无自定义标题、wire.jsonl 空、context 无实际消息（`_` 前缀 role 忽略）
- 旧版迁移：`<id>.jsonl` → `<id>/context.jsonl`；`metadata.json` → `state.json`；`config.json` → `config.toml`（备份 `.bak`）

### 4.7 LLM 重试与恢复（`soul/kimisoul.py` L1199-1773）

- `_kosong_step_with_retry`：tenacity `retry_if_exception(_is_retryable_error)`、`wait_exponential_jitter(initial=0.3, max=5, jitter=0.5)`、`stop_after_attempt(max_retries_per_step)`；每次重试前 `wire_send(StepRetry(...))` + 日志
- `_run_with_connection_recovery`：401（仅 OAuth provider）→ `ensure_fresh(force=True)` → 递归重试；`APIConnectionError/APITimeoutError` → `RetryableChatProvider.on_retryable_error()` 恢复 → 递归重试（`_kimi_recovery_exhausted` 标记防无限）
- 错误遥测：`classify_api_error` 分类表 + `is_retryable_api_error`（含 408/409/529，与 TS 端对齐）

### 4.8 动态注入（`soul/dynamic_injection.py` + `dynamic_injections/`）

- `DynamicInjectionProvider` 协议：`get_injections(history, soul)` / `on_context_compacted()` / `on_afk_changed()`
- `PlanModeInjectionProvider`：plan 模式下每 5 个 assistant turn 注入一次提醒（每 5 次一版完整指令），内容含 "You MUST NOT make any edits (with the exception of the plan file)"、"Your turn must end with either AskUserQuestion or ExitPlanMode"、多方案约束等；手动切换触发一次性激活提醒
- `AfkModeInjectionProvider`：afk 开启时注入一次（"Do NOT call AskUserQuestion..."），压缩/开关后重新武装
- 注入以 user 消息 + `<system-reminder>` 形式写入历史

### 4.9 Plan 模式实现链

- 状态：`KimiSoul._plan_mode` + `session.state.plan_mode/plan_session_id/plan_slug`（持久化、恢复）
- plan 文件：`~/.kimi/plans/<slug>.md`，slug = 3 个随机漫威/DC 英雄名（`tools/plan/heroes.py`，如 iron-man-spider-man-thor）
- 工具绑定（`_bind_plan_mode_tools`）：WriteFile/StrReplaceFile 挂 checker+path_getter（plan 文件免审批）；EnterPlanMode/ExitPlanMode 挂 toggle 回调；AskUserQuestion 挂 afk 检查
- 审批：`ExitPlanMode` 读 plan 文件 → `PlanDisplay` wire 事件 → `QuestionRequest`（Approve / 各方案选项 / Reject / Reject and Exit / Revise 自由文本）→ 批准后退出 plan 模式并注入 "Execute ONLY the selected approach" 指令
- 能力门控：wire 客户端需声明 `supports_plan_mode` 才暴露工具；yolo 自动批准进入、afk 连退出也自动批准

### 4.10 后台任务与通知（`background/` + `notifications/`）

- `BackgroundTaskManager.create_bash_task`：写 task 目录（`~/.kimi/tasks/` 待验证具体路径，`background/store.py`），spawn `kimi __background-task-worker` 子进程执行；心跳/失活检测；`TaskView` 状态机
- 完成通知：`NotificationManager` 按 sink（llm/wire/shell）投递；LLM sink 在下一步 `_step` 开头投递（limit 4），注入为 user 消息（"Background tasks have completed..."）
- Shell 空闲时 `_BackgroundCompletionWatcher` 监听完成事件自动触发新 turn（用户输入优先，`_BG_AUTO_TRIGGER_INPUT_GRACE_S=0.75s`）
- `Agent` 工具 `run_in_background=true` → `BackgroundAgentRunner`（后台 agent 子进程，`agent_task_timeout_s` 默认 900s）

### 4.11 Hook 引擎（`hooks/engine.py`）

- 索引：event → hooks（server shell 命令）/ wire 订阅；matcher 正则匹配（`re.search`，坏正则告警跳过）
- 并行执行 `asyncio.gather`；聚合规则：任一 `block` 即 block（首个 reason）；异常 fail-open
- `HookTriggered/HookResolved` wire 事件；`HookRequest` 客户端响应超时默认 allow

### 4.12 配置与密钥存储（安全相关见 §5）

- 配置文件：`~/.kimi/config.toml`（默认）；`KIMI_SHARE_DIR` 可改根目录；`--config <toml/json 字符串>` / `--config-file`
- 结构：`default_model`、`default_thinking`、`default_yolo`、`default_plan_mode`、`skip_afk_prompt_injection`、`default_editor`、`theme`、`show_thinking_stream`、`models{}`（provider/model/max_context_size/capabilities/display_name）、`providers{}`（type/base_url/api_key/env/custom_headers/reasoning_key/oauth ref）、`loop_control`（§2.4）、`background`（§2.14）、`notifications`、`services.moonshot_search/moonshot_fetch`、`mcp.client.tool_call_timeout_ms`、`hooks[]`、`merge_all_available_skills`、`extra_skill_dirs`、`telemetry`
- API key：`SecretStr` 存 config；OAuth token 存 `~/.kimi/credentials/<key>.json`（带 `.lock` 文件；**keyring 已弃用**，启动自动迁移 `keyring→file`，`oauth.py` L425-443）；`/login`（别名 `/setup`）设备码流程 + 平台选择（Kimi Code OAuth / 其他平台输 key）

### 4.13 Agent 规格（`agentspec.py` + YAML）

- agent.yaml：`system_prompt_path`（Jinja2 模板，`${VAR}` 语法，StrictUndefined）、`tools[]`、`subagents{}`（coder/explore/plan）；coder.yaml 可 `extend`、`allowed_tools`/`exclude_tools`（ToolPolicy allowlist）
- 内置系统提示词变量（`BuiltinSystemPromptArgs`）：KIMI_NOW/KIMI_WORK_DIR/KIMI_WORK_DIR_LS/KIMI_AGENTS_MD/KIMI_SKILLS/KIMI_ADDITIONAL_DIRS_INFO/KIMI_OS/KIMI_SHELL
- `--agent default|okabe` / `--agent-file` 自定义；`okabe` 为彩蛋人格（启用 Agent/SendDMail 等全工具）

---

## 5. 安全模型

### 5.1 审批分类（读/写/网络/危险）

| 类别 | 工具/动作 | 是否需审批 |
|---|---|---|
| 读（本地） | ReadFile / ReadMediaFile / Glob / Grep | **免审批** |
| 读（网络） | SearchWeb / FetchURL | 免审批（API 后端转发，不直接执行） |
| 写（工作区内） | WriteFile / StrReplaceFile → `edit file` | 审批（diff 预览） |
| 写（工作区外） | 同上 → `edit file outside of working directory` | 审批（单独 action 名，可被 `approve_for_session` 分别缓存） |
| 执行 | Shell → `run command` | 审批（命令预览）；`run background command` 独立 action |
| 危险操作 | TaskStop → `stop background task`；MCP 调用 → `mcp:<name>` | 审批 |
| 计划写入 | plan 文件（`~/.kimi/plans/*.md`） | 免审批（唯一可写文件） |

无 Claude Code 式基于指令的"危险命令"启发式拒绝——危险判定完全靠人工审批层 + hooks 可编程拦截 + plan 模式只读约束。`ToolRejectedError` 对子代理附加 "do not attempt to bypass this restriction through indirect means" 防绕过措辞。

### 5.2 作用域与危险操作判定

- 工作目录作用域：`is_within_workspace`/`is_within_directory`（`tools/utils.py`、`utils/path.py`）；`additional_dirs`（`/add-dir`、`--add-dir`，持久化）显式扩展可访问目录，写入系统提示词
- plan 模式：运行时按调用检查（工具不隐藏，`checker()` 在调用时拒绝并返回 ToolError），注入指令声明 "This supersedes any other instructions you have received"
- 敏感数据：`/import` 对敏感文件名（API key/token/凭据关键词，`utils/export.py is_sensitive_file`）告警；`/export` 提示文件可能含敏感信息
- 环境隔离：Windows 下 `rewrite_windows_null_redirect` 改写空重定向（`utils/shell_quoting.py`）；子进程 `get_noninteractive_env` 净化环境
- MCP：OAuth 服务器需显式 `kimi mcp auth`（未授权标记 unauthorized 不连接）；MCP 输出截断 100k 字符防上下文污染

### 5.3 密钥存储

- API key：`config.toml`（`SecretStr`，serializer 脱敏）；env 变量（`KIMI_API_KEY` 等在欢迎页只显示 `******`）
- OAuth token：`~/.kimi/credentials/<key>.json`（文件 + 锁文件；keyring 后端已废弃但保留迁移路径）；MCP OAuth：`~/.kimi/mcp-oauth/`
- 插件凭证注入：`collect_host_values` 向 plugin config 注入 api_key/base_url（启动时随 OAuth 刷新重注入）
- 日志：`~/.kimi/logs/kimi.log`（stderr 重定向进日志；用户可见错误走 `open_original_stderr`）

---

## 6. 独有特性清单

1. **Ralph 循环**（`--max-ralph-iterations`，`<choice>STOP</choice>` 终止的自动迭代）——同类 CLI 中独有的显式"目标循环"开关（Claude Code 是 `--max-turns` 硬限制，无自迭代语义）
2. **D-Mail 时间旅行**（SendDMail + checkpoint 回退，Steins;Gate 彩蛋命名；"denwa renji"=电话微波炉）——允许 agent 向自己的过去发消息并回滚上下文
3. **Agent/Shell 双输入模式**（Ctrl-X 把 CLI 当普通 shell 用）
4. **"/btw 侧问"**：不打断主对话的隔离问答（prompt cache 复用 + DenyAllToolset）
5. **统一 Wire 事件总线**：shell/print/acp/wire/web 四种 UI 全部基于同一协议（`wire_send` 即 "print/input for souls"），外部工具/钩子/审批/问题均可被客户端托管——协议完整度在同类中罕见
6. **后台任务系统**：独立 worker 子进程 + 心跳 + LLM 自动通知续跑 + 三栏任务浏览器 TUI
7. **Ralph 之外的 Flow Skills**：SKILL.md 内嵌 mermaid/d2 流程图，`/flow:<name>` 驱动多节点决策工作流
8. **跨品牌 Skills 兼容**：直接读取 `~/.claude/skills`、`~/.codex/skills`（`merge_all_available_skills` 默认合并）——与 Claude Code 生态互操作
9. **Plans 文件用漫威/DC 英雄 slug 命名**（`~/.kimi/plans/iron-man-spider-man-thor.md`）
10. **KAOS 远程执行**：工作目录可在 SSH 远程主机（本地/远程统一 `KaosPath` 抽象）
11. **Web UI + vis 可视化器**（FastAPI+React 双前端，`/web`、`/vis` 无缝切换）
12. **Soul 架构**：`Soul` protocol 使自定义 soul（examples/custom-kimi-soul、custom-echo-soul）可嵌入宿主应用
13. **会话级审批缓存持久化**："Approve for this session" 跨进程恢复
14. **managed 模型自动同步**：平台 `/models` 拉取刷新 config（`managed:` provider）
15. **工具调用防死循环渐进提醒**（3/5/8 级 reminder + 12 连强制停）
16. **退出码 75（EX_TEMPFAIL）** 可重试语义，专为 CI 脚本设计

---

## 7. 限制 / 短板

1. **官方日落**：项目正被 Kimi Code CLI（`moonshotai/kimi-code`）取代，新功能投入递减；`/upgrade` 甚至引导用户安装替代品
2. **无 [GOAL_DONE] 式目标状态机**：Ralph 循环只有 CONTINUE/STOP 二态，无显式 goal 注册/完成检测/多目标编排
3. **无 smart/auto 模型自动选择模式**（相对 Claude Code）；模型切换需手动 `/model`
4. **内置工具默认裁剪**：`Think`、`SendDMail` 在默认 agent 中注释关闭（需 okabe 人格或自定义 agent-file）
5. **Shell 模式能力有限**：不支持内置 `cd` 等（README 明示）；每条命令独立环境
6. **D-Mail 不恢复文件系统状态**（代码 TODO 明示）
7. **压缩算法简单**：只保留最后 2 条消息 + LLM 摘要（无结构化记忆/长期记忆）；token 估算为字符启发式（CJK 低估，代码注释自述）
8. **无 git 集成层**：不像部分 CLI 内置 commit/rebase 工作流（需 skill/AGENTS.md 补足；`.agents/skills/pull-request` 等官方 skill 存在但非内置）
9. **审批无基于命令内容的危险启发式**：全靠人工 + hooks；"edit file outside" 与工作区内共用 diff 面板，依赖用户眼力
10. **ACP `--acp` 已弃用**；wire 协议仍标 experimental（部分能力需能力协商）
11. **Python 分发**：依赖较重（aiohttp/pydantic/rich/prompt-toolkit 全家桶），启动速度与二进制体积（PyInstaller）不如 Go/Rust 同类（官方因此另出 Rust 版 `kimi-agent-rs` 仅支持 wire 模式）
12. **遥测默认开启**（可关）；日志含 stderr 重定向 hack（fd=2 dup2）
13. **规模复杂度高**：835 个 open issues；多系统（soul/wire/acp/web/vis/background/notifications）叠层，学习成本高

---

## 8. 与"一般 agentic CLI"相比的差异亮点

| 维度 | Kimi CLI | 一般 agentic CLI（Claude Code/Codex/Gemini CLI 等） |
|---|---|---|
| 循环设计 | ①step 循环（每 turn 上限 1000）②Ralph 目标循环（同一 prompt 自迭代，`<choice>STOP</choice>`）③Flow 图工作流（mermaid/d2）——**三层嵌套** | 通常只有单层 tool-use 循环 + 硬 max-turns |
| 时间旅行 | D-Mail + checkpoint 回退（上下文旋转恢复） | 多数只有 /undo 重放或不可回滚 |
| UI 质感 | prompt-toolkit 全自定义：流式审批面板、多 tab 问题面板、/btw 模态、三栏任务浏览器、粘贴占位符折叠、状态栏徽章体系 | rich/textual 或 ink/react 单栏；交互模态较少 |
| 人格/命名 | "Soul" 抽象 + 可插拔人格（okabe 彩蛋）；Slack 式营销文案（"You only live once!"）；hero 命名 plan 文件 | 多为中性系统提示词 |
| 协议完备度 | Wire（1.10）暴露全部内部事件/请求，外部工具+钩子+审批+问题全托管；ACP 开箱；Web+vis 双前端 | 多数仅 ACP 或专有 MCP 化接口 |
| 后台任务 | 独立 worker 子进程 + 心跳 + 完成通知自动驱动新 turn + LLM 可见通知消息 | 多为前台阻塞或简单 nohup |
| 生态互操作 | 直接复用 Claude/Codex skills 目录；MCP 标准接入；zsh 插件；VS Code 扩展 | 各自封闭 skill 格式 |
| 模型层 | 自研 kosong 库（多 provider + 能力门控 + 提示缓存优先设计）+ 平台 managed 模型同步 + KAOS 远程执行 | provider 抽象通常内嵌，无远程执行 |
| 自动化 | `--print` + stream-json 双向 + 退出码 75 重试语义 + `--quiet` | 多数有 --print 但退出码语义粗糙 |

**最独特的三个机制**：(1) Ralph 循环——把"反复喂养同一 prompt"做成一等公民配置；(2) D-Mail checkpoint 时间旅行；(3) 基于统一 Wire 事件总线的四 UI（shell/print/acp/wire）+ 外部客户端全托管（工具/钩子/审批/结构化问题）。

---

## 附：待验证项

- `background/store.py` 后台任务目录的具体磁盘路径（实现细节未逐行核对）
- `kimi term`（Toad TUI，`cli/toad.py`）为 `batrachian-toad` 第三方 TUI 的透传，未展开
- `web/`、`vis/` 前端源码（React）未逐文件阅读，仅依据后端 API 与目录结构描述
- kimisoul 中 `loop_control` 各字段与 CLI flag 的完整别名矩阵（`max_steps_per_run` 等 alias）以源码为准
- `agents/okabe` 完整人格文本未摘录（仅确认工具清单为全量+SendDMail/Think 开启）
