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

# WxNodus V3

Windows 本地 AI agent CLI：数据不出机，无 key 也有离线能力（本地离线模型 + 确定性工具 + 本地记忆）。

## 快速开始

```bash
npm install && npm run build
npm link            # 全局安装 wxnodus / wxn 命令
wxnodus             # 交互 TUI
wxnodus -p "帮我做一个待办系统"   # 非交互单次执行
```

## 核心能力

- **黑洞引擎**：三层记忆（working/archival/recall）+ FTS5 中文 bigram + 向量检索
- **需求编译**（/build）：规格 → 分解 → 脚手架 → 验证（启动/探活/读回）→ 证据链
- **模型开放接入**（/model）：任意 OpenAI 兼容端点（选择器「＋ 添加自定义接口」表单 / `/model add`）；密钥管理 `/model set-key`
- **组件化构建**：工具签名 → 可运行 MCP Server + Skill 打包
- **安全**：权限模式 + 硬红线 + AES-256-GCM 密钥加密（明文绝不落盘）

## 技术栈

Node 22 + TypeScript 严格 ESM · @wxnodus/ink 自研 TUI 渲染器 · better-sqlite3+sqlite-vec+FTS5 · robotjs+playwright-core（computer use）


## 约定

- 修改代码前先阅读相关文件，保持现有风格
- 改动后运行测试命令验证
- 生成/修改文件遵循仓库既有结构

---

## ZCode 会话工作流注记（手工维护——`/init --overwrite` 重新生成会覆盖本段，重生成后请保留）

> 事故：2026-08-17 ZCode 切 deepseek-v4-pro 后回合 400——
> `messages[678]: unknown variant image_url, expected text`（纯文本模型收到多模态内容块）。

**规则（ZCode 会话内必须遵守）**：
1. ZCode 切换到 `deepseek-v4-pro`（或任何纯文本模型）后，回合开始先自查上下文是否存在待识别图片；
2. **有图** → 先用 GLM 多模态把图片识别为文本，再继续任务；
3. **无图** → 不自动调用视觉模型（零冗余调用）。

代码侧防御已落地（`src/kernel/providers.ts` imageStrategy + `src/kernel/agent.ts` 能力门/历史清洗，测试 `tests/kernel-image-guard.test.ts`），详见 `docs/zcode-deepseek-vision-workflow.md`。

**需求约束（用户 2026-08-18 声明，长期有效）**：
> 制作 wxnodus 必须依据其他同类型 CLI（codex/gemini-cli/opencode/kimi-cli/crush/aider，克隆于 `Desktop\cli-compare\`）源码逻辑进行**参考，不抄袭**。

落地口径：
1. **抄「机制与语义」、不抄「代码与文案」**——竞品源码只作为思路来源与证据锚点（docs 中 file:line 引用属引用标注），实现一律按 wxnodus 自身架构/命名/注释风格重写；
2. **互通性契约不算抄袭**（工具调用格式如 apply_patch 补丁语法、LSP/OpenAI 协议、Win32 沙盒 API——遵循标准契约是兼容性要求），但解析器/匹配器/调度器等实现逻辑必须原创；
3. 每个「对齐某竞品」的落地项，文档必须注明：参考了什么机制（引用锚点）+ 本仓实现位置 + 与竞品的实现差异（如：winSandbox 受限令牌路径经本机实测证伪后改 Low IL——机制校准结果与竞品不同，如实记录）；
4. 审计（docs/audit-deep.md）如实记录参考来源与差异，禁止整段移植竞品注释/错误文案/变量命名。
