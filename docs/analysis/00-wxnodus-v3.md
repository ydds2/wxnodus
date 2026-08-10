# 00 · WxNodus V3 自身构造盘点（对比基线 · 2026-08 更新版）

> 本文是「4 个同类型 CLI 全量对比」的基线半边：WxNodus V3 的完整功能/场景/代码设计盘点。
> 证据来源：源码（194 个 ts/tsx 文件，38.4k 行）、dist 构建产物、439 测试全绿（32 文件）、cmd-sweep 105 项实跑全绿、依赖 21 个（纯逻辑零第三方）。

## 1. 定位与架构总览

- **形态**：Windows 本地优先的 AI agentic coding CLI——交互 TUI（自研渲染器）+ 非交互 `-p` 模式 + 协议化输出
- **运行时**：Node 22 + TypeScript 严格 ESM（零外部 UI 框架依赖：自研 @wxnodus/ink——React 19 自定义 reconciler + yoga 布局 + 行级差分 + DECSTBM 硬件滚动 + BSU/ESU 同步输出）
- **状态层**：自研原子状态引擎（createStore/createAtom/computed/useAtom，基于 useSyncExternalStore）——零第三方状态依赖
- **数据层**：better-sqlite3（WAL）+ FTS5 中文 bigram + sqlite-vec（384 维本地 embedding，transformers.js all-MiniLM-L6-v2）
- **规模**：194 源文件 / 38.4k 行 / 32 测试文件 / 439 测试 / 86 命令（registry）/ 40+ UI slash 命令 / 52 gateway RPC 方法 / 21 依赖

### 目录分层（独立改造后自研五域 UI 架构）
```
src/
  app/         编排层（自研状态引擎 engine/stores + flowController + Bridge + CommandBus）
  build/       概念编译器（spec/plan/scaffold/evidence/verify/gate 四门质量门）
  cli/         入口（自研参数解析 args.ts + TUI 装配 + --json/--wire）
  commands/    命令层（registry 86 命令/四层意图路由 22 触发/确定性工具/handlers+handlersExt）
  compliance/  合规五项（授权存证/AI 标注/审计导出/许可证扫描/robots 护栏）
  forge/       组件化构建（MCP 锻造/技能打包/注册表）
  kernel/      领域层（agent/黑洞记忆/tools/权限/事件/providers/computer/vision/
               skills/hooks/mcp/projectScan/plugins/imageMeta/imageHistory/secrets/
               systemPrompt/errors/curator/autoReview/a2a/acp/video/streamJson）
  store/       基础设施（SQLite/配置中心/审计链/checkpoint/fork/usage_stats）
  wxnodus-ui/  自研五域：runtime（回合流）/ bridge（内核桥）/ commands（命令路由）/
               hooks（交互）/ components（组件）
```

## 2. 全量功能清单（按类别）

### 会话与上下文
- 多会话热切换、/new /resume（标题模糊匹配）/sessions、/fork 分支、/checkpoint save|list|restore|clear
- /undo 软撤销（归档可检索 + 撤销前快照）、自动恢复上次未完成会话（pickResumeSession，autoResume 可关）
- 自动压缩（0.85 阈值 + preCompact hook 可阻止 + DB 联动归档）；/compact /digest
- 黑洞引擎三层记忆（working/archival/recall）+ 吸附 + FTS5 bigram + 本地向量 KNN 混合召回
- 自动标题、/context token 分布、/usage 真实用量（usage_stats 表 + SSE token 捕获）

### 模型与 AI 处理
- 10 模型目录 + 能力徽标、AES-256-GCM 密钥（机器指纹）、无 key 明确引导
- **结构化系统提示**（systemPrompt.ts：角色/准则/模式语义/输出规范/环境，每回合动态注入）
- **模型降级链**：429/5xx → 同 provider 备选模型自动降级（会话级保持 + 切换复位）
- 推理流式（reasoning.delta）、SSE 错误对象检测、4xx 不重试、瞬时失败退避
- 视觉：/vision /img /video、图片附加链路（剪贴板/路径 → 多模态注入 + 历史回显摘要）

### 权限与安全
- 6 模式（smart/auto/manual/plan/yolo/goal）+ 8 条硬红线
- **危险检测升级**：wrapper 解包链（sudo/env/bash -lc，深度上限 8）+ operand 后置变体
- **审批规则文件**（data/permissions.json + /perm rule）+ 会话批准缓存 + 低危自动放行
- **AI 审批预审**（autoReview：allow/deny/ask 三态，settings.autoReview 开启）
- **安全注入通道**（/security：sudo 密码/$WXNODUS_SECRET_* 密钥——仅亲手输入、仅内存、关闭即清）
- 子进程环境净化（bash spawn env 白名单剥离密钥变量）、SSRF 防护、合规五项 + 审计链

### 工具系统（15 内置 + 动态）
- fs_read/write/edit、bash（流式+abort 真中断+60s 兜底）、ls/grep/http_get（SSRF）/memory_write/scaffold_build/delegate/ask_user/clarify/todo/skill_load
- MCP 工具（mcp__<server>__<tool> + 热重载）、插件工具（热重载）

### 生态与协议
- Skills（SKILL.md 三级发现 + skill_load 注入）、Hooks **12 类**（含 preCompact BLOCK/notification/subagent 生命周期）
- MCP 客户端（/mcp 全套 + 热重载）、插件系统（/plugin 全套 + 面板）
- 协议：--json / --wire（JSONL 事件流）、/gateway HTTP JSON-RPC、/a2a、/acp（IDE）、/webhook、/claw
- **错误码体系**（WxError 4xxx/5xxx + RPC 统一 {ok,code,message}）、**退出码协议**（0/1/75）
- 协作：/swarm 并行 /duo /goal 循环 /delegate /jobs 后台（DB 持久化）/cron 定时 /task
- 委派档案（spawn_tree save/list/load + /replay）、会话导出（/export --jsonl 审计格式）

### 命令注册表（86 命令，8 类）
- ◈ 对话 20 ｜ ⚙ 系统 17 ｜ ▤ 记忆 5 ｜ ◆ 构建 11 ｜ 🛡 安全 10（含 /security）｜ 👁 视觉 5 ｜ ⛭ 网络 8 ｜ ☆ 协作工具 11

### 意图路由（22 条 NL 触发 + 四层分派）
- 别名 → 确定性工具 → NL 正则（22 条：构建/视频/图片/记忆/体检/备份/部署/抓取/定时/沙盒/合规/多开/审查/测试/重构/文档/SQL/git/导出/恢复/压缩/用量/审计/安全/计划/委派）→ AI 意图层

### UI 侧 slash 命令（40+，hermes 风格框架）
undo/retry/replay/replay-diff/rollback/save/agents/branch/background/browser/busy/clear/compact/compress/copy/details/fast/fortune/help/history/image/indicator/logs/mem/model/mouse/paste/personality/plugins/queue/quit/reasoning/redraw/reload/reload-mcp/reload-skills/sessions/setup/skills/skin/status/statusbar/steer/terminal-setup/title/tools/update/usage/verbose/voice/yolo

## 3. 场景覆盖

| 场景 | 支持 | 说明 |
|---|---|---|
| 交互 TUI | ✅ | 自研渲染器、多主题、审批/思考面板、命令面板、HUD |
| 非交互单发 | ✅ | `-p "需求"` + `--json` + 退出码协议（0/1/75 可重试语义） |
| 协议化事件流 | ✅ | `--wire` JSONL（7 类事件） |
| CI/脚本 | ✅ | 命令全可脚本化、105 项 cmd-sweep 实跑、退出码 75 供重试 |
| 多会话并行 | ✅ | session 热切换 + delegation 状态 + spawn tree 档案 |
| 后台任务 | ✅ | /jobs（DB 持久化）+ /cron 定时 + curator 后台策展 + notification hook |
| 外部集成 | ✅ | ACP（IDE）/ A2A / HTTP gateway / webhook / --wire |
| 本地优先 | ✅ | 数据不出机；无 key 明确引导；本地 embedding 离线向量检索 |

## 4. 关键代码设计

- **回合级状态隔离**（agent.ts）：turn 引用 + AbortController，中断竞态修复
- **结构化系统提示**：buildSystemPrompt 每回合动态构建（角色/模式/环境）
- **审批链**：规则文件（deny>allow>ask）→ AI 预审（allow/deny/ask）→ 低危放行 → 人工弹窗 → hook 拦截
- **模型降级链**：同 provider 备选自动降级（会话级保持）
- **RPC 协议**（wxGateway.ts）：52 method + 错误码统一 {ok,code,message}（4009 busy 等）
- **自研状态引擎**（engine.ts）：createStore/createAtom/computed/useAtom，零第三方
- **四层意图路由**（intent.ts）：别名 → 确定性 → NL 22 条 → AI
- **概念编译器**（build/）：需求 → 拓扑分解 → 脚手架 → 验证 → 证据链 → 四门质量门
- **容错模式**：FTS 降级 LIKE、sqlite-vec 降级纯 FTS、MCP 失败降级、embedding 冷却、退出统一清理（closeAllMcp+closeDB）

## 5. 安全模型

- 6 权限模式 + 8 硬红线 + 工具级 danger 单一事实来源
- 危险检测：wrapper 解包（深度 8）+ operand 变体 + 分段扫描最保守 rank
- 规则文件（/perm rule 持久化）+ 会话批准缓存 + AI 预审（可关）
- AES-256-GCM 密钥（机器指纹）；/security 注入通道（仅内存、关闭即清）
- 子进程 env 净化（剥离 KEY/SECRET/TOKEN）、SSRF 防护、sandbox L0-L3、yolo 显式确认

## 6. 独有特性

- 概念编译器（一句话 → 可运行系统 + 证据链 + 质量门）——四家参考均无
- 黑洞引擎（本地 embedding 向量检索，全离线）——五家唯一
- 合规五项（国内深度合成标注/审计导出/许可证扫描）
- 命令全中文别名 + 22 条 NL 意图路由 + 确定性工具毫秒级直调
- 完全自研：渲染器（React reconciler）/状态引擎/参数解析/模糊匹配/核心机制——纯逻辑零第三方依赖
- 图片附加链路 + 多模态历史回显（GLM-4V 本地化）
- 智能三件套：结构化系统提示 + 模型降级链 + AI 审批预审
- 文案规范（docs/copy-guide.md：专业 + 易懂双标准）
