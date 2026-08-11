# WxNodus V3 — 本地概念编译器 CLI

> **概念进 · 证据出**：说一句话，交付可运行系统。

Windows 本地优先的 AI agent CLI——数据不出机、模型可不出机（无 key 时对话明确引导配置，配置类命令不受影响）。

**完全自研**：渲染器（@wxnodus/ink React reconciler）、状态引擎（createStore/createAtom/computed，
零第三方状态依赖）、gateway RPC 协议、黑洞记忆（本地 embedding）、概念编译器——核心底层全部自研；
UI 层为自研五域架构（runtime 回合流 / bridge 内核桥 / commands 命令路由 / hooks 交互 / components 组件）。

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
- **MCP 客户端**：`/mcp add｜list｜remove｜test` 管理本地 stdio server，两级配置（项目 `.mcp.json` mcpServers 对象格式 + 用户 `data/mcp.json`，Claude Code 生态标准；`--project` 写项目级）；`strictMcpConfig=true` 仅信任项目声明（--strict-mcp-config 等价）；工具以 `mcp__<server>__<tool>` 并入 agent；`/mcp add/remove` 后自动热重载；连接失败干净降级
- **插件生态**：`data/plugins/*/`（plugin.json + index.js，ESM/CJS）——`/plugin list｜install｜remove｜enable｜disable｜reload`，工具并入 agent 工具表、命令注册为 `/插件名.命令名`；`/plugin new` 模板生成；TUI pluginsHub 面板启停热更新
- **分支会话**：`/fork` 复制会话（含全部消息）为分支；UI `session.fork`/`session.undo` RPC 真实实现；`/undo` 作用于当前活跃会话（软归档 + 撤销前快照，`/checkpoint restore` 可恢复）
- **图片附加链路**：Ctrl+V 粘贴截图 / `/image <路径>` → 附件登记 → 提问时多模态注入（GLM-4V Flash 等图像模型直接看图）；文本模型优雅降级提示；零依赖图片元数据（魔数/宽高/视觉 token 估算）；**历史回显**——图片轮次经 GLM-4V 生成摘要并入历史（后续轮次可回忆看图内容，无 key 不生成）
- **仓库地图**（aider repo-map 自研版）：`/map [token 预算]` 与 `repo_map` 工具——按语言启发式提取符号（TS/Python/Go/Rust/Java/C++/Shell）+ 黑名单过滤 + 预算排序，动代码前先看结构；AGENTS.md 之外的第二重项目先验
- **委派档案**：`/replay list｜load` 回放历史 spawn 树（data/spawns/*.json 持久化）
- **/init 项目分析**：本地扫描生成 AGENTS.md（确定性数据，`/init --overwrite` 重新生成）
- **协作与协议（全部真实实现）**：`/swarm` 并行子代理（1-8 个）、`/duo` 双脑方案对比、`/goal` 循环目标执行、`/jobs run` 后台任务（db 持久化）、`/delegate` 派发子代理；`/gateway start` 本地 HTTP JSON-RPC 网关（command/prompt/health）、`/a2a call|serve` Agent-to-Agent 协议端点、`/acp server` ACP stdio 服务器（IDE 集成）、`/webhook add` 事件→HTTP 回调、`/claw <URL>` 网页抓取（SSRF 防护）、`/sandbox L0-L3` 分层权限沙盒、`/timer` 真实到时通知
- **模型能力元数据**：10 模型带能力徽标（🧠 推理 / 👁 视觉 / 上下文窗口），`/model <关键词>` 模糊过滤
- **Computer Use**：robotjs 桌面控制 + 动作层（DPI 换算/护栏/串行）+ GLM-4V 屏幕理解
- **合规五项**（红线）：授权存证 / AI 生成标注（深度合成办法）/ 审计导出 / 许可证扫描 / robots 护栏
- **安全**：5 权限模式 + 8 条硬红线（任何模式不可绕过）+ AES-256-GCM 密钥加密（明文绝不落盘）；`/perm rule add <工具> allow|deny|ask [glob] [理由]`——规则带人工可读理由（Codex exec policy 同款，审计可追溯）
- **安全注入通道**（`/security`）：sudo 密码 / `$WXNODUS_SECRET_<NAME>` 环境变量密钥注入——敏感内容仅用户亲手输入（UI overlay）、仅内存使用（stdin 传密码不进进程列表）、绝不落盘/不进历史/不进模型上下文；`/security sudo|secret on|off` 控制通道，**关闭即同步清除内存缓存**（`all off` 全量清空）；默认关闭

## 技术栈（成熟框架）

Node 22 + TypeScript 严格 ESM · @wxnodus/ink 自研 TUI 渲染器（React 19 自定义 reconciler + yoga 布局 + 行级差分 + DECSTBM 硬件滚动 + BSU/ESU 同步输出）· 自研状态引擎 · micromark+GFM+math（Markdown）· better-sqlite3+sqlite-vec+FTS5 · robotjs+playwright-core+node-screenshots（computer use）· @huggingface/transformers（本地 embedding）· vitest

## 验收证据

- ✅ 468 单元/契约/进程级测试全绿（34 测试文件）+ 类型检查零错误
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
tests/        四层测试（468 用例，34 文件）
scripts/      TUI 冒烟（node-pty 驱动）/ cmd-sweep 全命令扫描
```

## License

Apache-2.0
