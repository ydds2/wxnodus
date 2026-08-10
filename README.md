# WxNodus V3 — 本地概念编译器 CLI

> **概念进 · 证据出**：说一句话，交付可运行系统。

Windows 本地优先的 AI agent CLI——数据不出机、模型可不出机（无 key 时对话明确引导配置，配置类命令不受影响）。

## 快速开始

```bash
npm install && npm run build
npm link            # 全局安装 wxnodus / wxn 命令
wxnodus             # 交互 TUI
wxnodus -p "帮我做一个待办系统"   # 非交互：说一句话 → 生成可运行项目
wxnodus -p "你好" --json         # 非交互：agent 结果 JSON
wxnodus -p "你好" --wire         # 非交互：总线事件流 JSONL（协议化接口）
```

## 说人话（不记命令）

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
- **概念编译器**：需求分析 → 模块分解（拓扑排序）→ 脚手架 → 验证（启动/探活/读回）→ 证据链 → 四门质量门
- **本地技能生态**：SKILL.md（agentskills.io 兼容）——`/skill list｜inspect｜new`、`/skill:名` 注入对话、`/learn` 从对话学习生成技能（AI 生成标注）、TUI `/skills` 面板；发现目录：项目 `.wxnodus/skills` → 用户 `data/skills` → forge 产物
- **生命周期 Hooks**：`settings.hooks` 配置本地命令（userPromptSubmit/preToolUse/postToolUse/stop），上下文经环境变量传入，preToolUse 输出 `DENY` 即真实拦截工具
- **MCP 客户端**：`/mcp add｜list｜remove｜test` 管理本地 stdio server（data/mcp.json），工具以 `mcp__<server>__<tool>` 并入 agent；连接失败干净降级
- **分支会话**：`/fork` 复制会话（含全部消息）为分支；UI `session.fork`/`session.undo` RPC 真实实现
- **/init 项目分析**：本地扫描生成 AGENTS.md（确定性数据，`/init --overwrite` 重新生成）
- **模型能力元数据**：10 模型带能力徽标（🧠 推理 / 👁 视觉 / 上下文窗口），`/model <关键词>` 模糊过滤
- **Computer Use**：robotjs 桌面控制 + 动作层（DPI 换算/护栏/串行）+ GLM-4V 屏幕理解
- **合规五项**（红线）：授权存证 / AI 生成标注（深度合成办法）/ 审计导出 / 许可证扫描 / robots 护栏
- **安全**：5 权限模式 + 8 条硬红线（任何模式不可绕过）+ AES-256-GCM 密钥加密（明文绝不落盘）

## 技术栈（成熟框架）

Node 22 + TypeScript 严格 ESM · @wxnodus/ink 自研 TUI 渲染器（React 19 自定义 reconciler + yoga 布局 + 行级差分 + DECSTBM 硬件滚动 + BSU/ESU 同步输出）· zustand · micromark+GFM+math（Markdown）· better-sqlite3+sqlite-vec+FTS5 · robotjs+playwright-core+node-screenshots（computer use）· @huggingface/transformers（本地 embedding）· vitest

## 验收证据

- ✅ 255 单元/契约/进程级测试全绿（含技能/钩子/MCP/fork/项目扫描新增 39 例）+ 类型检查零错误
- ✅ TUI 冒烟（真实终端 node-pty）：首屏/输入/回复/命令面板/Esc/终止不挂死
- ✅ 全命令扫描 90/90 可用（scripts/cmd-sweep.mjs 回归工具）
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
  commands/   命令层（registry 71 命令/四层意图路由/确定性工具/handlers）
  compliance/ 合规五项（红线）
  forge/      组件化构建（MCP 锻造/技能打包/注册表）
  kernel/     领域层（agent/黑洞引擎/tools/权限/事件/providers/computer/vision/skills/hooks/mcp/projectScan）
  store/      基础设施（SQLite/配置中心/审计/checkpoint/fork）
  ui/         交互层（ink7 组件/Markdown 管线/Kimi 主题）
tests/        四层测试（255 用例）
scripts/      TUI 冒烟（node-pty 驱动）/ cmd-sweep 全命令扫描
```

## License

Apache-2.0
