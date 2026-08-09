# WxNodus V3 — 本地概念编译器 CLI

> **概念进 · 证据出**：说一句话，交付可运行系统。

Windows 本地优先的 AI agent CLI——数据不出机、模型可不出机（规则脑兜底，无 key 可用）。

## 快速开始

```bash
npm install && npm run build
npm link            # 全局安装 wxnodus / wxn 命令
wxnodus             # 交互 TUI
wxnodus -p "帮我做一个待办系统"   # 非交互：说一句话 → 生成可运行项目
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
- **组件化构建**：工具签名 → 可运行 MCP Server（stdio 零依赖）+ Skill 打包（agentskills 规范）+ 注册表三态
- **Computer Use**：robotjs 桌面控制 + 动作层（DPI 换算/护栏/串行）+ GLM-4V 屏幕理解
- **合规五项**（红线）：授权存证 / AI 生成标注（深度合成办法）/ 审计导出 / 许可证扫描 / robots 护栏
- **安全**：5 权限模式 + 8 条硬红线（任何模式不可绕过）+ AES-256-GCM 密钥加密（明文绝不落盘）

## 技术栈（成熟框架）

Node 22 + TypeScript 严格 ESM · ink 7 + React 19（官方 TUI）· zustand · micromark+GFM+math（Markdown）· better-sqlite3+sqlite-vec+FTS5 · robotjs+playwright-core+node-screenshots（computer use）· @huggingface/transformers（本地 embedding）· vitest（162 测试）

## 验收证据

- ✅ 162 单元/契约/进程级测试全绿 + 类型检查零错误
- ✅ TUI 冒烟（真实终端 node-pty）：首屏/输入/回复/命令面板/Esc/终止不挂死
- ✅ 概念编译器端到端：「帮我做一个待办系统」→ todo 项目生成 → 启动 → API 增删查 → healthcheck 通过 → evidence.json
- ✅ GLM-4V 视觉实测（/vision 识别 UI 截图）
- ✅ npm link 全局安装，`wxnodus`/`wxn` 双命令可用

## 目录结构

```
src/
  app/        编排层（zustand 状态/TurnController/Bridge/CommandBus）
  build/      概念编译器（spec/plan/scaffold/evidence/verify/gate）
  cli/        入口（commander + 交互 TUI 装配）
  commands/   命令层（registry 67 命令/四层意图路由/确定性工具/handlers）
  compliance/ 合规五项（红线）
  forge/      组件化构建（MCP 锻造/技能打包/注册表）
  kernel/     领域层（agent/黑洞引擎/tools/权限/事件/providers/computer/vision）
  store/      基础设施（SQLite/配置中心/审计/checkpoint）
  ui/         交互层（ink7 组件/Markdown 管线/Kimi 主题）
tests/        四层测试（162 用例）
scripts/      TUI 冒烟（node-pty 驱动）
```

## License

Apache-2.0
