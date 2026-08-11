# WxNodus V3 — 本地概念编译器 CLI

> **概念进 · 证据出**：说一句话，交付可运行系统。

Windows 本地优先的 AI agent CLI——数据不出机、模型可不出机（无 key 时对话明确引导配置，配置类命令不受影响）。

**核心自研**：状态引擎（createStore/createAtom/computed，零第三方状态依赖）、gateway RPC 协议、
黑洞记忆（本地 embedding）、概念编译器、agent 循环/权限/工具链——核心逻辑全部自研；
UI 层为自研五域架构（runtime 回合流 / bridge 内核桥 / commands 命令路由 / hooks 交互 / components 组件）。
渲染器 @wxnodus/ink 为 **ink(MIT, vadimdemedes) 的派生 fork**：组件 API 骨架继承 ink，
渲染管线深度自研重写（自研 TS yoga 布局移植替代官方 WASM、行级差分、屏幕缓冲、DECSTBM/BSU-ESU），
来源与版权声明见 packages/wxnodus-ink/LICENSE。

## 快速开始

```bash
npm install && npm run build
npm link            # 全局安装 wxnodus / wxn 命令
wxnodus             # 交互 TUI
wxnodus -p "帮我做一个待办系统"   # 非交互：说一句话 → 生成可运行项目
wxnodus -p "你好" --json         # 非交互：agent 结果 JSON
wxnodus -p "你好" --wire         # 非交互：总线事件流 JSONL（协议化接口）
```

## 自然语言免记命令

| 你说 | 触发 |
|---|---|
| 「帮我做一个待办系统」 | 概念编译 → 生成可运行项目 + 证据链 |
| 「搜一下我之前说的黑洞」 | 黑洞引擎检索 |
| 「算一下 2+3*4」 | 确定性计算（毫秒级不走模型） |
| 「分析这个视频 …」 | 视频人工视觉 |
| 「看看这张图 …」 | GLM-4V 视觉理解 |
| 「体检」 | 系统健康检查 |

## 核心能力

- **黑洞引擎**：百万上下文——三层记忆（working/archival/recall）+ 自动吸附 + FTS5 中文 bigram + 向量检索
- **概念编译器**：需求分析 → 模块分解（拓扑排序）→ 脚手架 → 验证（启动/探活/读回）→ 证据链 → 五门质量门（自测/健康/证据/合规/测试——产物声明 test 脚本则真实执行）
- **本地技能生态**：SKILL.md（agentskills.io 兼容）——`/skill list｜inspect｜new`、`/skill:名` 注入对话、`/learn` 从对话学习生成技能（AI 生成标注）、TUI `/skills` 面板；发现目录：项目 `.wxnodus/skills` → 跨品牌 `.claude/.agents/.codex/.gemini/skills`（agentskills.io 生态，Cursor CLI 同款）→ 用户 `data/skills` → forge 产物；`/reload-skills` 重扫
- **生命周期 Hooks**：`settings.hooks` 配置本地命令（userPromptSubmit/preToolUse/postToolUse/stop），上下文经环境变量传入，preToolUse 输出 `DENY` 即真实拦截工具
- **MCP 客户端**：`/mcp add｜list｜remove｜test` 管理本地 stdio server，两级配置（项目 `.mcp.json` mcpServers 对象格式 + 用户 `data/mcp.json`，Claude Code 生态标准；`--project` 写项目级）；`strictMcpConfig=true` 或 `--strict-mcp-config` 标志仅信任项目声明；per-server `startupTimeoutMs` 启动超时（Codex 对齐）；工具以 `mcp__<server>__<tool>` 并入 agent；`/mcp add/remove` 后自动热重载；连接失败干净降级
- **插件生态**：`data/plugins/*/`（plugin.json + index.js，ESM/CJS）——`/plugin list｜install｜remove｜enable｜disable｜reload`，工具并入 agent 工具表、命令注册为 `/插件名.命令名`；`/plugin new` 模板生成；TUI pluginsHub 面板启停热更新
- **分支会话**：`/fork` 复制会话（含全部消息）为分支；UI `session.fork`/`session.undo` RPC 真实实现；`/undo` 作用于当前活跃会话（软归档 + 撤销前快照，`/checkpoint restore` 可恢复）
- **图片附加链路**：Ctrl+V 粘贴截图 / `/image <路径>` → 附件登记 → 提问时多模态注入（GLM-4V Flash 等图像模型直接看图）；文本模型优雅降级提示；零依赖图片元数据（魔数/宽高/视觉 token 估算）；**历史回显**——图片轮次经 GLM-4V 生成摘要并入历史（后续轮次可回忆看图内容，无 key 不生成）
- **仓库地图**（aider repo-map 自研版）：`/map [token 预算]` 与 `repo_map` 工具——按语言启发式提取符号（TS/Python/Go/Rust/Java/C++/Shell）+ 黑名单过滤 + **引用权重排序**（被引用多的核心文件优先入预算，aider 依赖图排序轻量近似）+ 预算截断
- **委派档案**：`/replay list｜load` 回放历史 spawn 树（data/spawns/*.json 持久化）
- **/init 项目分析**：本地扫描生成 AGENTS.md（确定性数据，`/init --overwrite` 重新生成）
- **生态规范文件链**（agents.md 标准 + 多工具共存）：运行时注入首个存在者——AGENTS.md（/init 产物）> CLAUDE.md > GEMINI.md > .cursorrules > .clinerules > .roomodes，同一套项目规范被多家 CLI 消费
- **协作与协议（全部真实实现）**：`/swarm` 并行子代理（1-8 个）、`/duo` 双脑方案对比、`/goal` 循环目标执行、`/jobs run` 后台任务（db 持久化）、`/delegate` 派发子代理；`/gateway start` 本地 HTTP JSON-RPC 网关（command/prompt/health）、`/a2a call|serve` Agent-to-Agent 协议端点、`/acp server` ACP stdio 服务器（IDE 集成）、`/webhook add` 事件→HTTP 回调、`/claw <URL>` 网页抓取（SSRF 防护）、`/sandbox L0-L3` 分层权限沙盒、`/timer` 真实到时通知
- **定时任务工具**（Claude Code CronCreate 对齐）：`cron_create` 工具让模型自主创建定时任务；`/cron add|list|del|pause|resume` 命令面——**标准 5 字段 cron 表达式**（分 时 日 月 周，自研解析器 cronExpr.ts：数字/星号/步进/区间/列表）与 every Nm/Nh/Nd 兼容格式
- **AI 自主触发**（简化人工指令）：会话首轮极轻量注入——顶层结构一行 + 技能名称清单（几十字符，不挤占上下文）；系统提示第 5 条引导模型主动 `repo_map`/`skill_load`/`tool_search`（真正 AI 底层触发）；`autoRepoMap=true` 显式开启才注入完整地图（≤400 token，默认关闭防上下文膨胀）
- **MCP Streamable HTTP 传输**：`/mcp add-http <名称> <URL>` 连接远程 MCP server（SSE/JSON 双响应解析 + Mcp-Session-Id 会话头，MCP 2025-06-18+ 协议）
- **SSRF 三层防护**：主机名形态（IPv4/IPv6 私网段）+ DNS 解析逐 IP 校验（防重绑定）+ 重定向逐跳校验（≤5 跳）——http_get 与 /claw 统一走 src/kernel/ssrf.ts
- **插件 API 开放层**：插件 ctx 新增 `on`（事件订阅）、`getConfig`（只读配置）、`log`（插件日志）——完整文档 docs/plugin-api.md；`/plugin new` 模板含订阅/配置/日志示例
- **文件编辑影子快照**（Aider /undo 精神的零 git 依赖版）：`fs_write`/`fs_edit` 覆盖文件前自动备份原内容（上限 50 份 FIFO），`/undo fs list｜restore <编号>` 安全撤销文件编辑——任何工作区可用，不依赖 git
- **技能 effort 档位**（Claude Code skill effort 对齐）：SKILL.md frontmatter `effort: low|medium|high` 解析并在 `/skill list` 展示
- **会话 token 预算**（Gemini general.budget 对齐）：`settings.budgetTokens` 设上限——会话累计用量（usage_stats 实时 SUM）超预算即 `system.notice` 告警一次，建议 /compact 或 /new 控制成本；`-p --json` 输出含 `usage` 字段（stats 对齐）
- **模型能力元数据**：10 模型带能力徽标（🧠 推理 / 👁 视觉 / 上下文窗口），`/model <关键词>` 模糊过滤
- **Computer Use**：robotjs 桌面控制 + 动作层（DPI 换算/护栏/串行）+ GLM-4V 屏幕理解
- **合规五项**（红线）：授权存证 / AI 生成标注（深度合成办法）/ 审计导出 / 许可证扫描 / robots 护栏
- **安全**：5 权限模式 + 8 条硬红线（任何模式不可绕过）+ AES-256-GCM 密钥加密（明文绝不落盘）；`/perm rule add <工具> allow|deny|ask [glob] [理由]`——规则带人工可读理由（Codex exec policy 同款，审计可追溯）
- **安全注入通道**（`/security`）：sudo 密码 / `$WXNODUS_SECRET_<NAME>` 环境变量密钥注入——敏感内容仅用户亲手输入（UI overlay）、仅内存使用（stdin 传密码不进进程列表）、绝不落盘/不进历史/不进模型上下文；`/security sudo|secret on|off` 控制通道，**关闭即同步清除内存缓存**（`all off` 全量清空）；默认关闭

## 技术栈（成熟框架）

Node 22 + TypeScript 严格 ESM · @wxnodus/ink 自研 TUI 渲染器（React 19 自定义 reconciler + yoga 布局 + 行级差分 + DECSTBM 硬件滚动 + BSU/ESU 同步输出）· 自研状态引擎 · micromark+GFM+math（Markdown）· better-sqlite3+sqlite-vec+FTS5 · robotjs+playwright-core+node-screenshots（computer use）· @huggingface/transformers（本地 embedding）· vitest

## 验收证据

- ✅ 509 单元/契约/进程级测试全绿（41 测试文件）+ 类型检查零错误
- ✅ TUI 冒烟（真实终端 node-pty）：首屏/输入/回复/命令面板/Esc/终止不挂死
- ✅ 全命令扫描 105/105 可用（scripts/cmd-sweep.mjs 回归工具，112 命令注册表全覆盖）
- ✅ 概念编译器端到端：「帮我做一个待办系统」→ todo 项目生成 → 启动 → API 增删查 → healthcheck 通过 → evidence.json
- ✅ GLM-4V 视觉实测（/vision 识别 UI 截图）
- ✅ 技能注入实测：`/skill:名` 技能正文注入对话；hooks 实测：userPromptSubmit/stop 副作用触发
- ✅ npm link 全局安装，`wxnodus`/`wxn` 双命令可用

## 目录结构

```
src/
  app/        编排层（zustand 状态/TurnController/Bridge/CommandBus）
  build/      概念编译器（spec/plan/scaffold/evidence/verify/gate）
  cli/        入口（commander + 交互 TUI 装配 + --json/--wire）
  commands/   命令层（registry 112 命令/四层意图路由/确定性工具/handlers）
  compliance/ 合规五项（红线）
  forge/      组件化构建（MCP 锻造/技能打包/注册表）
  kernel/     领域层（agent/黑洞引擎/tools/权限/事件/providers/computer/vision/skills/hooks/mcp/projectScan/plugins/imageMeta）
  store/      基础设施（SQLite/配置中心/审计/checkpoint/fork）
  ui/         交互层（ink7 组件/Markdown 管线/Kimi 主题）
tests/        四层测试（509 用例，41 文件）
scripts/      TUI 冒烟（node-pty 驱动）/ cmd-sweep 全命令扫描
```

## License

Apache-2.0
