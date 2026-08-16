# CLI Agent 工具竞品原始调研笔记（2026-08）

> 调研日期：2026-08-17（T）
> 说明：本笔记只记录「实际抓到」的事实，每条标注来源 URL 与抓取日期。抓不到或无法验证的标注 [未证实]/[未找到证据]，不做推断性陈述。
>
> 抓取环境限制（如实记录）：
> - code.claude.com、docs.anthropic.com、claude.ai、developers.googleblog.com：本机网络不可达（连接被拒/超时），Claude Code 官方文档站无法直接访问，改用 GitHub 仓库 README/CHANGELOG（raw.githubusercontent.com 于 2026-08-17 抓取）。
> - developers.openai.com（含 /codex、/llms.txt）：HTTP 403 反爬拦截，Codex 官方文档站无法访问，改用 GitHub 仓库 README/发布说明/源码（2026-08-17 抓取）。
> - github.com HTML 页面：超时/连接重置，改用 raw.githubusercontent.com 与 api.github.com（均 2026-08-17 抓取）。
> - 搜索引擎（DuckDuckGo html、developers.googleblog）不可达；Bing 仅返回中文 SEO 站，不作为事实来源。

---

## 1. Claude Code（Anthropic）

### 版本与发布节奏
- 最新发布 v2.1.233（2026-08-14），发布频率极高（几乎每天一版）。
- 来源：https://api.github.com/repos/anthropics/claude-code/releases（抓取 2026-08-17）
- npm 包 @anthropic-ai/claude-code 最新 2.1.233。
- 来源：https://registry.npmjs.org/@anthropic-ai/claude-code/latest（抓取 2026-08-17）

### 逻辑闭环
- 权限模式（permission modes）：默认模式已从 "default" 更名为 **"Manual"**（CLI、`--help`、VS Code、JetBrains 同步更名；`--permission-mode manual` 与 `"defaultMode": "manual"` 均可）。存在 **acceptEdits** 模式（对会授予代码执行权限的构建工具配置文件如 `.npmrc`、`.devcontainer/` 会额外提示）；存在 **plan mode**（plan mode 下只读工具调用自动放行；有 "auto-mode classifier" 自动判定 Bash 命令是否只读）；agent 定义支持 **bypassPermissions**（受企业「禁用 bypass-permissions」策略约束）；`--dangerously-skip-permissions`（后台会话 retire→wake 时持久）。
- 来源：https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md（抓取 2026-08-17，v2.1.233~v2.1.14x 段）
- 中断与恢复：`--resume` / `--continue`（支持按会话名 `/rename`、`--name`、session-id、跨 worktree 恢复）；`/resume` 交互选择器；`/rewind`（Esc-Esc 呼出）；`--teleport`（同步会话到其他设备）；优雅处理 SIGINT 并提示 `--resume`。
- 来源：同上 CHANGELOG（抓取 2026-08-17）
- **背景任务（background tasks）已实装**：`claude agents` 多会话仪表盘、`--bg` 后台启动、`/bg` 后台化当前会话（←←）、后台任务通知、web/mobile/desktop/VS Code 面板、Remote Control 远程控制、`/schedule` 定时任务、孤儿后台任务合并摘要、worktree 隔离（`EnterWorktree`，可设 `worktree.bgIsolation: "none"`）。
- 来源：同上 CHANGELOG（抓取 2026-08-17）
- 多轮记忆：会话持久化 + 自动 compact；`CLAUDE.md` 项目上下文（老功能，本次未专门验证 [未证实 2026 变化]）。

### 功能
- 内置工具：Bash（支持 Linux memory cgroup 限制 `CLAUDE_CODE_TOOL_MEMORY_LIMIT`）、文件编辑、WebFetch（会话缓存 15 分钟 TTL 可配）、浏览器工具（browser_batch 只读调用在 plan mode 自动放行——即存在浏览器/视觉能力）；Windows 上 PowerShell 工具（对 Bedrock/Vertex/Foundry 用户默认启用）。
- **Subagents**：Task 工具 `mode` 参数已弃用，subagent 继承父会话权限模式；`claude agents` 视图管理后台 agent。
- **Hooks**：Notification hooks、Stop hooks（连续阻断 8 次后终止该轮）、WorktreeCreate hooks 等。
- **MCP**：支持 MCP v2（修复了长连接流反复重开问题）。
- **插件/市场（Plugins & Marketplaces）**：`/plugin` UI、`claude plugin install <name>@<marketplace>`、插件依赖自动安装、`known_marketplaces.json`、企业管控 `blockedMarketplaces`/`strictKnownMarketplaces`、自动更新。
- **Skills**：内置 skill（`/checkup`、`/review`），`SKILL.md` 校验（`claude plugin validate`）。
- **沙箱**：沙箱（sandboxing）在 Linux 上实装（修了空闲会话 CPU 100% 的 bug）；[沙箱平台矩阵 2026 现状未逐项验证——文档站不可达]。
- **视觉/桌面控制**：Windows Alt+V 粘贴剪贴板截图（"image paste"）；桌面/移动端 Remote Control 面板存在。[桌面 App 版本信息未证实]
- 企业：apps gateway（Anthropic upstream + Vertex、Foundry、AWS Bedrock 等云上游）、managed settings 策略、`claude self-hosted-runner`、`--channels`（console/API key 认证）。
- 来源：https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md（抓取 2026-08-17）

### 环境
- **Windows 原生支持：是**。官方推荐安装：PowerShell `irm https://claude.ai/install.ps1 | iex`；`winget install Anthropic.ClaudeCode`。npm 安装已弃用（README 明示 deprecated）。Node.js 18+。
- 来源：https://github.com/anthropics/claude-code/blob/main/README.md（抓取 2026-08-17）
- Windows 是活跃支持平台（CHANGELOG 大量 Windows 修复：NT `\??\` 路径、Windows Terminal 渲染、后台任务输出、PowerShell 进程）。
- macOS/Linux：`curl -fsSL https://claude.ai/install.sh | bash` 或 `brew install --cask claude-code`。
- IDE：VS Code、JetBrains 官方扩展；可作为 SDK host 嵌入 Claude Desktop。
- 离线/本地模型：**未找到证据**（必须连 Anthropic 或 Bedrock/Vertex/Foundry 云端）。

### 体验
- 终端 TUI（含 `/model`、`/plugin`、`/usage`、`/cost`、`/resume` 选择器、effort 选择器、screen reader 模式）；CJK/emoji/超链接渲染修复（日文、emoji）。
- 数据：官方说明收集反馈（usage data + 会话数据），不出售/不用于训练（README）。

### 定价/门槛
- 需 Claude.ai 订阅（Pro/Team→Sonnet 默认；Max/Team Premium/Enterprise→Opus 可作默认）或 API key 按量付费（pay-as-you-go 默认 Opus）。`/model` 选择器按订阅档位展示模型。
- Claude Sonnet 5 为 2026 年新默认模型，原生 1M token 上下文，促销价 $2/$10 per Mtok（至 2026-08-31，需 ≥2.1.197）。
- 来源：https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md（抓取 2026-08-17）
- 使用 API key 时 Remote Control/`/schedule`/claude.ai MCP connectors 被禁用。
- [2025 年曾有「Claude Code 面向所有人免费（有限额）」的说法，2026 年现状未找到官方可验证证据——文档站不可达，标注未证实]

---

## 2. OpenAI Codex CLI

### 版本与形态
- 稳定版 **rust-v0.147.0**（2026-08-07）；开发线 0.148.0-alpha.x（最新 2026-08-16）。CLI 已 Rust 重写（Ratatui TUI）。
- 来源：https://api.github.com/repos/openai/codex/releases（抓取 2026-08-17）
- 产品线：Codex CLI（本地）、`codex app` 桌面应用、Codex Web（chatgpt.com/codex 云端 agent）、IDE 插件（VS Code/Cursor/Windsurf）。
- 来源：https://github.com/openai/codex/blob/main/README.md（抓取 2026-08-17）

### 逻辑闭环
- 审批：0.147.0 新增 **`--approve-for-me`**（自动复核审批）。源码级证据：审批策略枚举 `AskForApproval::{Never, UnlessTrusted, …}`；沙箱越权/危险命令触发审批；命令执行审批（CommandExecutionRequestApproval）与文件变更审批（FileChangeRequestApproval）分流。
- [2025 年文档中的用户可见模式名 suggest / auto-edit / full-auto，2026 年官方文档被反爬拦截，未能重新证实——标注未证实；源码中已不存在这些字符串级枚举名的直接证据]
- **exec policy（执行策略）**：`codex execpolicy check` + `policy.rules`（如 `prefix_rule(pattern=["git","push"], decision="forbidden")`），命令级 allow/forbid 规则引擎。
- 来源：https://github.com/openai/codex/blob/main/codex-rs/cli/tests/execpolicy.rs（抓取 2026-08-17）
- **沙箱**：`FileSystemSandboxKind`（Restricted / Unrestricted / ExternalSandbox）、`WindowsSandboxLevel`、独立 crate **windows-sandbox-rs**（Windows 原生沙箱后端）、Linux/macOS 沙箱审批（sandbox escalation 审批）。
- 来源：https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs、codex-rs/protocol/src/permissions.rs（抓取 2026-08-17）
- 恢复：README 与发布说明提到 session resume（`--resume`）；0.147.0 新增「会话分节（conversation sections）+ 增量浏览长转录」。
- 网络审批：存在 NetworkApproval 协议（外网访问审批）。
- 来源：https://github.com/openai/codex（tree + releases，抓取 2026-08-17）

### 功能
- **Agent Plugins**：0.147.0 起支持「可移植 Agent 插件」，可从本地/个人/工作区/远程插件目录安装与搜索。
- **MCP**：支持 MCP 2026-07-28 协议（分页发现、多轮请求、非阻塞启动）；MCP SDK 升级 3.0.0。
- **Skills**：支持（文档 stub 指向 developers.openai.com/codex/skills）；可导入 Cursor 管理的 skills，并与 Claude/Cursor 会话同步。
- AGENTS.md（stub 指向官方文档）；slash commands（stub 存在）。
- 模型：GPT-5 系列（含 "minimal" reasoning effort）、gpt-5-codex 系（历史发布说明）；模型经官方 API。[模型清单 2026 未从官方文档证实——标注未证实]
- 网络检索：新增 cached web search（Bedrock 渠道）。
- 来源：https://api.github.com/repos/openai/codex/releases/latest（0.147.0 body，抓取 2026-08-17）

### 环境
- **Windows 原生支持：是**。官方 Windows 安装：`powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`；npm `@openai/codex`；Homebrew cask；GitHub Release 二进制（macOS arm64/x86_64、Linux musl x86_64/arm64；Windows 经 install.ps1 分发）。
- 来源：https://github.com/openai/codex/blob/main/README.md（抓取 2026-08-17）
- Windows 是活跃支持平台（0.147.0 修复 Windows 后台进程中断与路径一致性；源码含 exec_policy_windows_tests.rs、windows-sandbox-rs）。
- 离线/本地模型：**未找到证据**（模型均走 OpenAI API/Bedrock 等云端）。

### 体验
- TUI（Ratatui 0.30.2），markdown 流式渲染，diff 渲染，`ctrl-z` 挂起 TUI；`codex app` 桌面应用；支持中文等多语言渲染修复（日文/emoji 等）。
- 来源：https://api.github.com/repos/openai/codex/releases（抓取 2026-08-17）

### 定价/门槛
- 推荐 **Sign in with ChatGPT**（Plus、Pro、Business、Edu、Enterprise 套餐均含 Codex 用量）；API key 可用但「需要额外设置」。
- 来源：https://github.com/openai/codex/blob/main/README.md（抓取 2026-08-17）
- 免费账号限额与订阅内额度细节：官方文档 403 无法读取 [未证实]。
- Apache-2.0 开源。

---

## 3. Google Gemini CLI（含 Antigravity CLI 迁移）

### 版本与重大动向
- npm 最新 **0.55.1**；发布渠道：stable（每周二）、preview、nightly（每日）。
- 来源：https://registry.npmjs.org/@google/gemini-cli/latest；https://github.com/google-gemini/gemini-cli/blob/main/README.md（抓取 2026-08-17）
- **⚠️ 产品线变动**：官网横幅「Unpaid tier 和 Google One 用户：Gemini CLI 将于 June 18th 被 **Antigravity CLI** 取代」（抓取 2026-08-17 时横幅仍在；博客链接 https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli，本机网络不可达，迁移细节 [未证实]）。
- 来源：https://www.geminicli.com/docs/cli/sandbox（页面顶部横幅，抓取 2026-08-17）

### 逻辑闭环
- **审批模式（官方配置参考确认）**：`default`（每次提示审批）、`auto_edit`（自动批准编辑类工具）、`plan`（只读）、**YOLO**（全部自动批准，仅 CLI：`--yolo` 或 `--approval-mode=yolo`）。
- 来源：https://www.geminicli.com/docs/reference/configuration（抓取 2026-08-17）
- 沙箱（Sandboxing）：默认隔离有副作用的工具；五种后端：macOS Seatbelt、容器（Docker/Podman，默认）、**Windows Native Sandbox（Windows only）**、gVisor/runsc（Linux）、LXC/LXD（Linux 实验性）；支持 sandbox 扩展（包含工作区外文件）、关闭沙箱、`--sandbox` 标志。
- 来源：https://www.geminicli.com/docs/cli/sandbox（抓取 2026-08-17）
- 恢复/回退：**Checkpointing**（保存/恢复会话）、**Rewind**、会话与历史管理（文档侧栏条目）。
- 多轮记忆：**Auto Memory**（🔬 实验标记）、GEMINI.md 项目上下文、Memory import processor。
- 计划：**Plan Mode** + model steering（🔬）、Plan tasks with todos。
- 来源：https://www.geminicli.com/docs/cli/sandbox 侧栏 + README（抓取 2026-08-17）

### 功能
- 内置工具：Google Search grounding、文件操作、shell、web fetch；媒体生成（Imagen/Veo/Lyria via MCP）。
- **MCP**：支持（settings.json 配置，@server 调用）。
- **Extensions**：官方扩展市场（Browse extensions 入口）+ 自定义扩展开发。
- **Subagents + Remote subagents**（远程 subagent）、**Hooks**、**Agent Skills**、Headless mode（`-p` + `--output-format json/stream-json`）、Git worktrees（🔬）、IDE integration（VS Code companion）、ACP mode、Themes、Trusted folders、Policy engine、Token caching。
- GitHub Action（PR 审查/issue 分诊）。
- 来源：https://github.com/google-gemini/gemini-cli/blob/main/README.md + https://www.geminicli.com/docs 侧栏（抓取 2026-08-17）
- 背景任务类功能：[未找到证据——未见 background tasks/schedule 类页面]

### 环境
- **Windows 原生支持：是**。系统要求：Windows 11 24H2+（shell 支持 PowerShell）；macOS 15+、Ubuntu 20.04+；Node.js 20+；**明确「Internet connection required」**。
- 来源：https://www.geminicli.com/docs/get-started/installation（抓取 2026-08-17）
- 安装：npm/npx、Homebrew（macOS/Linux）、MacPorts、Anaconda；预装于 Cloud Shell/Cloud Workstations。
- 离线/本地模型：**未找到证据**（认证走 Google 账号/API key/Vertex，模型为云端 Gemini 3 系列，1M 上下文）。

### 体验
- 终端交互式 UI + headless；键盘快捷键；多语言（README 仅英文，但扩展生态有中文内容 [未证实]）。
- 免费额度的产品定位强（见定价）。

### 定价/门槛
- 免费层（个人 Google 账号）：**60 请求/分钟、1,000 请求/天**，Gemini 3 模型，无需 API key。
- 来源：https://github.com/google-gemini/gemini-cli/blob/main/README.md（抓取 2026-08-17）
- 官方配额页（抓取同日）：Google 账号 Code Assist Individual 1,000 请求/天；Google AI Pro 1,500/天、Ultra 2,000/天；Gemini API key 免费层 250 请求/天（⚠️ 与 README「API key 免费 1,000/天」表述不一致，两处均为官方页面，差异原因未查明）；Vertex Express 免费；Workspace Code Assist Standard 1,500/天、Enterprise 2,000/天。
- 来源：https://www.geminicli.com/docs/resources/quota-and-pricing（抓取 2026-08-17）
- Apache 2.0 开源。

---

## 4. Aider

### 版本
- 最新 tagged v0.86.1（HISTORY 头部为 main 分支未发布条目，含 Claude Opus 4.5/4.6、GPT-5.1~5.4、Gemini 3 preview 支持）。
- 来源：https://github.com/Aider-AI/aider/blob/main/HISTORY.md（抓取 2026-08-11，来自本会话之前的本地缓存，非本次新鲜抓取；aider.chat 页面为 2026-08-17 抓取）
- 主页数据：GitHub Stars 44K、Installs 6.8M、Tokens/week 15B。
- 来源：https://aider.chat/（抓取 2026-08-17）

### 逻辑闭环
- 面向「AI 结对编程」的单轮-多轮循环：提出变更→diff→自动 git commit（可关）；repo map 全库理解。
- 无 auto-accept/plan/yolo 模式体系（交互为确认式）；watch mode（`--watch-files`）监听代码注释 `AI`/`AI!`/`AI?` 触发。
- 来源：https://aider.chat/docs/usage/watch.html（抓取 2026-08-17）
- 会话恢复/持久化：[未专门验证，未找到证据]
- 记忆：repo map + 对话上下文（conversation）；无长期记忆商店 [未找到证据]。

### 功能
- git 集成（自动提交、undo）、repo map、in-chat commands（/add /model /ok 等，/ok 为 2026 新增）、图片/web 页面输入、语音输入、lint/test 执行。
- 浏览器 UI（aider 可在浏览器运行）、watch mode、scripting API（命令行/python 脚本）。
- 来源：https://aider.chat/docs/（抓取 2026-08-17）
- MCP：[未找到证据]；subagents/hooks：[未找到证据]。
- 模型：可接「几乎所有 LLM」，含本地模型（Ollama、LM Studio、OpenAI-compatible 自建端点）。
- 来源：https://aider.chat/docs/llms.html（索引页，抓取 2026-08-17）

### 环境
- **Windows 原生支持：是（2026 新变化）**。安装页提供 Windows PowerShell 一键安装 `powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 | iex"`（基于 uv installer，自动装 Python 3.12）。历史上有 WSL/Docker 路径，现已提供原生 PowerShell 脚本。
- 来源：https://aider.chat/docs/install.html（抓取 2026-08-17）
- macOS/Linux：`curl -LsSf https://aider.chat/install.sh | sh`；另有 uv/pipx/pip、Docker、Codespaces、Replit。
- 离线：支持本地模型（Ollama/LM Studio）→ 可完全离线运行。
- IDE：watch mode 兼容任意 IDE（靠文件注释）；无官方插件 [未找到证据]。

### 体验
- 纯终端文本流（非 TUI 面板）；diff 彩色展示；上手门槛低；无官方中文文档 [未找到证据]。

### 定价/门槛
- 工具本身开源免费（无订阅墙），但需自带 LLM API key（按各家 API 计费）；本地模型可零 API 成本。
- 来源：https://aider.chat/（抓取 2026-08-17，主页示例 `aider --model sonnet --api-key anthropic=<key>`）
- 许可协议：[本次未验证]

---

## 5. Goose（原 Block 开源项目，现 Agentic AI Foundation）

### 版本与治理
- 最新 **v1.46.0**（2026-08-12）：unrolled agent loop、shell 输出流式展示、逐消息用量统计（tokens/cost/TTFT/tok/s）、Markdown 会话导出。
- 来源：https://api.github.com/repos/aaif-goose/goose/releases/latest（抓取 2026-08-17）
- 仓库已从 block/goose 迁至 **aaif-goose/goose**（api.github.com 对 block/goose 的请求返回 aaif-goose/goose）。
- 官网定位：「your native open source AI agent」，归属 **Agentic AI Foundation**（主页已不再提 Block）。
- 来源：https://goose-docs.ai/（抓取 2026-08-17）

### 逻辑闭环
- 审批模式：`/mode` 切换 **auto / approve / chat / smart_approve**（自动 / 手动审批 / 仅聊天 / 智能审批）；**默认 Autonomous（auto）**；写类工具（文本编辑、bash rm/cp/mv）才触发审批（best-effort 分类）；接 Claude Code 等 CLI provider 时，approve 模式会透传其原生权限提示。
- 来源：https://goose-docs.ai/docs/guides/goose-cli-commands 与 https://goose-docs.ai/docs/guides/managing-tools/goose-permissions（抓取 2026-08-17）
- 会话：`goose session`（`--resume`、`list/remove/export/diagnostics`、`--fork`、`--history`）。
- 后台/定时：`goose schedule add/list/remove/run-now`（定时自动化）。
- 安全：prompt-injection 检测、sandbox mode、adversary reviewer（对抗评审模式）、工具权限控制。

### 功能
- **MCP 生态**：70+ 扩展；**MCP Apps**（扩展可在 Desktop 内渲染交互 UI）；skills；自定义扩展。
- **Subagents**（并行子 agent）；**Recipes**（可移植 YAML 工作流，可进 CI）。
- CLI/Desktop/API 三形态（Rust 编写）；Desktop 支持 macOS/Linux/Windows。
- 多模型：**15+ providers**（Anthropic、OpenAI、Gemini、Ollama、OpenRouter、Azure、Bedrock、Vertex、Groq、Mistral、xAI、Databricks、Snowflake 等）+ **本地**：Ollama、LM Studio、Atomic Chat、Docker Model Runner、Ramalama；CLI/ACP providers：Cursor Agent、Claude ACP、Codex ACP。
- 来源：https://goose-docs.ai/docs/getting-started/providers（抓取 2026-08-17）

### 环境
- **Windows 原生支持：是**。CLI：Git Bash/MSYS2 或 PowerShell（`download_cli.ps1`）；WSL 亦可。Desktop：Windows zip。macOS brew cask / zip；Linux DEB/RPM/Flatpak。
- 来源：https://goose-docs.ai/docs/getting-started/installation（抓取 2026-08-17）
- 离线：支持本地模型（Ollama/LM Studio 等）→ 可离线运行。

### 体验
- Desktop 图形界面 + CLI；流式 shell 输出；用量统计 UI。
- 来源：https://api.github.com/repos/aaif-goose/goose/releases/latest（抓取 2026-08-17）

### 定价/门槛
- 开源免费；云端 provider 需各自 API key；「ChatGPT Codex」provider 需 ChatGPT Plus/Pro 订阅（OAuth）；GitHub Copilot provider 需有 Copilot 权限的 GitHub 账号；本地模型无需 key。
- 来源：https://goose-docs.ai/docs/getting-started/providers（抓取 2026-08-17）

---

## 6. OpenHands（原 OpenDevin）

### 现状与形态迁移
- **CLI 状态**：官网原话——OpenHands CLI 仍是可用产品，「feature-complete and primarily maintained for stability」（功能冻结、仅维护稳定性）；旧 Docker 本地 GUI 已 **deprecated**。
- 来源：https://docs.openhands.dev/（抓取 2026-08-17）
- 当前重心：**Agent Canvas**（自托管开发者控制台，npm `@openhands/agent-canvas` 最新 1.12.0；Docker 镜像 1.13.0；状态 beta）+ Software Agent SDK/Agent Server（REST/WebSocket）+ OpenHands Cloud / Enterprise + Sandbox Server。
- 来源：https://docs.openhands.dev/（抓取 2026-08-17）；https://github.com/OpenHands/OpenHands/blob/main/README.md（抓取 2026-08-17）
- 定位变化：可运行 OpenHands agent，也可把 **Claude Code / Codex / Gemini 等任意 ACP（Agent-Client Protocol）兼容 agent** 作为后端跑在本地/远程/云。

### 逻辑闭环
- Agent 循环由 Agent Server 承载；任务/自动化（Automation Server）：定时或事件（GitHub issue、Slack、Linear 等）触发。
- 沙箱：Docker 沙箱（Docker Desktop 支持 macOS/Windows/Linux）；也可无沙箱直跑（官方警告：agent 将拥有完整文件系统权限）。
- 多轮：会话（conversations）由 Canvas 管理。

### 功能
- 自动化（automations）集成 Slack/GitHub/Linear/Notion；ACP agents；LLM profiles（bring your own model，任意 LLM）；critic（评审）；mobile access（移动端访问）。
- 来源：https://docs.openhands.dev/（抓取 2026-08-17）+ sitemap（抓取 2026-08-17）

### 环境
- **Windows**：Docker 沙箱方式提供 Windows PowerShell 命令（README.windows.md）；npm 直装方式要求 Node.js 22.12+、uv。
- 来源：https://github.com/OpenHands/OpenHands/blob/main/README.md（抓取 2026-08-17）
- 自托管（本地/VM/云服务器）+ OpenHands Cloud（商业）。
- 离线/本地模型：支持任意 LLM（LLM profiles）[具体本地推理方案未证实]。

### 体验
- 形态已从「终端 CLI」转向「本地 Web UI（Agent Canvas，localhost:8000）+ API」；CLI 冻结维护。
- 中文支持：[未找到证据]

### 定价/门槛
- 开源（MIT 系 [未验证]）；自托管免费，需自备 LLM key；Cloud/Enterprise 为商业付费产品（价格 [未找到证据]）。

---

## 7. Qwen Code CLI（阿里通义，补充调研 1）

### 版本与定位
- npm 最新 **0.21.12**；「open-source AI coding agent that lives in your terminal」。
- 来源：https://registry.npmjs.org/@qwen-code/qwen-code/latest；https://github.com/QwenLM/qwen-code/blob/main/README.md（抓取 2026-08-17）

### 逻辑闭环/功能
- **Agentic out of the box**：**Auto-Memory（自动记忆）、Auto-Skills、SubAgents、Agent Teams（多 agent 协作）、MCP**；动态工作流零配置。
- 多协议：OpenAI、Anthropic、Gemini、Qwen API + 任意第三方/本地模型（**Ollama / vLLM**），运行时切换。
- 生态：IDE 插件、**Desktop app**、daemon 模式、SDK、IM bot（Telegram/DingTalk/WeChat/Feishu）。
- 来源：https://github.com/QwenLM/qwen-code/blob/main/README.md（抓取 2026-08-17）
- 沙箱/审批模式细节：[未找到证据——README 未展开]

### 环境
- **Windows 原生支持：是**（`irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex`）；Linux/macOS 独立安装脚本；npm（Node 22+）/Homebrew。
- 离线：支持 Ollama/vLLM 本地模型。
- 来源：同上 README（抓取 2026-08-17）

### 体验/定价
- 终端 TUI；多语言官方文档（zh/en/de/fr/ja/ru/pt-BR/ko，含**中文**）。
- `/auth` 配置 provider + API key；框架开源免费，模型按 provider 计费；Qwen 云端模型需 API key（DashScope）。[免费额度未找到证据]

---

## 8. Cursor CLI（补充调研 2）

- 定位：在终端里与 Cursor 的 AI agent 交互（写/审/改代码）。
- 安装：macOS/Linux、WSL、**Windows PowerShell** 均有安装命令。
- 模式：**Agent / Plan / Ask** 三模式（Agent 全工具、Plan 先设计、Ask 只读）；非交互 print 模式。
- 其他：**Cloud Agent handoff**（云端 agent 接力）、session resume、sandbox controls、sudo 密码提示、交互式审批命令。
- 来源：https://cursor.com/docs/cli（抓取 2026-08-17）
- MCP/subagents/定价：[未找到证据——页面未覆盖]；版本号：[未找到证据]。

---

## 9. Amp（Sourcegraph，补充调研 3）

- 定位：「frontier agent」，可在 web/终端/手机使用；agent 可跑本地或 **orbs（远程常驻机器，笔记本关机后继续无人值守工作）**；跨设备接续线程。
- 安装：Mac/Linux/WSL、**Windows**、Homebrew（`curl -fsSL https://ampcode.com/install.sh | bash`）。
- 功能：**Plugins & Skills**（2026-08-11 全球可用）、技能/插件工作区分享、附件上传（视频/日志/PDF/数据集，2026-07-29）、Portals（orbs 内预览应用改动 + live reload，2026-08-06）。
- 模型：**The Dial**——2026-08-10 起可**绑定 ChatGPT 订阅**（low/medium/high 档位跑在订阅额度上）。
- 定价：订阅制（「Subscriptions, At Last」）。
- 来源：https://ampcode.com/（抓取 2026-08-17）
- 版本号/沙箱/审批模式细节：[未找到证据]

---

## 汇总表（2026-08-17 抓取证据）

| 工具 | 最新版本（来源日期） | Windows 原生 | 本地模型/离线 | 审批/权限体系 | 免费门槛 |
|---|---|---|---|---|---|
| Claude Code | 2.1.233 (npm/API, 08-17) | 是（install.ps1+winget） | 无证据 | Manual/acceptEdits/plan/bypassPermissions + auto classifier | 需 Pro/Max/Team/Enterprise 或 API key；[免费层未证实] |
| Codex CLI | 0.147.0 stable (API, 08-17) | 是（install.ps1） | 无证据 | AskForApproval(Never/UnlessTrusted)+`--approve-for-me`+exec policy+沙箱审批 | ChatGPT Plus/Pro/Biz/Edu/Ent 或 API key |
| Gemini CLI | 0.55.1 (npm, 08-17) | 是（Win11 24H2+，原生沙箱） | 无证据；必须联网 | default/auto_edit/plan/**yolo** | 免费 60/min+1000/day（Google 账号）；未付费/Google One 用户迁往 Antigravity CLI |
| Aider | v0.86.1 (HISTORY, 08-11) | 是（install.ps1，2026 新增） | 是（Ollama/LM Studio） | 确认式 diff+自动 commit；watch mode | 开源免费，自带 API key |
| Goose | v1.46.0 (API, 08-17) | 是（PowerShell/zip） | 是（Ollama/LM Studio/DMR 等） | auto/approve/chat/smart_approve（默认 auto） | 开源免费；provider 需 key/订阅 |
| OpenHands CLI | 冻结维护（docs, 08-17） | Docker 方式（README.windows.md） | 任意 LLM（LLM profiles） | 沙箱（Docker） | 自托管免费+自带 key；Cloud/Enterprise 付费 |
| Qwen Code | 0.21.12 (npm, 08-17) | 是（install.ps1） | 是（Ollama/vLLM） | [未找到证据] | 自带 API key；中文文档 |
| Cursor CLI | [未找到证据] | 是（PowerShell） | 无证据 | Agent/Plan/Ask + 审批命令 | [未找到证据] |
| Amp | [未找到证据] | 是 | 无证据（本地 agent/orbs） | [未找到证据] | 订阅制；可绑 ChatGPT 订阅 |

### 备注
- Claude Code 与 Codex 的「最新文档级」模式名（如 Codex 的 suggest/auto-edit/full-auto、Claude 官方文档页）受网络限制未能直读官方文档站，凡依赖此类文档的结论均标注 [未证实]。
- Gemini CLI 的 Antigravity 迁移（2026-06-18）仅见官网横幅，博客细节不可达 [未证实细节]。
