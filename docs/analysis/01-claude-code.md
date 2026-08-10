# Claude Code（anthropics/claude-code）全量构造与代码设计分析

> 分析日期：2026-08-09（数据截至 Claude Code v2.1.226）
> 信息来源标注约定：
> - 【仓库】= 从 GitHub 仓库 anthropics/claude-code（main 分支）直接抓取的文件内容，可信度高
> - 【npm】= 从 npm registry 下载的 @anthropic-ai/claude-code@2.1.226 包内文件（含 150KB 的 `sdk-tools.d.ts` 官方 SDK 类型定义）
> - 【CHANGELOG】= 仓库内 CHANGELOG.md（359 个版本条目，0.2.21 → 2.1.226）
> - 【文档推断】= 官方文档站点（code.claude.com/docs）在本网络环境不可达，无法直接抓取，基于产品公开知识推断，字段名待验证

---

## 1. 定位与架构总览

### 1.1 形态

Claude Code 是 Anthropic 的终端 agentic 编程工具（README 原话："an agentic coding tool that lives in your terminal, understands your codebase, and helps you code faster..."）。产品矩阵（按官方表述）：
- **终端 CLI**（主形态，`claude` 命令）
- **IDE 嵌入**：官方 VS Code 扩展（v2.0 起为全新 native 扩展）、JetBrains 插件
- **GitHub 集成**：GitHub Action（`anthropics/claude-code-action@v1`），issue/PR 里 `@claude` 触发
- **Web/移动/桌面端**："Claude Code on the web"、Remote Control（从 Claude 移动/桌面 App 遥控终端会话）、`claude self-hosted-runner`（把自己的机器注册为云会话运行地）
- **SDK 形态**：Claude Agent SDK（TS/Python），headless 驱动 CLI 核心

### 1.2 运行时与分发方式

- **源码闭源**：CLI 本体是编译后的原生二进制（约 500MB，内嵌 Bun 运行时——CHANGELOG 明确出现 "Upgraded the bundled Bun runtime to 1.4"、`Bun.stripANSI` 等字样），不以源码形式发布。
- **npm 包已变成"壳"**【npm】：`@anthropic-ai/claude-code@2.1.226` 仅 7 个文件（166KB 解压）：`bin/claude.exe`（占位 stub）、`install.cjs`（postinstall 把平台专属二进制 hardlink/copy 到 `bin/claude.exe`）、`cli-wrapper.cjs`（回退启动器，`--ignore-scripts` 时用，设 `CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER=1`）、`sdk-tools.d.ts`、`package.json`、`README.md`、`LICENSE.md`。`engines: node >= 22`。
- **平台二进制包**（optionalDependencies）：`@anthropic-ai/claude-code-{darwin-arm64, darwin-x64, linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, linux-x64-android, linux-arm64-android, win32-x64, win32-arm64}`——覆盖 macOS/Linux/Windows/Android 及 musl 静态版。
- **推荐安装方式**（README，npm 安装已标记 deprecated）：`curl -fsSL https://claude.ai/install.sh | bash`、`brew install --cask claude-code`、`irm https://claude.ai/install.ps1 | iex`、`winget install Anthropic.ClaudeCode`。
- **版本节奏**：极快，2.1.226（2026-08），周下载量约 1510 万、月下载量约 4800 万【npm API】。
- **语言**：GitHub API 报告 "Python"（因仓库内插件含 Python 钩子代码），核心实为 TS/JS → Bun 编译。

### 1.3 仓库结构（main 分支，333 个文件）

GitHub 仓库 anthropics/claude-code **不再是 CLI 源码仓库**，而是"元仓库"：官方插件、示例、dogfood 配置。顶部结构：

```
.claude/                        # 官方 dogfood 配置（commands: commit-push-pr / dedupe / triage-issue）
.claude-plugin/marketplace.json # 官方插件市场定义（13 个插件）
.github/workflows/claude.yml    # 用 claude-code-action 做 issue/PR 自动回复（OIDC 联邦认证）
plugins/                        # 13 个官方一产插件（231 文件，含真实 hooks 代码）
examples/                       # gateway(AWS/GCP+Envoy)、hooks、MDM、settings 示例
scripts/                        # GitHub issue 治理脚本（用 Claude Code 自身跑）
CHANGELOG.md                    # 359 个版本的完整发布日志（495KB，本分析的重要依据）
SECURITY.md / LICENSE.md / README.md / demo.gif / feed.xml
```

插件清单（marketplace.json + plugins/README.md 核实）：`agent-sdk-dev`、`claude-opus-4-5-migration`、`code-review`、`commit-commands`、`explanatory-output-style`、`feature-dev`、`frontend-design`、`hookify`、`learning-output-style`、`plugin-dev`、`pr-review-toolkit`、`ralph-wiggum`、`security-guidance`。标准插件结构：`.claude-plugin/plugin.json`（manifest）+ 可选 `commands/`、`agents/`、`skills/`、`hooks/`、`.mcp.json`、`README.md`。

---

## 2. 全量功能清单

### 2.1 会话管理

| 能力 | 命令/机制 |
|---|---|
| 启动新会话 | `claude`（交互）、`claude -p "prompt"`（单轮 print） |
| 继续上个会话 | `claude --continue` / `-c`【CHANGELOG 0.2.93 引入】 |
| 恢复指定会话 | `claude --resume [id]`（交互式选择器；`-p --resume` 用于 headless 续跑） |
| 会话列表/全项目视图 | `/resume`（支持按项目并行加载）、`claude agents` 多会话界面 |
| 重命名 | `/rename`（另有 sessionTitle 可由 UserPromptSubmit hook 设置【CHANGELOG】） |
| 分支/复制 | `/fork`（v2.1.x 起：复制为新后台会话，占用 `claude agents` 一行）；`--fork-session`【CHANGELOG】 |
| 回滚 | `/rewind`（撤销代码变更，v2.0.0 引入）、`/undo` |
| 清空 | `/clear`（重置子代理预算） |
| 后台会话 | `claude --bg`、`claude --bg-pty-host`、`claude attach <id>`、`claude rm <id>`、`claude daemon status`；后台守护进程（daemon）管理 worker |
| 多会话 UI | `claude agents`（全屏 agent 列表，支持 worktree 隔离、`claude agents --json` 机器可读输出）、`/agents`、`/tasks`（后台任务） |
| 会话元数据 | `--session-id <uuid>` 显式指定；`CLAUDE_CODE_SESSION_ID` 注入 Bash 子进程与 hooks；API 请求带 `X-Claude-Code-Session-Id` 头【CHANGELOG】 |
| 存储位置 | 会话 transcript：`~/.claude/projects/<项目路径编码>/<session-id>.jsonl`（JSONL 格式，含 `"role":"assistant"`、`.message.content` 数组）【仓库 ralph-wiggum stop-hook 解析证实】；提示历史：`~/.claude/history.jsonl`；`CLAUDE_CONFIG_DIR` 可整体迁移配置目录；`cleanupPeriodDays` 设置控制清理（0 会被拒绝） |
| 远程/云会话 | `claude --teleport <session id>`（从云会话续到本地）、`/teleport`、`/remote-env`、`--remote-control`【CHANGELOG】 |
| 工作目录 | `/cd`（会话中途换目录）、`--add-dir`（追加允许访问目录）、`--git-dir`、`--worktree`（git worktree 隔离） |
| 检查点 | 【CHANGELOG】"bounded checkpoint disk usage by pruning superseded file-history backups"——checkpoint 机制即会话内文件历史备份（配合 `/rewind`）。独立"checkpoint 快照"功能待验证 |

### 2.2 记忆与上下文

- **CLAUDE.md 体系**：项目根/父目录 `CLAUDE.md`（+ `CLAUDE.local.md` 个人规则），自动注入系统提示；嵌套 CLAUDE.md 按目录层级注入（CHANGELOG 有"nested CLAUDE.md re-injected dozens of times"的修复，证明按需多次注入）。
- **AGENTS.md**：与 CLAUDE.md 并列的跨工具指令标准（docs 所述，CHANGELOG 0 命中——【文档推断，待验证】）。
- **自动压缩 auto-compact**：v0.2.47 引入（"Automatic conversation compaction... toggle with /config"）；演进为：1M 上下文模型默认被压缩到 200K（`CLAUDE_CODE_DISABLE_1M_CONTEXT` 可关）、未知模型按假定窗口执行（`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`）、连压三次防抖（"autocompact thrash loop"检测）、`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 覆盖窗口。
- **手动压缩**：`/compact`（内容过大时也能工作）、`/context`（带优化建议：识别 context-heavy 工具、memory bloat、容量警告）。
- **长上下文**：原生 1M token 窗口（Sonnet 5 默认、Opus 5 支持，`opusplan[1m]` 计划模式变体），`--effort`/`/effort` 推理努力度，`ultrathink` 关键词。
- **Auto-memory（自动记忆）**：v2.1.x 引入——"Claude automatically records and recalls memories as it works"，`/memory` 管理；`autoMemoryDirectory` 设置自定义目录；记忆文件带 ISO `modified` frontmatter；"Saved N memories" 提示；`ProposeSkills` 工具可直接从记忆文件生成 SKILL.md 草稿（kind: new|improvement + evidence 字段）【npm d.ts】。历史形态：`#` 前缀消息快速入记忆（v0.2.54）。
- **@-提及**：`@文件` 直接加入上下文（v0.2.75），`@` 类型提示支持命名子代理。
- **图片输入**：直接粘贴/拖拽图片（v0.2.59），`[Image #N]` 占位。

### 2.3 权限与审批（6 种模式）

权限模式枚举（SDK d.ts 官方注释原文）：`default` / `acceptEdits` / `plan` / `bypassPermissions` / `dontAsk` / `auto`。
- **default（手动）**：v2.1.x 起 UI 改名 "Manual"（`--permission-mode manual` / `"defaultMode": "manual"` 与 `default` 均被接受）；每个危险操作需用户批准。
- **acceptEdits**：文件编辑自动接受，Bash 仍询问。
- **plan**：只读 + 规划，`ExitPlanMode` 工具提交计划（`/plan`、`/ultraplan`、`opusplan` 模型设置）。
- **bypassPermissions**：全自动放行（旧名 `--dangerously-skip-permissions`；`disableBypassPermissionsMode: "disable"` 可被企业禁用；仍对 `rm -rf ~` 等灾难性命令提示）。
- **dontAsk**：不询问（语义：忽略 ask 规则，静默拒绝/放行——待验证细节）。
- **auto（自动分类器模式）**：v2.1 引入，LLM 分类器实时判断每个动作放行/拒绝，UI 有 `autoMode.allow` / `autoMode.soft_deny` / `autoMode.environment` 三组规则并可加 `"$defaults"` 引用内置列表；`disableAutoMode` 设置关闭；曾需 `CLAUDE_CODE_ENABLE_AUTO_MODE` 开关、后来 "no longer requires opt-in"；被拒后触发 `PermissionDenied` hook（返回 `{retry:true}` 可重试）。

规则与审批流（settings 结构，settings-strict.json / settings-lax.json / managed-settings.json 原文核实）：
```json
{
  "permissions": {
    "disableBypassPermissionsMode": "disable",
    "defaultMode": "default",
    "ask": ["Bash"],
    "allow": ["Bash(npm run build:*)", "Read(//public/**)"],
    "deny": ["WebSearch", "WebFetch"],
    "additionalDirectories": ["~/other-project"]
  },
  "allowManagedPermissionRulesOnly": true,
  "allowManagedHooksOnly": true,
  "strictKnownMarketplaces": [],
  "sandbox": { ... },
  "disallowedTools": ["MCPSearch"],
  "autoMode": { "allow": [...], "soft_deny": [...], "environment": [...] }
}
```
- **规则语法**：`ToolName(glob*)` 前缀匹配；`Task(AgentName)` 禁用指定子代理；MCP 工具可用 `mcp__server`、`mcp__server__tool`、`mcp__*` 粒度；`Edit(//path/**)` 对符号链接目标做解析后校验。
- **`/permissions` 命令**（原 `/approved-tools` v0.2.26）：查看/管理审批规则，Recent 标签页可 `r` 重试被拒项；`/less-permission-prompts` 技能扫描 transcript 生成 allowlist 建议。
- **审批缓存**：allow 规则在会话内生效；approval dialog 显示命令原文（防 tab/不可见 Unicode/`$(…)` 注入隐藏命令——CHANGELOG 多次安全修复）；`--permission-prompt-tool` 可自定义审批 UI（配合 PreToolUse hook `updatedInput` 实现自定义审批流）。
- **敏感目录**：`.git`、`.claude` 等在 bypassPermissions 下也不可静默写（v2.1 修复）。
- **hook 对权限的干预**：PreToolUse 可返回 `permissionDecision: allow|deny|ask|defer`（`defer` 用于 headless 暂停后 `-p --resume` 重估），或 `setMode: 'bypassPermissions'`（受 disableBypassPermissionsMode 约束）。

### 2.4 工具系统（内置工具全集）

来源：【npm d.ts】`ToolInputSchemas` 联合类型（42 个工具 schema，最新版）：
`Agent`（子代理）、`Bash`、`TaskOutput`、`ExitPlanMode`、`FileEdit`、`FileRead`、`FileWrite`、`Glob`、`Grep`、`TaskStop`、`ListMcpResources`、`RefreshMcpTools`、`Mcp`、`NotebookEdit`、`ReadMcpResourceDir`、`ReadMcpResource`、`ReportFindings`、`TodoWrite`、`WebFetch`、`WebSearch`、`AskUserQuestion`、`SendFeedback`、`ClaudeDesign`、`Projects`、`EnterPlanMode`、`TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`（任务看板）、`REPL`（持久化 JS 内核）、`Workflow`（多 agent 脚本）、`CronCreate`/`CronDelete`/`CronList`（定时任务）、`ScheduleWakeup`、`RemoteTrigger`、`ShowOnboardingRolePicker`、`Monitor`（shell/WebSocket 监视）、`ProposeSkills`、`Artifact`（发布 HTML/MD 页面）、`PushNotification`、`EnterWorktree`/`ExitWorktree`。另有 `MCPSearch`（MCP 工具延迟发现）【CHANGELOG】。

代表性 schema 细节（官方注释原文）：
- **BashInput**：`command`、`timeout`（max 600000ms）、`description`（需主动语态说明）、`run_in_background`、`dangerouslyDisableSandbox`。BashOutput 含 `stdout/stderr/interrupted/isImage/backgroundTaskId/backgroundedByUser/timedOutAfterMs/sandboxMode...`。Windows 下可选 PowerShell 工具（`CLAUDE_CODE_USE_POWERSHELL_TOOL`）。
- **AgentInput（子代理）**：`description`（3-5 词）、`prompt`、`subagent_type`、`model: "sonnet"|"opus"|"haiku"|"fable"`、`run_in_background`、`name`（可被 SendMessage 寻址）、`isolation: "worktree"|"remote"`（worktree=临时 git worktree；remote=云环境后台运行）。
- **FileEdit/FileWrite**：输出带 `structuredPatch`（unified diff 块）、`gitDiff`（status/additions/deletions/patch）、`originalFile`；`is_dirty` 标记被用户在权限对话框修改过。
- **WorkflowInput**：脚本需 `export const meta = {name, description, phases}` + `agent()/parallel()/pipeline()/phase()` DSL；`.claude/workflows/` 存放；`resumeFromRunId` 断点续跑（相同 agent 调用缓存结果）。
- **CronCreateInput**：5 段 cron 表达式（本地时区），`recurring`（默认 true，7 天自动过期）、`durable`（持久化到 `.claude/scheduled_tasks.json`）；`CLAUDE_CODE_DISABLE_CRON` 可关。
- **MonitorInput**：`command`（每行输出一个事件）或 `ws`（WebSocket，文本帧为事件），`timeout_ms`（默认 300000）或 `persistent`。
- **REPLInput**：`code`（支持 top-level await，状态跨调用持久）。
- **AskUserQuestionInput/Output**：结构化提问（question/header/options 2-4 个，label+description+preview），`multiSelect`，带 annotations/metadata；可被 PreToolUse hook 以 `updatedInput` 代答【CHANGELOG】。
- **ProposeSkillsInput**：`proposals`（1-3 个，name/kind: new|improvement/target/description/evidence/skillMd）。
- **TodoWrite/Task 系列**：TodoWrite 老牌；Task* 是 2026 年新增的会话内任务看板（subject/description/activeForm/status/addBlocks/owner）。

**工具准入**：settings 的 `allowedTools`/`disallowedTools`、`--tools`/`--disallowedTools` 旗标、agent frontmatter 的 `tools:`；`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` 等限制；`--json-schema`（StructuredOutput 结构化输出）。

### 2.5 技能（Skills）

- **SKILL.md 标准**：目录 `skills/<name>/SKILL.md`，YAML frontmatter + Markdown 正文。仓库内实测字段：`name`、`description`（列表上限 250→1536 字符）、`license`、`version`；【CHANGELOG】另支持 `model`、`effort`（覆盖模型努力度）、布尔值 `yes/no/on/off/1/0` 兼容、`allowed-tools`（skill/命令 frontmatter 的 hook 支持同款）；正文约定 Trigger/Steps/Verification 结构（ProposeSkills 的 skillMd 字段注释原文）。
- **发现/注入**：搜索 `.claude/skills/`（项目/用户作用域 `~/.claude/skills`）+ 插件 skills + 内置 bundled skills；`/skills`（带搜索框）、`/reload-skills` 热重扫；`disableBundledSkills` / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` 隐藏内置；`${CLAUDE_SKILL_DIR}` 变量让 SKILL.md 引用自身目录；frontend-design 技能"auto-invoked for frontend work"（描述匹配自动触发）；`ProposeSkills` 从记忆生成技能草案。
- **内联 shell**：技能/自定义命令中 `` !`cmd` `` 执行命令注入上下文（`disableSkillShellExecution` 可关）。
- **Agent Skills SDK**：与 Anthropic Agent Skills 生态互通（skill-creator 等），仓库 plugins/plugin-dev 内置 skill-development 技能；`agent-sdk-dev` 插件教写 SDK 应用。

### 2.6 钩子（Hooks）

**配置格式**【仓库真实 hooks.json】：
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "python3 .../hook.py", "timeout": 10,
            "if": "Bash(git commit:*)", "asyncRewake": true,
            "rewakeMessage": "...", "rewakeSummary": "..." }
        ]
      }
    ]
  }
}
```
位置：`~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`、插件 `hooks/hooks.json`。

**事件全集**【CHANGELOG 汇总 + 仓库代码】：
- `PreToolUse` / `PostToolUse`（可 `matcher` 按工具过滤）
- `UserPromptSubmit`（可返回 `hookSpecificOutput.sessionTitle`）
- `Stop`（会话结束时；v0.2.x 拆分出 SubagentStop）
- `SubagentStop`（输入含 `agent_id`、`agent_transcript_path`；与 Stop 均含 `last_assistant_message`、`background_tasks`、`session_crons`）
- `SessionStart` / `SessionEnd`（SessionEnd 支持 systemMessage；`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`）
- `PreCompact`（exit 2 或 `{"decision":"block"}` 可阻止压缩）
- `Notification`（后台 agent `agent_needs_input` / `agent_completed`）
- `PermissionDenied`（auto 模式拒绝后，`{retry:true}` 重试）
- `MessageDisplay`（转换/隐藏展示中的助手消息）
- `Elicitation` / `ElicitationResult`（拦截并改写回给用户之前的响应）
- `TeammateIdle` / `TaskCompleted`（团队/任务钩子，支持 `{"continue":false,"stopReason":"..."}`）
- `TaskCreated`（有阻塞语义）
- `WorktreeCreate`（`--worktree` 相关）【CHANGELOG 提及，待验证事件名】

**执行语义**（仓库 hookify 插件与官方示例代码核实）：
- stdin 输入 JSON：`hook_event_name`、`tool_name`、`tool_input`（Bash 的 `command`；Write/Edit 的 `file_path`/`content`/`new_string`/`old_string`/`edits`）、`transcript_path`、`reason`、`user_prompt`、`session_id`、`background_tasks`、`session_crons` 等。
- 输出（stdout JSON）：`{"systemMessage": "..."}`（喂给模型）；PreToolUse 阻断用 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}`；Stop 阻断用 `{"decision":"block","reason":"...","systemMessage":"..."}`（`reason` 会被作为下一条用户消息回灌——ralph-wiggum 插件用它实现自我循环）；`additionalContext`（PreToolUse/Stop/SubagentStop 均支持，让钩子反馈并延续回合）。
- 退出码语义【官方示例】：0=放行；1=拒绝并把 stderr 给用户（不给模型）；2=拒绝并把 stderr 给模型（可见）。
- 其他：`defer` 权限决策（headless 暂停）、`asyncRewake` 异步钩子（后台执行 + `rewakeMessage`/`rewakeSummary` 唤醒模型）、`once: true` 单次、`if` 条件（权限规则语法如 `Bash(git *)`）、HTTP 钩子（POST JSON 到 URL）、prompt 型钩子（LLM 评估器，`model` 参数指定评估模型）、`timeout`、`CLAUDE_PLUGIN_ROOT` 变量、>50K 输出落盘给路径+预览、`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 阻断上限。
- hook 来源标注：权限提示会显示钩子来源（settings/plugin/skill）【CHANGELOG】。

### 2.7 MCP（Model Context Protocol）

- **客户端**：Claude Code 是 MCP 客户端，工具合并进模型工具集；工具描述超上下文 10% 时延迟发现（`MCPSearch` 工具）；`--mcp-debug` 调试；`MCP_TOOL_TIMEOUT`/`MCP_TIMEOUT`/`MCP_CONNECTION_NONBLOCKING=true`/`MCP_SERVERS` 环境变量。
- **服务端配置**：
  - 项目级 `.mcp.json`（`mcpServers` 键）——仓库未信任时显示 `⏸ Pending approval`，逐服务器批准（安全修复：不再被仓库内提交的 settings.json 自我批准）
  - `--mcp-config <file>` 临时配置；`--strict-mcp-config`；`--mcp-debug`
  - `claude mcp add|add-json|add-from-claude-desktop|list|get|remove|serve|login|logout <name>`（`--scope user|project|local`、`--client-id`/`--client-secret` 预配置 OAuth、`--no-browser`）
  - 作用域：user（`~/.claude.json`）/ project（`.mcp.json` 提交到仓库）/ local（`.mcp.json` 不提交）【CHANGELOG 0.2.49/0.2.50 历史】；插件可带 `.mcp.json`
- **传输**：stdio（默认）、SSE、HTTP（streamable）、`type: "sdk"`（进程内 SDK server）；环境变量 `${VAR}` 插值，`${CLAUDE_PROJECT_DIR}`/`${CLAUDE_PLUGIN_ROOT}` 变量；`headersHelper` 脚本生成请求头（注入 `CLAUDE_CODE_MCP_SERVER_NAME`/`CLAUDE_CODE_MCP_SERVER_URL`）【CHANGELOG】。
- **MCP 作为服务端**：`claude mcp serve`（把 Claude Code 工具暴露为 MCP server，供其他 MCP 客户端调用）【CHANGELOG 2.1.x】。
- **认证**：OAuth 2.1（遵循 RFC 9728 Protected Resource Metadata 发现授权服务器）、Dynamic Client Registration、预配置凭据（Slack 等不支持 DCR 的）、`claude mcp login/logout`。
- **claude.ai 连接器**：官方托管 MCP 服务器（Slack、Gmail 等）可选；`ENABLE_CLAUDEAI_MCP_SERVERS=false` 关闭。
- 工具枚举：`ListMcpResources`/`ReadMcpResource`/`ReadMcpResourceDir`/`RefreshMcpTools`（资源/工具热刷新）。

### 2.8 输出协议（headless / SDK）

- `claude -p "..."`（print 单轮模式，stdin 也接受管道输入）
- `--output-format json | stream-json | text`；stream-json = 逐行 JSONL 事件流：`init`（含 `plugin_errors`、`mcp_server_errors`）、`system`、`assistant`、`user`、`result`、`control_request`（含 `set_model` 等控制消息）【CHANGELOG 事件名核实，字段细节待验证】
- `--input-format stream-json`（SDK 主机写回输入）；`--include-partial-messages`（部分消息流）；`--replay-user-messages`；`--forward-subagent-text` / `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`（嵌套子代理文本转发，depth-2+ 按 Agent tool_use id 键控）
- 预算/轮次控制：`--max-turns`、`--max-budget-usd`（超限停新 spawn + 终止运行中的后台子代理）
- `--json-schema`（结构化输出）、`--verbose`、`--debug`、`--session-id`、`--agents`（动态注册子代理）、`--setting-sources`、`--exclude-dynamic-system-prompt-sections`、`--permission-prompt-tool`、`--system-prompt`/`--system-prompt-file`、`--agent <name>`（指定 agent 定义）
- `--safe-mode`（禁用 CLAUDE.md/插件/技能/hooks/MCP 全部自定义，排障用）；`--bare`（-p 极简模式：跳过 hooks/LSP/插件同步/技能扫描/auto-memory，仅 API key）
- **SDK（Claude Agent SDK）**：TS/Python；`type:'sdk'` MCP 服务器；`mcp_authenticate`（含 `redirectUri`）；自定义工具回调（"Add custom tools as callbacks"）；`SDKUserMessageReplay.isReplay`；UUID 消息；请求取消；hook 自定义超时；OpenTelemetry 指标（`claude_code.active_time.total` 等，`OTEL_LOG_TOOL_DETAILS=1` 门控 tool 详情，mTLS 导出）。

### 2.9 子代理（Subagents）

- 定义：`agents/*.md`（或插件 agents/），frontmatter：`name`、`description`、`tools`、`model`（sonnet/opus/haiku/fable 或具体模型）、`color`（UI 颜色）【仓库 feature-dev 原文核实】；另有 `permissionMode`、`effort`、`maxTurns`、`disallowedTools`、hooks（PreToolUse/PostToolUse/Stop 限定到 agent 生命周期）、`bypassPermissions`【CHANGELOG】。
- 调用：`Task` 工具 + `subagent_type`；`--agents` 动态注入；`/subtask`（会话内子任务，v2.1.x 从 /fork 拆分而来）；`@` 提及命名子代理。
- 后台：默认后台运行，完成通知（Notification hook）；`TaskOutput`/`TaskStop` 管理；`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`（默认 20）、`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_FORK_SUBAGENT`；200/会话 spawn 上限已在 2.1.224 移除（并发与深度限制保留）。
- 输出：`AgentOutput` 含 `resolvedModel`、`modelsUsed`、`totalToolUseCount`、`totalTokens`、`usage`（input/output/cache_creation/cache_read、`server_tool_use.web_search_requests`、`inference_geo`）、`toolStats`（readCount/bashCount/editFileCount/linesAdded/linesRemoved 等）、`worktreePath`/`worktreeBranch`；async 变体给 `outputFile`、`canReadOutputFile`。

### 2.10 AGENTS.md / 项目引导注入

- `CLAUDE.md` + `CLAUDE.local.md`（项目根与父目录逐级注入）——确定【CHANGELOG】。
- `AGENTS.md`：官方文档宣导的跨 agent 工具指令标准（README 无、CHANGELOG 无命中）——【文档推断，待验证】。
- 其他注入源：`/init`（生成 CLAUDE.md）、`--append-system-prompt`（待验证）、`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`（额外目录的 CLAUDE.md 加载）。

### 2.11 checkpoints 与恢复

- `/rewind`、`/undo`（代码级回滚）；文件历史备份随 transcript 存储并有磁盘上限【CHANGELOG】。
- 会话恢复：`--resume`/`--continue`/`/resume`/`-p --resume`（含 deferred 工具重估）；fork 恢复、远程会话归档。完整"checkpoint 时间线"UI 待验证。

### 2.12 Headless / CI

- `-p` 全家族 + stream-json；GitHub Action `anthropics/claude-code-action@v1`（仓库 .github/workflows/claude.yml 原文：OIDC Workload Identity Federation 换短期 token，参数 `anthropic_federation_rule_id`、`anthropic_organization_id`、`anthropic_service_account_id`、`anthropic_workspace_id`、`claude_args`）；`--from-pr`、`--autofix-pr`、`--pr-comments`（PR 集成）；`claude agents --json`。
- 企业网关：examples/gateway（AWS/GCP + Envoy + Terraform），`ANTHROPIC_BASE_URL` 指向网关，`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`。

### 2.13 插件（Plugins）

- 市场：`/plugin`、`claude plugin install|enable|disable|uninstall|list|details|init|validate|update`、`claude plugin marketplace add|remove`（`--scope user|project|local`）；来源 `github|git|local|archive`（archive=HTTPS zip + 可选 SHA-256 固定，v2.1.224 新增）；`strictKnownMarketplaces`/`blockedMarketplaces`（支持 `owner/*` 通配）；`defaultEnabled: false`；`manifest.userConfig` 插件配置（`sensitive: true` 存 keychain/受保护凭据文件）；插件 `monitors` manifest 键（后台监视器，会话启动/技能调用时自动 armed）【CHANGELOG】。
- 仓库实测插件 manifest：`{"name","version","description","author":{"name","email"},"homepage"}`【plugins/*/.claude-plugin/plugin.json】。

### 2.14 主题 / 自定义 / 杂项

- `/theme`、`/color`、ANSI 颜色主题（v0.2.30 起）；`statusLine` 设置（`subagentStatusLine` 亦存在）；`/keybindings`、`/vim`（vim/emacs 键位）、`/tui`（`/tui fullscreen` 全屏渲染器、无闪烁模式 `CLAUDE_CODE_NO_FLICKER`、`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`、`CLAUDE_CODE_SIMPLE` 简单模式）、`/scroll-speed`、`/copy`、`/export`、`/share`、`/terminal-setup`、`/voice`（语音模式）、`/buddy`（愚人节彩蛋）、`claude-cli://` 深链、`/env`、`/doctor`（诊断）、`/stats`、`/cost`、`/usage`、`/usage-credits`、`/login`/`/logout`、`/bug`/`/feedback`（SendFeedback 工具：`failure_mode` 枚举 16 类 + `task_category`）、`/release-notes`、`/update`/`/upgrade`、`/install-github-app`。

---

## 3. 场景覆盖

| 场景 | 支持情况 |
|---|---|
| 交互终端 | 主场景：TUI（alt-screen/内联两种渲染器）、vim/emacs 键位、输入队列（工作中 Enter 排队）、Ctrl+R 历史、`!` bash 模式、`/` 命令面板、粘贴图片 |
| 非交互 / CI | `-p` + `--output-format json/stream-json/text`、`--max-turns`、`--max-budget-usd`、`--bare`、`--safe-mode`、GitHub Action、`claude agents --json`、daemon/`--bg` |
| IDE 嵌入 | VS Code native 扩展（v2.0 重写：Focus view、/mcp 管理对话框、Remote Control 集成）、JetBrains 插件、`--ide`、`CLAUDE_CODE_AUTO_CONNECT_IDE`、IDE shell 集成锁文件 |
| headless agent（SDK） | Claude Agent SDK（TS/Python）：stream-json 协议、控制消息、自定义工具、MCP 托管、budget、取消、replay；`type:'sdk'` MCP |
| 多会话并行 | `claude agents` 全屏多会话 + 后台 daemon + worktree 隔离 + 命名会话 + `SendMessage` 跨会话/跨机器通信（`ListAgents` 发现）+ `/fork` 并行分支 |
| 远程/移动 | Remote Control（web/mobile/desktop 遥控）、`--teleport`、`self-hosted-runner`、Cowork Dispatch |

---

## 4. 代码设计细节（文件级机制）

### 4.1 配置与存储布局
- `~/.claude/`：`settings.json`（用户级）、`projects/<编码路径>/<session-id>.jsonl`（transcript）、`history.jsonl`（提示历史）、`skills/`、`workflows/`（用户级 workflow）、`memories/`（auto-memory，路径可配）、`scheduled_tasks.json`（durable cron）、`stats/`（用量缓存）、`CLAUDE_CODE_TMPDIR` 覆盖临时目录；`CLAUDE_CONFIG_DIR` 整体迁移。
- 项目级 `.claude/`：`settings.json`（共享）、`settings.local.json`（个人）、`commands/`、`agents/`、`skills/`、`workflows/`、`hooks/`、`.mcp.json`（MCP 服务器）、`ralph-loop.local.md` 类状态文件（插件约定）。
- 企业级：`managed-settings.json`（MDM 下发，macOS 用 `com.anthropic.claudecode.mobileconfig`/plist、Windows 用 `ClaudeCode.admx`/`Set-ClaudeCodePolicy.ps1`，仓库 examples/mdm 原文：`{"permissions":{"disableBypassPermissionsMode":"disable"}}`）、`remote-settings.json`（服务器下发缓存）、`enabledPlugins` 策略。
- 配置合并顺序（settings.json 分层）【文档推断】：默认值 < 企业 managed < 用户 `~/.claude/settings.json` < 项目 `.claude/settings.json` < `.claude/settings.local.json` < CLI `--settings`（managed 层通常最高优先级）。

### 4.2 凭据存储
- OAuth 登录为主（`/login`，CLI 输出 URL 复制到浏览器）；macOS Keychain（v0.2.30 起 "API keys are now stored in macOS Keychain"）；其他平台受保护凭据文件（credentials.json——CHANGELOG 3 次出现，结构待验证）；`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` 环境变量；`apiKeyHelper` 脚本动态取 key（5 分钟 TTL，`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`）；`awsAuthRefresh`（AWS 凭据刷新）；Bedrock/Vertex/Foundry 云通道（`CLAUDE_CODE_USE_BEDROCK`、`ANTHROPIC_BEDROCK_BASE_URL`、`CLAUDE_CODE_SKIP_BEDROCK_AUTH`、`ANTHROPIC_VERTEX_*`）；MCP OAuth 客户端凭据（`--client-id`/`--client-secret`）；插件 `sensitive` 配置入 keychain。
- 会话级：`CLAUDE_CODE_SESSION_ID` 注入子进程与 hooks；`X-Claude-Code-Session-Id` HTTP 头（代理聚合）。

### 4.3 SDK 接口 shape（sdk-tools.d.ts 官方类型）
见 §2.4 工具表与 §2.8。核心模式：每个工具一个 `XxxInput`/`XxxOutput` 接口；子代理返回 `{status: "completed"|"async_launched"|"remote_launched", ...}` 判别联合；`usage` 块带 `cache_creation.ephemeral_1h_input_tokens`/`ephemeral_5m_input_tokens`、`service_tier`、`inference_geo`；权限模式枚举 `"acceptEdits"|"auto"|"bypassPermissions"|"default"|"dontAsk"|"plan"`。

### 4.4 Hook 负载字段（仓库真实代码）
- 输入：`hook_event_name`、`tool_name`、`tool_input`、`transcript_path`、`reason`、`user_prompt`、`session_id`、`background_tasks`、`session_crons`、`agent_id`、`agent_transcript_path`、`last_assistant_message`、`file_path`（Write/Edit/Read 为绝对路径）。
- 输出：`systemMessage`、`decision`、`reason`、`hookSpecificOutput`（`hookEventName`、`permissionDecision`、`additionalContext`、`sessionTitle`、`updatedInput`、`terminalSequence`）、`continue`、`stopReason`、`retry`。

---

## 5. 安全模型

- **权限模式**：§2.3 的 6 模式 + 企业可 `disableBypassPermissionsMode: "disable"` 锁死 bypass；agent frontmatter `bypassPermissions` 受组织策略约束（CHANGELOG 有专门修复）。
- **危险命令**：含 `$(…)`/反引号/`<(…)` 的 `rm -rf ~` 类灾难性命令在 bypassPermissions/auto 下仍提示（"Catastrophic removals... now prompt"）；`rm`、`git push` 等触发 ask/deny 规则；`--disallowedTools` 列表可封禁 WebSearch/WebFetch 等。
- **Bash 沙箱**（`sandbox` 设置块，仓库 settings-bash-sandbox.json 原文核实）：
  - `enabled`、`autoAllowBashIfSandboxed`、`allowUnsandboxedCommands`（禁用 `dangerouslyDisableSandbox` 逃生口）、`excludedCommands`、`failIfUnavailable`
  - `network`：`allowedDomains`、`deniedDomains`、`strictAllowlist`、`allowUnixSockets`/`allowAllUnixSockets`、`allowLocalBinding`、`httpProxyPort`/`socksProxyPort`（MITM 代理）、`tlsTerminate`（TLS 终止 → 凭据掩码/重签名）
  - `filesystem`：`denyRead`/`denyWrite`/`allowRead`（嵌套区域）、`disabled`（只留网络出口控制）
  - `credentials`：凭据文件/密钥环境变量拦截，`mode: "mask"`（Linux/WSL 哨兵副本 + 出口代理替换）、`extract`/`onExtractNoMatch`/`decode:"jwt"`/`awsPairs`/`sigv4` 掩码选项
  - `allowAppleEvents`（macOS 可选放开 Apple Events）、`bwrapPath`/`socatPath`（Linux/WSL 自定义 bubblewrap/socat 路径——Linux 实现基于 bubblewrap+MITM socat）、`enableWeakerNetworkIsolation`（macOS Go 程序 TLS 校验）、`enableWeakerNestedSandbox`
- **凭据防泄漏**：`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` 从 Bash 工具/hooks/MCP stdio 子进程环境剥离 Anthropic 与云厂商凭据（+PID namespace 隔离）；DNS 缓存命令（`Get-DnsClientCache`、`ipconfig /displaydns`）从 auto-allow 移除（隐私）。
- **审批缓存语义**：ask 规则每次提示；allow 规则匹配即自动放行（规则编译缓存）；权限对话框展示命令原文防隐藏（tabs/Unicode/后缀拼接均有修复）；`.git`/`.claude` 目录写保护；`--add-dir` 可扩展可写范围且实时生效。
- **MCP 信任**：仓库 `.mcp.json` 服务器需逐台批准（未批准 `⏸ Pending approval`，piped/非交互模式也不自动批准）；`strictKnownMarketplaces` 白名单市场。
- **数据**：反馈收集（usage + 会话数据，自愿/`/bug`），敏感信息有限留存、不用于训练（README 声明）；feedback survey 分享 transcript 时对密钥脱敏。
- **供应链**：插件归档支持 SHA-256 固定；`blockedMarketplaces` 组织级封禁；`claude plugin validate` 校验。

---

## 6. 独有特性清单（相对其他 CLI 少见）

1. **Hooks 生态最完整**：9+ 事件类型、`if` 条件、`asyncRewake` 异步唤醒、HTTP/prompt 两种非命令钩子、`defer` 审批、hook 可改 sessionTitle/terminalSequence——远超 Cursor/Codex/Aider 的 hook 能力。
2. **Auto 模式（权限分类器）**：LLM 实时裁决 + `autoMode.allow/soft_deny/environment` 规则矩阵 + `PermissionDenied` 钩子重试协议，业界独有。
3. **Bash 沙箱 + 凭据掩码**：bubblewrap/socat MITM + JWT 解码掩码 + AWS SigV4 重签名（`network.tlsTerminate`），安全粒度罕见。
4. **Workflow DSL**：`agent()/parallel()/pipeline()/phase()` 多 agent 编排脚本 + 断点续跑（缓存已完成 agent 调用）。
5. **会话内定时任务**：`CronCreate/CronDelete/CronList` + `ScheduleWakeup`（/loop 动态节奏）+ durable 持久化 + 7 天过期。
6. **`claude agents` 多会话工作台**：后台守护进程、worktree 隔离、`SendMessage` 跨机器会话互发消息（`ListAgents` 发现）、`/fork` 转后台、`claude rm` 清理。
7. **Remote Control / `--teleport` / self-hosted-runner**：手机/网页遥控终端会话、云会话本地续跑、BYO 机器作为云端会话运行地。
8. **`--bare` / `--safe-mode`**：无钩子极简 print 模式与全自定义禁用排障模式。
9. **Skills 体系**：SKILL.md 标准 + 记忆→技能生成（ProposeSkills + evidence） + `${CLAUDE_SKILL_DIR}` + 内联 shell 执行。
10. **Agent 定义即 Markdown**（frontmatter 声明 tools/model/color/permissionMode/hooks/isolation）+ `Task(AgentName)` 权限语法。
11. **Monitor / REPL / Artifact / Projects 知识库**工具：shell/WebSocket 监视、持久 JS 内核、发布 HTML 制品（带 409 冲突语义）、文档型项目知识库。
12. **MDM/企业治理**：ADMX/plist managed settings、`disableBypassPermissionsMode`、`allowManagedPermissionRulesOnly`、`strictKnownMarketplaces` 全链管控。
13. **1M 上下文原生支持** + `opusplan` 计划模式模型 + effort 控制（`/effort`、`--effort`）。
14. **官方插件市场**（marketplace.json + 13 个一产插件）+ `archive` 源码（zip+SHA-256）。

---

## 7. 限制 / 短板

- **闭源**：GitHub 仓库不含 CLI 源码（仅插件/示例/CHANGELOG），无法做代码级审计；核心为约 500MB 的 Bun 编译二进制（npm 包 postinstall 搬运）。
- **无本地模型**：纯云端 API（Anthropic API / Bedrock / Vertex / Foundry / 企业网关），离线不可用、数据必出网（虽有沙箱与脱敏）。
- **分发迁移**：npm 安装官方弃用；平台包体积巨大（~500MB），musl/Android 等小众平台支持依赖 optionalDeps。
- **依赖订阅**：OAuth/订阅（Pro/Max/Team/Enterprise）驱动，`/usage` 限额（Sonnet-only 周额度等）；`--max-budget-usd` 等预算控制为事后截断。
- **上下文成本**：1M 窗口默认被压缩至 200K（`CLAUDE_CODE_DISABLE_1M_CONTEXT` 需显式关）；长会话 token 消耗大。
- **已知工程质量问题**：15,646 个 open issues（2026-08）；CHANGELOG 中大量内存泄漏/长会话退化修复史（MCP stderr 64MB、transcript 50MB 崩溃、平方级复杂度等）；Windows/PowerShell 5.1 兼容问题频修。
- **安全面**：Bash 权限检查曾多次被绕过（tabs/Unicode/`&` 后台任务/TOCTOU）——已修但历史暴露攻击面；凭据以明文 env/文件形式存在（keychain 仅 macOS 默认）。
- **可移植性**：FreeBSD 不支持（官方建议 Linuxulator）；Wayland 剪贴板、iTerm2/tmux 渲染有兼容补丁史。
- **文档**：docs 站（code.claude.com）与代码分离、不可版本化审计；本分析中【文档推断】项需人工核对。

---

## 附：数据来源与可信度

- 已验证来源：GitHub API 树/文件（raw.githubusercontent.com）、npm registry 包内容（含 `sdk-tools.d.ts` 官方类型）、CHANGELOG.md 359 版本、仓库 13 个插件的真实 hooks/settings/MDM/agent/skill 文件。
- 未验证：code.claude.com/docs 全站（网络不可达）、`~/.claude` 内部文件精确 schema、凭据文件（credentials.json）结构、AGENTS.md 注入细节、stream-json 事件字段全集——已逐项标注【文档推断】/【待验证】。
