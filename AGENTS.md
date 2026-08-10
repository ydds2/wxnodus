# AGENTS.md

> 由 wxnodus `/init` 本地扫描生成（确定性结果，可 `--overwrite` 重新生成）。

## 项目概览

- 类型：Node.js/TypeScript
- 名称：wxnodus
- TypeScript：tsconfig.json 存在
- README：存在

## 常用命令

- 构建：npm run build
- 测试：npm test
- 运行：npm start

## 目录结构（顶层）

```
 AGENTS.md
 docs/
 package-lock.json
 package.json
 packages/
 README.md
 scripts/
 src/
 tests/
 tsconfig.json
 vitest.config.ts
 wxdbg.log
```

## README 摘要

> 自动截取，完整内容见 README.md

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

Node 22 + TypeScript 严格 ESM · @wxnodus/ink 自研 TUI 渲染器（React 19 自定义 reconciler + yoga 布局 + 行级差分 + DECSTBM 硬件滚动 + BSU/ESU 同步输出）· zustand · micromark+GFM+math（Markdown）· better-sqlite3+sqlite-vec+FTS5 · robotjs+playwright-core+node-screenshots（computer use）· @huggingface/trans


## 约定

- 修改代码前先阅读相关文件，保持现有风格
- 改动后运行测试命令验证
- 生成/修改文件遵循仓库既有结构
