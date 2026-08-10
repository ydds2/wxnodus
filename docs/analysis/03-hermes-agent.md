# 03. Nous Research Hermes Agent 构造与代码设计分析

> 分析对象：https://github.com/NousResearch/hermes-agent（默认分支 `main`，分析日 2026-08-09）
> 方法：GitHub REST API（仓库元信息 + 9677 条完整文件树）+ raw.githubusercontent.com 源码抓取 + WebFetch README。
> 聚焦范围：agentic CLI/交互层（gateway / tui_gateway / ui-tui / hermes_cli / tools 权限），不覆盖全部平台功能。
> 文件路径均相对仓库根；「待验证」= 源码未能直接确认。

---

## 1. 定位与架构总览

### 1.1 平台形态

Hermes Agent 是 **「单一 agent 内核 + 多端 UI + 消息平台网关」** 的大型自进化 agent 平台（Nous Research，MIT）：

- **Agent 内核**（Python）：`agent/`、`tools/`、`toolsets/`、`providers/`、`skills/` —— 会话循环、工具执行、委派、记忆、压缩、审批、权限。
- **CLI**（Python + prompt_toolkit）：`hermes_cli/main.py`（515KB）为主入口，`hermes` 命令体系。
- **TUI**（React 19 + 自研 Ink fork `@hermes/ink`，TypeScript 管屏幕、Python 管逻辑）：`ui-tui/`（客户端）+ `tui_gateway/`（服务端，stdio JSON-RPC）。
- **桌面端**：`apps/desktop/`（Electron，v0.17.0）+ `apps/bootstrap-installer/`（Tauri 安装器）。
- **Web 端**：`web/`（Vite React，@nous-research/ui）。
- **消息网关**：`gateway/` —— 单进程对接 Telegram / Discord / Slack / WhatsApp Cloud / Signal / 微信 / 元宝(Yuanbao) / BlueBubbles / Email 等（`gateway/platforms/`）。
- **ACP 适配器**：`acp_adapter/`（Agent Client Protocol 服务端，106KB server.py）。
- 其他：`cron/`（定时任务）、`plugins/`（插件 SDK：memory、kanban、achievements、platforms/a2a 等）、`evals/`、`tests/`（大量）。

### 1.2 仓库规模

| 项 | 值 |
|---|---|
| stars / forks | 228,403 / 44,920 |
| 语言 | Python（4004 个 .py，约 61MB）+ TypeScript（2062 个 .ts/.tsx，约 16MB） |
| 仓库 size | 646,279 KB（含历史）；当前树文件 8722 个、总字节 141.7MB |
| 顶层目录 | agent, gateway, tui_gateway, hermes_cli, ui-tui, apps, web, tools, toolsets, skills, optional-skills, plugins, providers, acp_adapter, cron, evals, docs, nix, docker |

巨型单文件是常态：`gateway/run.py`（1.35MB）、`hermes_cli/web_server.py`（714KB）、`tui_gateway/server.py`（595KB）、`agent/auxiliary_client.py`（457KB）、`agent/conversation_loop.py`（436KB）——即 README 自己承认的 "god-file decomposition" 正在进行中（`gateway/slash_commands.py` 头部注释明确写着从 run.py Phase 3b 拆出）。

### 1.3 三层结构（交互层 / 内核层 / 工具层）

```
交互层（UI 侧）            ui-tui/ (React+Ink TUI 客户端)  apps/desktop/  web/  apps/shared/src/json-rpc-gateway.ts
交互层（协议服务端）        tui_gateway/ (server.py 595KB + methods_*.py, stdio/WS JSON-RPC)
                          hermes_cli/ (CLI 本体 + 命令注册 + config/skin/clipboard)
                          gateway/ (消息平台网关: run.py + slash_commands.py + session.py + platforms/)
内核层                    agent/ (conversation_loop, auxiliary_client, prompt_builder, memory_manager,
                          redact, context_compressor, subagent_lifecycle …)
工具层                    tools/ (approval.py, delegate_tool.py, terminal_tool.py, mcp_tool.py,
                          file_operations.py, registry.py …), toolsets/, skills/, plugins/, providers/
```

核心分层原则（`gateway/stream_events.py` 模块 docstring）：**agent 发"结构化事件"（只描述发生了什么），gateway/平台适配器决定"如何投递/渲染"**——"smart agent emits structured data, smart gateway decides delivery"。事件只描述传输、永不进入会话历史（history 由 agent 独占，展示层流只是呈现）。

---

## 2. 全量功能清单

### 2.1 交互协议：RPC 方法全表

**传输**：JSON-RPC 2.0，TUI 走 newline-delimited JSON over stdio（`ui-tui/src ↔ tui_gateway/entry.py`），桌面/Web 走 WebSocket（`tui_gateway/ws.py`），同一 dispatcher 两种传输（`tui_gateway/transport.py`）。请求 `{jsonrpc:"2.0", id, method, params}`；事件帧 `{method:"event", params:{type, payload, session_id, profile}}`（`apps/shared/src/json-rpc-gateway.ts`）。

以下 135 个 `@method(...)` 方法从 `tui_gateway/server.py`（595KB）+ `methods_session.py` + `methods_tools.py` + `methods_prompt.py` + `methods_config.py` + `methods_complete.py` 源码提取：

**会话（methods_session.py）**
`session.activate` `session.active_list` `session.branch` `session.close` `session.compress` `session.context_breakdown` `session.create` `session.cwd.set` `session.delete` `session.history` `session.interrupt` `session.list` `session.most_recent` `session.redirect` `session.resume` `session.save` `session.status` `session.steer` `session.title` `session.undo` `session.usage` `session.workspace.move`

**委派 / 子代理（methods_session.py）**
`spawn_tree.list` `spawn_tree.load` `spawn_tree.save` `subagent.interrupt` `subagent.steer` `delegation.pause` `delegation.status` `handoff.request` `handoff.state` `handoff.fail`

**提示输入（methods_prompt.py）**
`prompt.submit` `prompt.background` `clipboard.paste` `file.attach` `image.attach` `image.attach_bytes` `image.detach` `pdf.attach` `input.detect_drop` `paste.collapse`

**审批 / 询问 / 敏感输入（methods_prompt.py）**
`approval.respond` `clarify.respond` `secret.respond` `sudo.respond` `preview.read.respond` `preview.restart` `terminal.read.respond` `window.read.respond`

**配置 / 设置（methods_config.py）**
`config.get` `config.set` `config.show` `setup.status` `setup.runtime_check` `projects.discover_repos` `projects.project_sessions` `projects.record_repos` `projects.tree`

**补全 / 模型（methods_complete.py）**
`complete.path` `complete.slash` `model.options` `model.disconnect` `model.save_key`

**工具 / 命令（methods_tools.py）**
`tools.configure` `tools.list` `tools.show` `toolsets.list` `shell.exec` `cli.exec` `command.dispatch` `command.resolve` `commands.catalog` `slash.exec` `browser.manage` `cron.manage` `insights.get` `learning.delete` `learning.detail` `learning.edit` `learning.frames` `plugins.list` `plugins.manage` `process.kill` `process.list` `process.stop` `reload.env` `reload.mcp` `rollback.diff` `rollback.list` `rollback.restore` `skills.manage` `skills.reload` `system.battery` `voice.record` `voice.toggle` `voice.tts` `wake.feed` `wake.pause` `wake.resume` `wake.start` `wake.status` `wake.stop`

**计费 / 订阅（methods_session.py）**
`billing.auto_reload` `billing.charge` `billing.charge_status` `billing.state` `billing.step_up` `subscription.change` `subscription.preview` `subscription.resume` `subscription.state` `subscription.upgrade` `usage.bars`

**其他（methods_session.py / server.py）**
`message.react` `llm.oneshot` `pet.cancel` `pet.cells` `pet.disable` `pet.export` `pet.gallery` `pet.generate` `pet.generate.status` `pet.hatch` `pet.info` `pet.info.meta` `pet.remove` `pet.rename` `pet.scale` `pet.select` `pet.thumb` `project.facts` `terminal.resize` `verification.status`

### 2.2 事件流：事件类型全表

**TS 协议契约枚举**（`apps/shared/src/json-rpc-gateway.ts` `GatewayEventName`）：
`gateway.ready` `session.info` `message.start` `message.delta` `message.interim` `message.complete` `thinking.delta` `reasoning.delta` `reasoning.available` `status.update` `tool.start` `tool.progress` `tool.complete` `tool.generating` `clarify.request` `approval.request` `sudo.request` `secret.request` `background.complete` `error` `skin.changed`

**TUI 客户端实际消费的事件 + payload**（`ui-tui/README.md` "Event surface" 表）：
`notification.show {id,key,kind,level,text,ttl_ms?}` `notification.clear {key}` `sudo.expire` `secret.expire`（超时清除）、`subagent.spawn_requested {subagent_id?,task_index,goal?,depth?,parent_id?}` `subagent.start` `subagent.thinking` `subagent.tool` `subagent.progress` `subagent.complete {status,summary?,text?,duration_seconds?}`、`review.summary`、`browser.progress`、`voice.status`、`voice.transcript`、`billing.step_up.verification {verification_url,user_code}`、`gateway.stderr`、`gateway.protocol_error`、`gateway.start_timeout`。

**server.py 侧发送事件**（源码 grep）：`agent.reasoning_effort` `agent.service_tier` `input.request` `session.reclaimed` `session.active_list` `session.branch` `session.compress` `session.info` `session.list` `session.resume` `session.status` `session.title` `session.usage` `tool.output_risk` `tool.started`。

**agent→gateway 内部流事件**（`gateway/stream_events.py`，7 个 frozen dataclass 的显式 Union）：`MessageChunk`（流式文本 delta）、`MessageStop {final}`（消息段结束，final 才代表整轮结束）、`Commentary`（工具迭代间的完整 interim 消息）、`ToolCallChunk {tool_name,preview,args,index}`（index 单调递增用于关联 start/finish）、`ToolCallFinished {tool_name,duration,ok,index}`、`LongToolHint`（工具超时的一次性 onboarding 提示）、`GatewayNotice {kind,text,extra}`（restart/online/long_run）。

**委派进度事件**（`tools/delegate_tool.py` `DelegateEvent` 枚举）：`delegate.task_spawned` `delegate.task_progress` `delegate.task_completed` `delegate.task_failed` `delegate.task_thinking` `delegate.tool_started` `delegate.tool_completed`（legacy 名 `_thinking`/`tool.started`/`tool.completed`/`subagent_progress` 经 `_LEGACY_EVENT_MAP` 归一化；TASK_SPAWNED/COMPLETED/FAILED 预留未发射）。

### 2.3 slash 命令全表

**CLI/TUI 命令注册表**（`hermes_cli/commands.py`，`COMMAND_REGISTRY` 共 95 个 `CommandDef`）：`agents` `approvals` `approve` `background` `battery` `blueprint` `branch` `browser` `bundles` `busy` `clear` `commands` `compress` `config` `context` `copy` `cron` `curator` `debug` `deny` `diff` `egress` `export` `fast` `focus` `footer` `goal` `handoff` `hatch` `heartbeat` `help` `history` `image` `import` `indicator` `init` `insights` `journey` `kanban` `learn` `memory` `moa` `model` `new` `paste` `pause` `personality` `pet` `platform` `platforms` `plugins` `profile` `prompt` `queue` `quit` `reasoning` `redraw` `refine` `reload` `restart` `resume` `retry` `rollback` `save` `sessions` `sethome` `skills` `skin` `snapshot` `start` `status` `statusbar` `steer` `stop` `subgoal` `subscription` `suggestions` `timestamps` `title` `tools` `toolsets` `topic` `topup` `undo` `update` `usage` `verbose` `version` `voice` `wake` `whoami` `yolo`（另有 `/exit` `/v` `/q` `/bg` 等别名）。

**gateway 消息端命令**（`gateway/slash_commands.py` `GatewaySlashCommandsMixin`，42 个 `_handle_*_command`）：`/new` `/reset` `/model` `/usage` `/compress` `/undo` `/retry` `/stop` `/status` `/help` `/commands` `/approve` `/deny` `/yolo` `/verbose` `/fast` `/reasoning` `/voice` `/topic` `/title` `/personality` `/profile` `/platform` `/sethome` `/sessions` `/resume` `/restart` `/update` `/version` `/agents` `/background` `/branch` `/refine` `/subgoal` `/goal` `/insights` `/memory` `/skills` `/reload-mcp` `/reload-skills` `/rollback` `/diff` `/footer` `/heartbeat` `/kanban` `/debug` `/bundles` `/codex-runtime` `/approvals` `/whoami` `/topup`。

**TUI 客户端本地命令**（`ui-tui/src/app/slash/`，core/billing/session/ops/credits/setup/debug 六个模块）：`/help` `/quit` `/update` `/clear` `/density` `/copy` `/paste` `/details` `/statusbar` `/queue` `/logs` `/history` `/save` `/undo` `/retry` `/steer` `/mouse` `/status` `/title` `/fortune` `/redraw` `/terminal-setup` `/billing` `/model` `/sessions` `/background` `/image` `/personality` `/compress` `/branch` `/voice` `/skin` `/indicator` `/yolo` `/reasoning` `/fast` `/busy` `/verbose` `/usage` `/stop` `/reload-mcp` `/reload` `/browser` `/rollback` `/agents` `/replay` `/replay-diff` `/skills` `/reload-skills` `/plugins` `/tools` `/credits` `/setup` `/heapdump` `/mem`。**未匹配的命令落到 Python**：`slash.exec` → `command.dispatch`（别名/插件/skills/注册表命令由 Python 拥有，TUI 不复制逻辑）。

### 2.4 会话 / 委派（spawn）

- **delegate_task 工具**（`tools/delegate_tool.py`，192KB）：`goal` + `context` + `tasks[]`（每项可带 `role: leaf|orchestrator`、`output_schema` JSON Schema 校验 + 一次有界纠错重试）；子代理获得**全新会话**（无父历史）、独立 task_id/终端/file ops cache、继承父 toolset 但剔除 `DELEGATE_BLOCKED_TOOLS = {delegate_task, clarify, memory, send_message, cronjob}`（禁递归、禁交互、禁共享记忆写、禁跨平台副作用、禁代父调度）；父上下文只见委派调用与摘要结果。
- **并发上限**：`delegation.max_concurrent_children` / `max_spawn_depth`，通过 `dynamic_schema_overrides` 在每次 `get_definitions()` 时把真实上限写进工具描述。
- **子代理审批**：子代理跑在 ThreadPoolExecutor worker 线程，通过 `ThreadPoolExecutor(initializer=_set_subagent_approval_cb)` 安装非交互回调——`delegation.subagent_auto_approve=false`（默认）→ `_subagent_auto_deny`（自动拒绝危险命令，安全默认）；`true` → `_subagent_auto_approve`（cron/batch 的 opt-in YOLO）。均打 audit warning。
- **公共生命周期 API**（`agent/subagent_lifecycle.py`）：插件安全边界，`PUBLIC_CONTRACT_VERSION=1`；`SubagentState` 9 态（PENDING/STARTING/RUNNING/SUCCEEDED/FAILED/INTERRUPTED/CANCEL_REQUESTED/CANCELLED/UNKNOWN）；`SubagentLaunchRequest{goal,context,role,model,allowed_toolsets,blocked_tools,working_directory,parent_session_id,correlation_id}`；限制 `_MAX_GOAL_CHARS=16k`、`_MAX_CONTEXT_CHARS=32k`、`_MAX_RESULT_CHARS=32k`、terminal 保留 1h。
- **spawn tree 持久化**（`tui_gateway/server.py` + `methods_session.py`）：`$HERMES_HOME/spawn-trees/<session_id>/<YYYYMMDDTHHMMSS>.json`，payload `{session_id, started_at, finished_at, label, subagents: [...]}`；每会话 append-only 索引 `_index.jsonl`（一行一个轻量元数据），`spawn_tree.list` 优先读索引、`cross_session=true` 可跨会话扫描，`spawn_tree.load` 做路径穿越防护（resolve 后校验 root 前缀）。
- **/replay**：TUI 侧 `spawnHistoryStore.ts` 内存环形缓冲（最近 10 个已完成子代理 fan-out 快照），回合结束时填充，供 `/replay`（回放）与 `/replay-diff`（diff 查看）使用。

### 2.5 审批 / 权限

- **审批生命周期**（`tui_gateway/server.py`）：`_block(event, sid, payload, timeout=300)` 生成 `request_id`（uuid 前 8 位）+ `threading.Event`，注册到 `_pending`，发射 `approval.request` 事件阻塞等待；客户端 `approval.respond {request_id, answer}` 经 `_respond()` 写 `_answers` 并 set Event；超时后对 secret/sudo/clarify/terminal.read/preview.read/window.read 发射 `*.expire` 通知（`allow_expired=True` 时迟到响应返回 `{status:"expired"}` 而不是 4009）。
- **approval.request payload 的 choices 推导**（`_emit_approval_request`）：`smart_denied` → `["once","deny"]`；`allow_permanent=false` → `["once","session","deny"]`；否则 → `["once","session","always","deny"]`。发送前用 `_redact_approval_command` 对原始命令做凭据脱敏（Tirith 标记的 credential-shaped 内容不回显）。
- **平台网关侧**：`tools/approval.py`（203KB）每会话审批队列；`HERMES_GATEWAY_SESSION=1` + `HERMES_EXEC_ASK=1` 环境变量把审批从 CLI `input()` 路由到网关回调。
- **红黄线**：见 §5。

### 2.6 工具系统

`tools/registry.py`（注册表）、`toolsets/`（工具集分组，`validate_toolset`）、`tools/tool_guardrails.py`（工具调用护栏）、`agent/tool_executor.py`（111KB 执行器）、`agent/file_safety.py`（写入安全，`file_safety` 测试覆盖 sandbox mirror / credentials / cross-profile）、`tools/url_safety.py`（URL 安全，SSRF 防护）、`tools/terminal_tool.py`（168KB 终端）、`tools/file_operations.py`、`tools/browser_tool.py`、`tools/mcp_tool.py`（339KB）、`tools/skills_tool.py`、`tools/write_approval.py`（写审批）、`tools/working_diff.py`、`tools/threat_patterns.py`、`tools/tirith_security.py`（Tirith 敏感数据检测）、`tools/self_repo_guard.py`、`tools/schema_sanitizer.py`。工具 schema 通过 `dynamic_schema_overrides` 支持每调用动态改写。

### 2.7 MCP

`tools/mcp_tool.py`（339KB 单文件客户端）、`hermes_cli/mcp_config.py`（配置）、`mcp_catalog.py`（目录）、`mcp_picker.py`、`mcp_security.py`（安全审查）、`mcp_startup.py`（后台发现线程，`wait_for_mcp_discovery`）、`tools/mcp_oauth.py` + `mcp_oauth_manager.py`（OAuth 流）、`mcp_stdio_watchdog.py`、`mcp_schema_cache.py`；运行时 `reload.mcp` 方法热重载，`gateway.reload_mcp.added/removed/reconnected/tools_available` 事件；UI 侧 `useConfigSync.ts` 轮询 config mtime 触发 MCP reload。

### 2.8 Skills

`skills/`（内置）+ `optional-skills/`；`agent/skill_commands.py`、`skill_utils.py`、`skill_bundles.py`、`tools/skills_hub.py`（181KB 技能市场）、`tools/skills_guard.py`、`skills_ast_audit.py`、`skill_linter.py`、`skill_provenance.py`、`skills_sync_client.py`；命令 `/skills` `/reload-skills` `skills.manage` `skills.reload`；agentskills.io 标准兼容（README 声明）。

### 2.9 记忆 / 知识

`agent/memory_manager.py`（MemoryManager 单集成点，**同一时刻只允许一个外部 provider**，防 schema 膨胀；prefetch_all → sync_all → queue_prefetch_all 回合前后钩子）、`agent/memory_provider.py`（Provider 抽象）、`plugins/memory/`（Hindsight / Honcho 后端 + config_schema）、`agent/learning_graph.py`（学习图）、`learning.frames/detail/edit/delete` 方法、`agent/insights.py`、FTS5 会话搜索 + LLM 摘要（README）、`/memory` 命令。

### 2.10 配置

- `hermes_cli/config.py`（230KB）+ `config_defaults.py`（240KB）+ `config_migrations.py`（迁移）——YAML 配置中心。
- RPC：`config.get`（TUI 启动时 `config.get full`，之后 5s 轮询 config mtime）、`config.set {key,value}`（`key="model"` 时若会话正在跑则**不拒绝**，而是 stash 到 `session["pending_model_switch"]` 下一轮开始时应用——4009 曾用于此场景后被取消）。
- `gateway/config.py`（128KB）：消息网关配置（HomeChannel/Platform/PlatformConfig、profile_routing、multiplex）。
- `hermes_cli/profiles.py`（多 profile 隔离）+ `setup.py`。

### 2.11 模型 Provider 抽象

`providers/` + `agent/model_metadata.py`（147KB）、`model_catalog.py`、`model_switch.py`（146KB）、`model_setup_flows.py`、`agent/anthropic_adapter.py`（139KB）、`bedrock_adapter.py`、`vertex_adapter.py`、`gemini_native_adapter.py`、`codex_responses_adapter.py`、`codex_runtime.py`、`relay_runtime.py`（Nous Relay）、`agent/relay_llm.py`；`/model` 切换命令、`model.options` / `model.save_key` RPC。

### 2.12 非交互协议（脚本/自动化）

- **`-z` oneshot**（`hermes_cli/oneshot.py`）：`hermes -z "prompt"` 直接发最终文本到 stdout——无 banner/无 spinner/无 stderr 噪音；toolsets/rules/memory/AGENTS.md 与普通回合一致；**审批自动旁路**（`HERMES_YOLO_MODE=1`）；cwd 即用户当前目录。
- **会话导出**：`hermes_cli/session_export.py` + `session_export_md.py` / `session_export_html.py`；`main.py` 的 export 支持 `--format jsonl|md|qmd|html|trace`（trace 为 Claude Code 兼容 JSONL）。
- **`acp_adapter/`**：ACP（Agent Client Protocol）服务端，外部宿主（如 VS Code 类 IDE）可驱动 Hermes。
- **SSE/API**：`gateway/platforms/api_server.py`（336KB）提供 HTTP/SSE 事件流（`tests/gateway/test_api_server_*.py` 系列）；`hermes_cli/web_server.py`（714KB）dashboard + `/api/pty` 端点，`HERMES_TUI_SIDECAR_URL` 让 TUI 事件经 `TeeTransport` 镜像到 dashboard sidebar WebSocket。
- **cron**：`cron/` + `tools/cronjob_tools.py`，`delivery.py` 路由投递（显式目标 / 平台 home channel / 回源 / 本地文件）。

### 2.13 HUD / 状态栏

- `agent/battery.py` + `system.battery` RPC：psutil 读电池（memoise 8s），返回 `{available, percent, plugged, category}`（good/warn/bad/critical/dim），TUI 仅在启用电池指示器时轮询。
- `hermes_cli/status.py` + `focus_view.py` + `/statusbar` `/indicator` `/focus` 命令；`status.update {kind,text}` 事件驱动状态行。
- `ui-tui`：状态栏 + activity lane（工具进度 + reasoning 文本）；`useLongRunToolCharms.ts` 对 >8s 工具发射 ambient 活动消息。

### 2.14 辅助功能（剪贴板 / 拖放 / 语音）

- **剪贴板图片**：`hermes_cli/clipboard.py`（`has_clipboard_image` / `save_clipboard_image`）+ `clipboard.paste` RPC（存为 `clip_<ts>_<n>.png` 到会话 images 目录）；`/paste` 命令。
- **拖放检测**：`input.detect_drop` RPC 复用 CLI 的 `_detect_file_drop`（`cli.py`），把拖入文本解析成路径/图片，返回 `{matched, is_image, path, count, text}` 并写入 `session["attached_images"]`。
- **附件**：`image.attach` / `image.attach_bytes` / `pdf.attach`（校验 `%PDF-` magic、base64 校验、pdftoppm 渲染）/ `file.attach`（本地路径 → 若在 gateway 外则 data_url 解码写入 `attachments/` 目录——远程会话支持客户端磁盘文件）。
- **语音**：`voice.record/toggle/tts`、`wake.feed`（16kHz PCM base64）、`/voice`、`voice.status/transcript` 事件；`tools/voice_mode.py`、`wake_word.py`。
- **终端/窗口读取**：`terminal.read.respond`、`window.read.respond`、`preview.read.respond`（供 agent 读取 TUI 侧终端/窗口内容并请求审批）。

---

## 3. 场景覆盖

### 3.1 TUI 交互（主场景）
React+Ink 全键盘交互：队列输入（busy 时文字排队、`/queue`）、`!cmd` shell 直通、`{!cmd}` 内联插值、多行缓冲、`$EDITOR` 编辑（Ctrl+G）、tab 补全（`complete.slash`/`complete.path`，60ms 防抖）、approval/clarify/sudo/secret 四种模态 prompt（数字快选、`o/s/a/d` 快选）、resume 会话选择器、滚动保持选区锚点、Ink `Static` 渲染流式转写 + markdown 子集渲染 + ANSI 直通。

### 3.2 Web / 桌面端复用（协议化带来的）
同一 `JsonRpcGatewayClient`（`apps/shared/src/json-rpc-gateway.ts`）被 `ui-tui/src/gatewayClient.ts`、`web/src/lib/gatewayClient.ts`、`apps/desktop` 共用；服务端同一 dispatcher 走 stdio（`tui_gateway/entry.py`）或 WebSocket（`tui_gateway/ws.py`），`transport.py` 的 `StdioTransport`/`TeeTransport`/`WsPublisherTransport` 可组合。皮肤同一 YAML 推三端（见 §6）。

### 3.3 脚本 / 自动化
`-z` oneshot、cron 调度 + 多平台投递、`delegate_task` 批量并行（cron/batch 场景 `subagent_auto_approve=true`）、ACP 适配器（外部宿主）、SSE/API 流、会话导出 jsonl/trace。

---

## 4. 代码设计细节

### 4.1 gateway 协议设计

- **帧**：请求/响应 `{jsonrpc:"2.0", id, method, params}`；错误 `{error:{message}}`；事件 `{method:"event", params:{type, payload, session_id?, profile?}}`——事件是"带 type 的 params"，不占用 id 空间。
- **客户端**（`apps/shared/src/json-rpc-gateway.ts`）：`request(method, params, timeoutMs=120s, signal)`；pending Map（id→{resolve,reject,timer}）；`on(type)/onAny()/onState()` 三套订阅；连接状态机 `idle→connecting→open/closed/error`，connect 15s 超时（防 sleep/wake 后 composer 卡 "Starting Hermes..."）；请求 id 可配前缀（`r1, r2...`）。
- **服务端传输抽象**（`tui_gateway/transport.py`）：`Transport` Protocol（write/close），`contextvars.ContextVar` 绑定当前请求的 transport（handler 线程池里也能路由回正确 peer）；`StdioTransport` 对 peer-gone errno（EPIPE/ECONNRESET/EBADF/ESHUTDOWN+WSA 映射）返回 False 触发干净退出，其余 OSError/编码错误 re-raise 进 crash log；`TeeTransport` 主写 stdio + 次写 WS（sidecar 慢不阻塞主 IO）。
- **dispatcher**：`server.py dispatch()` 单入口，`@method("x.y")` 装饰器注册；`_ok(rid, payload)` / `_err(rid, code, msg)` 统一响应 shape。
- **synthetic_turn.py / turn_marker.py / loop_noise.py**：TUI 端合成回合、回合标记、噪声抑制等机制（待验证细节）。

### 4.2 错误码体系（tui_gateway 侧）

| 段 | 语义 | 例子 |
|---|---|---|
| 4000 | 必填参数缺失 | `subagents list required` |
| 4001 | session 状态错误 | `no active session` / `session not found` / `no session key for undo` |
| 4002 | 值错误 | `model value required` / `text is required` |
| 4003 | 类型错误 | `argv must be list[str]` |
| 4004 | 用法/空输入 | `usage: /focus [on\|off\|status]` / `missing prompt` / `draft expired — generate again` |
| 4006 | 只读约束 | `managed install — credentials are read-only` |
| 4007 | session 键缺失 | `session_key required` |
| 4008 | 状态前置 | `nothing to branch — send a message first` |
| **4009** | **busy / 无待决请求** | `session busy` / `subagent still running — wait for it to finish` / `no pending {key} request`（审批/询问迟到响应） |
| 4010 | agent 能力不足 | `agent does not support steer` / `...active-turn redirect` |
| 4014/4015/4017/4018/4020-4025 | 各类参数/前置校验 | voice 未开、base64 非法、PDF magic 错误、`no previous user message to retry` 等 |
| 4030 | llm.oneshot 参数 | `requires a template or instructions/input` |
| 4040 | 消息缺失 | `message not found in this session` |
| 4090/4130 | 其他 | （待验证） |
| 5000-5063 | 系统/运行时错误 | `agent initialization failed/timed out`、`command timed out (30s)`、`pdftoppm not installed`、`voice module not available`、`pet.rename failed`、`generation cancelled`、`shell.exec unavailable: approval safety module not importable` |

要点：**4xxx = 请求/会话语义错误，5xxx = 系统/运行时失败**；4009 同时承担 "busy 拒绝" 与 "无待决 prompt 请求" 双重语义；对 `allow_expired` 请求改发 `.expire` 事件而非 4009，避免客户端弹原始 JSON-RPC 字符串。

### 4.3 spawn tree 数据结构

```json
$HERMES_HOME/spawn-trees/<sanitized_session_id>/
  <YYYYMMDDTHHMMSS>.json   # {session_id, started_at, finished_at, label, subagents: [...]}
  _index.jsonl             # 每行 {path, session_id, started_at, finished_at, label, count}
```
`spawn_tree.save` 写快照 + 追加索引（索引丢了 list 会回退全目录扫描）；`spawn_tree.list {session_id, limit=50, cross_session}`；`spawn_tree.load` 做 `Path.resolve()` 后前缀校验防穿越。

### 4.4 审批请求-响应生命周期

```
agent 线程（worker）                  TUI 客户端                  
  _block("approval.request", ...)      
   ├─ rid = uuid4().hex[:8]            ← approval.request {request_id, command, description, allow_permanent?, choices}
   ├─ _pending[rid] = (sid, Event)    
   ├─ ev.wait(300s)  …阻塞…           → 用户 o/s/a/d 或回车选择
   │                                   → approval.respond {request_id, answer}
   │                                   → _respond(): _answers[rid]=answer; ev.set()
   ├─ 被唤醒，取 _answers.pop(rid)     
   └─ 超时 → 发 approval 无 expire（审批不设 expire，只对
      secret/sudo/clarify/terminal.read/preview.read/window.read 发 *.expire）
```
session.interrupt 通过 `_clear_pending(sid)` 只释放本会话的 prompt（防跨会话误取消）；shutdown 时 `_clear_pending(None)` 全部释放。

### 4.5 命令框架定义

`hermes_cli/commands.py` `CommandDef` 字段：`name` `description` `category`（"Session"/"Configuration"/"Info"/"Exit"/"TUI" 等）`aliases` `args_hint`（`<prompt>`/`[on|off|status]` 管道式子命令自动提取）`subcommands`（tab 补全）`cli_only` `gateway_only` `gateway_config_gate`（config dotpath 覆盖 cli_only）`busy_policy`（**"reject" | "dispatch" | "interrupt_then_dispatch"**）`busy_handler`（mid-run 专用处理器名）`execute`（指向 `hermes_cli/slash_exec.EXECUTORS` 的共享纯格式化器——同一命令在 CLI/gateway/TUI 三端得到一致的规范文本）。

派生查找：`COMMAND_REGISTRY → _COMMAND_LOOKUP`（名+别名，`resolve_command()` 大小写不敏感、可带可不带 `/`）、`COMMANDS`/`COMMANDS_BY_CATEGORY`（向后兼容扁平/分类 dict）、`SUBCOMMANDS`。**Guard-2 busy 分发**（`gateway/run.py:_dispatch_busy_slash_command`）：按 `busy_handler` 特殊表（start/stop/new/queue/steer/egress/goal）→ `busy_policy` dispatch 白名单 → 兜底 busy-reject 文案（`⏳ Agent is running — /<cmd> can't run …`），并解释"拒绝而非中断丢弃"的原因（Discord 注册命令若走 interrupt 会被安全网吞成零字符合法响应）。

### 4.6 事件缓冲 / 订阅机制

客户端：`eventHandlers: Map<type, Set<handler>>`，`on()` 返回退订函数；`onAny('*')` 全局；`pending: Map<id, PendingCall>` 带超时与 AbortSignal（abort 只删本地 pending，服务端取消是独立的协作 RPC）。服务端：`_sessions` dict + 每 session `history_lock`/`_metadata_message_count`，事件经 dispatcher emit；TUI 侧 `turnController.ts` 状态机类缓冲流式 delta、管理 tool/reasoning 状态、处理 interrupt 与 message.complete 转换；`turnStore.ts` nanostore 承载 streaming text/tools/reasoning/subagents/todos/activity trail。

---

## 5. 安全模型

### 5.1 HARDLINE 硬红线（`tools/approval.py`）

- **`HARDLINE_PATTERNS`**：**无条件阻断**的灾难级命令集合——"a floor below yolo"：无论 `--yolo`、gateway `/yolo`、`approvals.mode=off`、cron approve mode 都不可执行（灵感来自 Mercury Agent 的 permission-hardened blocklist，见 `tests/tools/test_hardline_blocklist.py` 的文档注释）。
- 覆盖：`rm -rf /` 全部拼写变体（`//`、`/.`、`/./`、`/..`、`/*`、`$HOME`、`~`、引号包裹 `rm -rf "/"`、`sudo rm -rf /`、`rm --recursive --force /`），以及受保护系统根 `_HARDLINE_SYSTEM_DIRS = /home /root /etc /usr /var /bin /sbin /boot /lib`（+`/*` 变体）。
- 检测锚定 `_CMDPOS`（行首/命令分隔符 `; && || |` 后/`$()`/反引号/sudo/env/exec 包装后）——只在实际是命令词时触发，`gh pr create --title "rm -rf /"` 这类**作为数据出现**的字符串不误杀。
- `detect_hardline_command()` / `check_all_command_guards()` / `check_dangerous_command()` / `detect_dangerous_command()` 为公开判定入口；`enable_session_yolo` / `disable_session_yolo` / `set_current_session_key`（ContextVar 会话键）管理 yolo 态。

### 5.2 DANGEROUS_PATTERNS 危险模式判定

正则模式表（`tools/approval.py` L693 起），每项 `(regex, description)`：`rm /` 根路径删除、`rm -r*` 递归删除（含 **operand 后置 flag** 变体 `rm build/ -rf`，port of openai/codex#33464，防 GNU rm 选项置换绕过；temper 规则：不能跨 `; | &` 命令分隔、不能跨引号、不能跨 `--` end-of-options）、Windows `cmd /c del|erase|rd|rmdir`、PowerShell `Remove-Item` 等。另有 `_check_sudo_stdin_guard`（sudo 从 stdin 读密码的守卫）、用户自定义 deny 规则（`_match_user_deny_rule`）、`_save_blocked_payload`（阻断 payload 留档审计）。`detect_dangerous_command` 内部有 `_command_parser_limit_exceeded` 与 `_shell_tokens_with_spans`（防超长/畸形命令绕过解析）。

### 5.3 密钥处理

- `agent/redact.py`（56KB）：凭据形状内容脱敏引擎（Tirith 检测 + 多 egress 传输脱敏，`#48456` 审批命令回显脱敏、`#50767` SSE/API 流）。
- `agent/credential_pool.py`（150KB）+ `credential_sources.py` + `credential_persistence.py`、`agent/secret_scope.py`（secret 作用域）、`hermes_cli/secrets_cli.py` + `secret_prompt.py` + `onepassword_secrets_cli.py`（1Password 集成）。
- `secret.request {prompt, env_var, request_id}` 事件 + `secret.respond` 掩码输入流。
- `tools/credential_files.py`、`agent/message_sanitization.py`、`tests/agent/test_file_safety_credentials.py` 等配套。

### 5.4 其他

`tools/url_safety.py`（URL/SSRF）、`agent/file_safety.py`（写路径白名单/沙箱镜像）、`hermes_cli/mcp_security.py`（MCP 服务器安全审查）、`tools/self_repo_guard.py`（保护仓库自身不被改）、`tools/skills_guard.py` + `skills_ast_audit.py`（技能代码审计）、`gateway/authz_mixin.py`（45KB 授权：身份校验/用户级访问控制）、`docs/security/network-egress-isolation.md`、`tools/tirith_security.py`（Tirith 敏感数据）。

---

## 6. 独有特性清单

1. **一套协议驱动四端 UI**：TUI（stdio）/ 桌面 Electron（WS）/ Web（WS）/ 消息平台网关（平台适配器）共用同一 JSON-RPC 事件协议与同一 skin。
2. **皮肤/主题 SDK 跨端**（`hermes_cli/skin_engine.py` + `apps/shared/src/skin.ts`）：单一 YAML（`~/.hermes/skins/*.yaml`）→ TUI（`fromSkin`→Ink Theme）/ Desktop（`skinToDesktopTheme`→CSS custom properties）/ CLI（Rich/prompt_toolkit）；经 `gateway.ready {skin}` / `skin.changed` / `config.get skin` 推送；含完整 diff 高亮 + 语法着色 token。
3. **spawn tree + /replay + /replay-diff**：子代理委派树持久化 + 最近 10 个 fan-out 快照回放。
4. **HUD 状态栏**：`system.battery` 轮询 + statusbar/indicator/focus 命令 + `status.update` 事件。
5. **delegate_task 并行 fan-out**：leaf/orchestrator 角色、output_schema 有界纠错、`delegate.*` 事件流、防递归工具黑名单。
6. **消息平台网关**：Telegram/Discord/Slack/WhatsApp/Signal/微信/元宝多平台，Slack 用 `!command` 前缀改写（`typed_command_prefix` 能力位），`delivery.py` 投递路由。
7. **学习闭环**：skills 自创建/自改进、learning graph、insights、Honcho 用户建模、会话搜索。
8. **TUI 侧边栏镜像**：`HERMES_TUI_SIDECAR_URL` + `TeeTransport` 把 stdio 事件 tee 到 dashboard WS。
9. **阻断式 prompt 桥**：approval/clarify/sudo/secret 统一 `_block()` 语义（Event + 超时 + expire 通知），四个共享生命周期。
10. **Hooks 系统**（`gateway/hooks.py`）：`~/.hermes/hooks/<name>/{HOOK.yaml, handler.py}` 动态发现，事件 `gateway:startup` `session:start/end/reset` `agent:start/step/end` `command:*`（通配），`emit_collect` 支持 allow/deny/rewrite 决策型 hook。
11. **ACP 适配器** + **-z oneshot** + **SSE/API**：多形态非交互接入。
12. **Pets / journey / goal / kanban / cron** 等扩展性玩法（pet 15 个 RPC 方法）。

---

## 7. 限制 / 短板

- **巨型单文件**：run.py 1.35MB、web_server.py 714KB、server.py 595KB——维护与 review 困难；god-file 分解（Phase 3b 等）仍在进行。
- **协议契约隐式化**：TS 侧 `GatewayEventName` 是手写字符串联合（`(string & {})` 兜底），Python 侧事件名散落 emit 调用点，**无共享 schema/代码生成**，两端靠测试对齐。
- **4009 语义双重**：busy 拒绝与"无待决请求"共用 4009，客户端需区分上下文。
- **文档不足**：README 以外 `docs/` 只有 6 个文件（design/kanban/middleware/observability/security），大量机制只存在于源码 docstring 与测试名中。
- **依赖平台特定能力**：消息端功能因平台渲染能力而异（iMessage 折叠 tool chrome，见 stream_events.py docstring），跨平台一致性靠适配器各自实现。
- **单仓库耦合**：agent 内核与 hermes_cli 互相 import（`from hermes_cli.config import …` 出现在 gateway 侧），模块边界靠约定。
- 部分机制标注待验证：`tui_gateway` 的 `synthetic_turn.py`/`turn_marker.py`/`loop_noise.py` 细节、`methods_tools.py` 中 `cron.manage`/`insights.get` 等方法的完整 payload、4090/4130 错误码语义。

---

## 8. 与我们参考点相关的结论（值得"抄"的 CLI UI 层设计）

按可移植性排序，这些机制名值得直接借鉴：

1. **`JsonRpcGatewayClient`**（`apps/shared/src/json-rpc-gateway.ts`）：事件/请求同帧协议、`on/onAny/onState` 三套订阅、pending 超时 + AbortSignal、连接状态机——多端复用的最小契约。
2. **`Transport` 抽象 + ContextVar 绑定**（`tui_gateway/transport.py`）：stdio/WS/tee 可组合、peer-gone errno 白名单判定干净退出——传输层与 handler 解耦的教科书写法。
3. **事件命名两段式**（`<域>.<名词>`：`message.delta`、`tool.complete`、`approval.request`）+ **事件帧 `{method:"event", params:{type,payload,session_id,profile}}`**——session_id 归属与 UI 来源标签（profile）直接进事件帧。
4. **`_block()` 阻断式 prompt 桥**：request_id + threading.Event + 超时 + `.expire` 通知 + 迟到响应返回 `{status:"expired"}` 而非 4009——阻塞式 UI 询问的通用生命周期。
5. **approval choices 推导**（once/session/always/deny 随 `allow_permanent`/`smart_denied` 变化）+ 审批命令发送前脱敏。
6. **`CommandDef` + busy_policy 三态**（reject/dispatch/interrupt_then_dispatch）+ `busy_handler` 特殊表 + Guard-2 统一 busy 分发——"agent 忙时命令怎么办"这一高频问题被框架化解决。
7. **`slash.exec` → `command.dispatch` 回退链**：客户端只实现高频命令，其余命令由服务端注册表裁决（别名/插件/技能），避免多端命令逻辑复制。
8. **spawn tree 持久化**：`spawn-trees/<session>/*.json + _index.jsonl` append-only 索引 + `cross_session` 扫描——委派历史的轻量审计式存储。
9. **`complete.slash` / `complete.path` 服务端补全** + 60ms 防抖——补全逻辑集中到服务端。
10. **`input.detect_drop` / `clipboard.paste` / `image.attach_bytes`**：输入法/粘贴/拖放全部协议化，客户端只传原始数据，服务端判定与落盘。
11. **skin YAML 单一来源跨端推送**（`gateway.ready {skin}` / `skin.changed`）——主题作为协议事件而非客户端配置。
12. **`system.battery` 惰性轮询 RPC**（仅在指示器启用时轮询 + 8s memoise）——HUD 数据的正确姿势。
13. **错误码分段**：4xxx 请求语义 / 5xxx 系统失败；busy 有专属码 4009。
14. **hooks 目录即插即用**（HOOK.yaml + handler.py + `command:*` 通配 + `emit_collect` 决策型）——扩展点无需改内核。

---

### 附录：关键文件索引

| 关注点 | 路径 |
|---|---|
| TS 协议契约 | `apps/shared/src/json-rpc-gateway.ts` |
| TUI 服务端（方法/事件/错误码/审批桥） | `tui_gateway/server.py` `methods_session.py` `methods_tools.py` `methods_prompt.py` `methods_config.py` `methods_complete.py` |
| 传输抽象 | `tui_gateway/transport.py` `ws.py` `event_publisher.py` `entry.py` |
| TUI 客户端（React+Ink） | `ui-tui/README.md` `ui-tui/src/app/`（turnController.ts、spawnHistoryStore.ts、slash/registry.ts） |
| 命令注册表 | `hermes_cli/commands.py` `hermes_cli/slash_exec.py` |
| 消息网关 | `gateway/run.py` `gateway/slash_commands.py` `gateway/session.py` `gateway/status.py` `gateway/platforms/base.py` |
| agent→gateway 事件词汇表 | `gateway/stream_events.py` |
| 审批/权限红线 | `tools/approval.py`（HARDLINE/DANGEROUS_PATTERNS）`tools/write_approval.py` |
| 委派 | `tools/delegate_tool.py` `tools/async_delegation.py` `agent/subagent_lifecycle.py` |
| clarify | `tools/clarify_tool.py` `tools/clarify_gateway.py` |
| 皮肤 | `hermes_cli/skin_engine.py` `apps/shared/src/skin.ts` |
| 剪贴板/拖放 | `hermes_cli/clipboard.py` `tui_gateway/methods_prompt.py`（input.detect_drop） |
| 电池 | `agent/battery.py` |
| 记忆 | `agent/memory_manager.py` `agent/memory_provider.py` `plugins/memory/` |
| hooks | `gateway/hooks.py` |
| 非交互 | `hermes_cli/oneshot.py` `acp_adapter/` `gateway/platforms/api_server.py` |
