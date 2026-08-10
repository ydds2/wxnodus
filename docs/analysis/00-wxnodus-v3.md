# 00 · WxNodus V3 自身构造盘点（对比基线）

> 本文是「4 个同类型 CLI 全量对比」的基线半边：WxNodus V3 的完整功能/场景/代码设计盘点。
> 证据来源：源码（203 个 ts/tsx 文件，38.6k 行）、dist 构建产物、413 测试全绿、cmd-sweep 105 项实跑全绿。

## 1. 定位与架构总览

- **形态**：Windows 本地优先的 AI agentic coding CLI——交互 TUI（自研渲染器）+ 非交互 `-p` 模式 + 协议化输出
- **运行时**：Node 22 + TypeScript 严格 ESM（零外部 UI 框架依赖：自研 @wxnodus/ink——React 19 自定义 reconciler + yoga 布局 + 行级差分 + DECSTBM 硬件滚动 + BSU/ESU 同步输出）
- **数据层**：better-sqlite3（WAL）+ FTS5 中文 bigram + sqlite-vec（384 维本地 embedding，transformers.js all-MiniLM-L6-v2）
- **规模**：203 源文件 / 38.6k 行 / 30 测试文件 / 413 测试 / 86 命令（registry）/ 40+ UI slash 命令 / 52 gateway RPC 方法

### 目录分层
```
src/
  app/         编排层（zustand stores/TurnController/Bridge/CommandBus）
  build/       概念编译器（spec/plan/scaffold/evidence/verify/gate 四门质量门）
  cli/         入口（commander + TUI 装配 + --json/--wire）
  commands/    命令层（registry 86 命令/四层意图路由/确定性工具/handlers+handlersExt）
  compliance/  合规五项（授权存证/AI 标注/审计导出/许可证扫描/robots 护栏）
  forge/       组件化构建（MCP 锻造/技能打包/注册表）
  kernel/      领域层（agent/黑洞记忆/tools/权限/事件/providers/computer/vision/
               skills/hooks/mcp/projectScan/plugins/imageMeta/imageHistory/secrets/
               curator/autoReview/a2a/acp/video/streamJson）
  store/       基础设施（SQLite/配置中心/审计链/checkpoint/fork）
  wxnodus-ui/  交互层（gateway RPC 服务端 + 自研组件 + slash 命令框架 + stores）
```

## 2. 全量功能清单（按类别）

### 会话与上下文
- 多会话（agent.setSessionId 热切换）、/new /resume（标题模糊匹配）/sessions（列表+过滤）/title
- /fork 分支会话（全量消息复制）、/checkpoint save|list|restore|clear（undo 前自动快照）
- /undo 软撤销（归档而非删除，recall 全量保留）+ 撤销前快照可恢复
- 自动压缩（token 估算超阈值 → LLM 摘要 → DB 联动归档）；/compact 手动；/digest 每日摘要
- 黑洞引擎三层记忆：working（可见窗口）/ archival（归档层）/ recall（全量检索）+ 自动吸附 + FTS5 bigram + 向量 KNN 混合召回
- 自动标题（setTitleIfEmpty）、/context token 分布、/usage

### 模型与 Provider
- 10 模型目录（DeepSeek/Kimi/GLM）+ 能力徽标（🧠/👁/上下文窗口）+ /model 模糊过滤
- 密钥 AES-256-GCM 加密（机器指纹绑定，明文绝不落盘）、/key /login /logout、无 key 明确引导（输出全部经 AI 模型，绝不规则脑假装）
- 推理流式（reasoning.delta）、SSE 错误对象检测、4xx 确定性错误不重试、模型热切换
- 视觉：/vision /img（GLM-4V）、/video（场景检测）、图片附加链路（剪贴板/路径 → 多模态注入 + 历史回显摘要）

### 权限与安全
- 6 模式：smart/auto/manual/plan/yolo/goal（Claude Code 语义 + goal 循环）
- 工具危险分级 + 8 条硬红线（任何模式不可绕过，扩展自 hermes HARDLINE）
- 会话级审批缓存（Allow this session）、bash 命令分段分类（读/写/网络/危险，最保守 rank）
- 安全注入通道（/security）：sudo 密码 / $WXNODUS_SECRET_* 密钥——仅用户亲手输入、仅内存、关闭即清
- 合规五项 + /audit 审计链（SHA-256 链式）+ /encrypt

### 工具系统（15 内置 + 动态）
- fs_read/fs_write/fs_edit/bash/ls/grep/http_get（SSRF 防护）/memory_write/scaffold_build/delegate/ask_user/clarify/todo/skill_load + MCP 工具（mcp__<server>__<tool>）+ 插件工具
- bash 流式输出 + 20k 截断、abort 真中断、60s 兜底超时

### 生态与协议
- Skills：SKILL.md（agentskills 兼容）三级发现（项目/用户/forge）、/skill /learn、skill_load 注入
- Hooks：userPromptSubmit/preToolUse（DENY 拦截）/postToolUse/stop（本地命令 + 环境变量上下文）
- MCP 客户端：/mcp add|list|remove|test + 热重载（/reload-mcp）
- 插件系统：plugin.json + index.js（ESM/CJS）、/plugin 全套、pluginsHub 面板、运行时热重载（updateTools）
- 协议：--json（AgentResult）/ --wire（JSONL 事件流）；/gateway 本地 HTTP JSON-RPC；/a2a Agent-to-Agent；/acp stdio（IDE 集成）；/webhook 事件回调；/claw 网页抓取
- 协作：/swarm 并行子代理（1-8）/duo 双脑/goal 循环/delegate 派发/jobs 后台任务（DB 持久化）/cron 定时任务（真实调度）/task 管理
- 委派档案：spawn_tree save/list/load（/replay 磁盘回放）

### 命令注册表（86 命令，8 类）
- ◈ 对话 20（help/clear/undo/usage/quit/sessions/resume/new/title/context/fork/checkpoint/…）
- ⚙ 系统 17（key/login/logout/model/status/doctor/version/thinking/hooks/…）
- ▤ 记忆 5（memory/hole/compact/digest/curator） ｜ ◆ 构建 11（build/deploy/forge/skill/learn/gate/fdr/evidence/plan/flow/import）
- 🛡 安全 9（perm/sandbox/compliance/consent/audit/encrypt/yolo/afk/security）
- 👁 视觉 5（vision/img/video/render/capture） ｜ ⛭ 网络 8（claw/mcp/plugin/gateway/proxy/webhook/a2a/acp）
- ☆ 协作与工具 11（swarm/duo/cron/jobs/task/delegate/goal/calc/hash/base64/uuid/…）

### UI 侧 slash 命令（40+，hermes 风格框架）
undo/retry/replay/replay-diff/rollback/save/agents/branch/background/browser/busy/clear/compact/compress/copy/details/fast/fortune/help/history/image/indicator/logs/mem/model/mouse/paste/personality/plugins/queue/quit/reasoning/redraw/reload/reload-mcp/reload-skills/sessions/setup/skills/skin/status/statusbar/steer/terminal-setup/title/tools/update/usage/verbose/voice/yolo

## 3. 场景覆盖

| 场景 | 支持 | 说明 |
|---|---|---|
| 交互 TUI | ✅ | 自研渲染器、Kimi/GLM 风格主题、命令面板、审批 overlay、thinking 面板 |
| 非交互单发 | ✅ | `-p "需求"` + `--json` |
| 协议化事件流 | ✅ | `--wire` JSONL（agent.start/token/message/tool/error/end/notice） |
| CI/脚本 | ✅ | 命令全可脚本化、105 项 cmd-sweep 实跑 |
| 多会话并行 | ✅ | session 热切换 + delegation 状态 + spawn tree |
| 后台任务 | ✅ | /jobs（DB 持久化）+ /cron 定时 + curator 后台策展 |
| 外部集成 | ✅ | ACP（IDE）/ A2A / HTTP gateway / webhook / --wire |
| 本地优先 | ✅ | 数据不出机；无 key 明确引导（模型可不出机） |

## 4. 关键代码设计

- **回合级状态隔离**（agent.ts）：turn 引用 + AbortController，中断竞态修复（旧回合不被新回合污染）
- **审批桥**：onApproval → GatewayClient.requestApproval → UI overlay；会话级批准缓存（createApprovalCache）
- **RPC 协议**（wxGateway.ts）：52 个 method，事件经 publish（subscribed 前缓冲）→ EventEmitter
- **四层意图路由**（intent.ts）：别名 → 确定性工具 → NL 正则 → AI 意图
- **概念编译器**（build/）：需求 → 拓扑模块分解 → 脚手架 → 验证（启动/探活/读回）→ 证据链 evidence.json → 四门质量门
- **审计链**：appendAudit SHA-256 链式哈希；checkpoint 全字段快照
- **容错模式**：FTS 不可用降级 LIKE、sqlite-vec 不可用降级纯 FTS、MCP 连接失败降级、embedding 冷却

## 5. 安全模型

- 6 权限模式 + 8 硬红线（任何模式不可绕过）+ 工具级 danger 单一事实来源
- bash 分段扫描分类（&&/|/; 拆分，最保守 rank）；BASH_DANGEROUS 正则清单
- AES-256-GCM 密钥（机器指纹）；/security 注入通道（仅内存、关闭即清）
- SSRF 防护（http_get/claw 内网拦截）、robots 护栏、sandbox L0-L3、yolo 模式显式确认

## 6. 独有特性

- 概念编译器（一句话 → 可运行系统 + 证据链 + 质量门）——四家参考均无
- 黑洞引擎（本地 embedding 向量检索，全离线）
- 合规五项（国内深度合成标注/审计导出/许可证扫描）
- 命令全中文别名 + NL 意图路由 + 确定性工具毫秒级直调
- 电池/状态 HUD、自研渲染器（零依赖 React reconciler）
- 图片附加链路 + 多模态历史回显（本地化 GLM-4V）
