# wxnodus 4.0 全代码设计评估与竞品差异缺陷说明（2026-08-30 · 收口复评版）

> **取证基线**：wxnodus4.0 工作区批次ⅩⅩⅥ 收口态——全量 **2926 测试 / 0 失败** · mock e2e 15/15 ·
> PTY 冒烟 5/5 · en 首启真机探针 8/8 · 九门禁全绿。src **478 文件 / 61,402 行** · 测试 370 文件。
> 6 家竞品克隆于 `Desktop\cli-compare\`（未变——本轮全部竞品锚点已亲验，见 §5 来源注）。
> **方法**：本版是当日三轮评估（design-eval 主评 → 批次ⅩⅩⅣ-ⅩⅩⅥ 落地 → kernel-eval 深潜）的
> **收口合并版**，取代同日早版；配套专项：`docs/kernel-eval-2026-08-30.md`（内核域）。
> 证据纪律：结论带 file:line 或统计数；未取证明写。

---

## 1. 总评（评分表更新）

**一句话**：内核可靠性第一梯队结论加固（08-27 缺陷全销项 + 两项竞品差距关闭），产品形态完成
「七家最窄 → 第一梯队」的翻身（TUI/SDK/插件/身份/i18n 双语），工程纪律保持七家之首；
**当前活跃债务已收敛为：内核新增面的 6 项缺陷（N1-N6，约半天可清）+ hermes 目录终裁 + 增强型路线**。

| 维度 | 08-27 | 08-30 收口 | 依据 |
|---|---|---|---|
| 内核可靠性工程 | A（9/10） | **A+（9.2/10）** | 08-27 缺陷全销项 + durable/通知 hook + **ⅩⅩⅦ-ⅩⅩⅩ N1-N6+四面专项 21 项全部收口**（DPI/多显示器/UIA 重试/下载链/沙盒探测——缺陷台账清零） |
| 安全工程 | A-（8.5） | **A-（8.5）** | 面不变：AES-256-GCM 归属校验 / SSRF 三层 / Low IL 实测校准 / 四层图片守卫 / 三层策略排序 |
| 工程纪律 | A（9/10） | **A（9/10）** | 2926 用例 / 0 死测试（import 解析核验）/ e2e+PTY 真机资产 / 九门禁；kernel 104 文件专项 |
| 记忆与上下文 | A-（8.5） | **A-（8.5）** | 三层+FTS5 bigram+vec 混合仍是七家唯一检索式；compactSmart 归档+FTS 同步 |
| 产品形态 | C（6/10） | **B+（8/10）** | TUI 57/59 场景 + 双语 + ⅩⅩⅧ 真机修复 + ⅩⅩⅨ-ⅩⅩⅪ 全域控制/下载/沙盒/**分档 observe**/**rollout 重放**；SDK dist+identity；vscode-ext；实例身份（品类独有）。扣分：无鼠标（codex/kimi 同无）/IDE 薄 |
| 文档 | B-（7/10） | **B（7.5/10）** | README 0 死链+user-guide+三协议文档；用户:内部 ≈ 1:2.7 |
| **综合** | **8.0/10** | **8.8/10**（ⅩⅩⅪ 后终态） | 「强内核 + 完整形态 + 高纪律」；**N 系列已清——当前无已知结构性缺陷**（余 hermes 终裁一项决策 + 增强型路线） |

---

## 2. 现状快照

| 项 | 事实 |
|---|---|
| 规模 | src 478 文件 · 61,402 行（kernel 116 文件 21,103 行占 34%）· 测试 370 文件 2926 用例 |
| 入口 | 七入口全在：`-p` / `--wire` / `--serve`(+`--sdk`) / `--mcp-server` / ACP / stdin 管道 / TUI（cli/index.ts:798,467,752,445,45,675,1126） |
| TUI | ink 6.8 上游+React 19 · 57/59 原型场景 · **i18n 229 键×2 目录全量双语**（/lang 即切+首启向导闭环）· bracket-paste 协议级（25ms 悬挂超时）· termcap 现代终端族（WezTerm/Ghostty/COLORTERM…） |
| 生态包 | @wxnodus/sdk（dist 产物链+identity RPC）· @wxnodus/core（file:链+根 .d.ts 全量+发布改写）· vscode-ext（3 命令+审批闭环+vsix）· @wxnodus/ink fork 已退役 |
| 身份 | 实例身份（首启 UUID+确定性代号——六家竞品均无等价物，kernel-eval/design-eval 双确认） |
| 内核新面 | durableQueue（v12 四态表）· agent.retry/reset 事件 · onCompactChoice 桥 · plan 零工具硬闸 · canonicalToolArgs · 结构化 exitCode |
| 发布链 | zip（sha256+SBOM+ABI 侧车 Node24）/npm 三包直发（sdk/core 缺 dist 自动构建）/scoop/winget 审核中/`wxnodus update` |

---

## 3. 全代码架构评估（收口版）

### 3.1 分层与规模（21 目录 · 行数 Top：kernel 21,076 / application 7,431 / commands 6,914 / infrastructure 5,709 / tui 3,734+ / cli 3,379）
六边形分层纪律复核保持：kernel→presentation/tui/cli **0 命中**；domain→infrastructure **0 命中**。
两处既知反向瑕疵不变：packages/core runner 深导入（已按 T78 模式收敛为 wxnodus/dist+file:链）；
store↔infrastructure 迁移注册倒置（allowlisted，type-only）。

### 3.2 上帝文件（批次ⅩⅩⅥ 后显著改善）
| 文件 | 行数 | 变化 |
|---|---|---|
| kernel/agent.ts | 2,110 | 主循环+压缩+子代理+durable——**下一轮拆分候选**（分区清晰，见 kernel-eval §1） |
| kernel/tools.ts | 1,719 | 50 工具目录（分区良好） |
| cli/index.ts | 1,307 | 组合根装配 |
| commands/ext/profileMemoryBuildCommands.ts | 1,167 | 六块之一 |
| tui/runtime.ts | 1,122 | TUI 运行时 |
| commands/handlers.ts | 1,116 | 核心命令 |
| commands/ext/agentFlowCommands.ts | 1,069 | 六块之一（**ⅩⅩⅥ 新拆**） |
| commands/handlersExt.ts | **1,010** | **2,483→1,010（-59%）——转装配位，commands 六块结构成型** |

### 3.3 错误处理（C-4 第一刀后现状）
四套体系收敛为三套半：WX_ERR 数值型（exitCode 已结构化优先——errors.ts，7 用例含环引用/4xx 先于
文本）/GatewayError SCREAMING_SNAKE/HTTP_ 前缀族；agent 事件 code 已对齐命名域
（PROVIDER_HTTP_4XX/PROVIDER_TRANSIENT）。**tools.ts 纯字符串错误经评估修正为模型面工具输出契约**
（OpenAI tool-call 文本响应）——不属碎片化，维持并记录。

### 3.4 状态管理与持久化
TUI 自研 store（getSnapshot/subscribe/patch，零 Redux 依赖）+ 渲染期 i18n；SQLite WAL+FTS5+vec+
审计哈希链（audit.ts:25-41 原子 append）+checkpoint×10+undoShadows+durable_prompts（v12）。

### 3.5 死区现状（批次ⅩⅩⅣ 止血后——待终裁）
| 区 | 状态 |
|---|---|
| packages/hermes-tui/ink/shared（334 文件） | 已出 workspaces（文件保留磁盘）——**终裁待用户**（接线 or 删除） |
| src/hermes-gateway/server.ts（338 行） | 保留（有测试）；CLI 未接线 |
| packages/wxnodus-ink（150 文件） | 已退役出 manifest/构建链/发现面（磁盘保留） |
| src/app/ legacy（Bridge 等 ~500 行） | 自flag 不接线；CommandBus 活（type-only 消费 3 处） |
| zip 安装包 | 已停止携带 hermes TUI（原 3.9MB 未运行面） |

### 3.6 测试金字塔
370 文件：根平铺 224 + unit/integration/contract/failure + wave1-8 共 71 + regressions 28 +
known-failures 31/31 + kernel-* 104（agent 105 it）。真机资产：PTY 冒烟 5 断言 + mock e2e 15 断言 +
Windows 验收电池 + en 首启探针 8 断言。**已知盲区**（kernel-eval §4 各条注）：watchdog 零覆盖、
onCompactChoice 内核侧、N1-N6 各带断言过弱说明。

---

## 4. wxnodus 领先面（七家中独有或第一梯队 · 更新）

1. **诚实标注文化**（品类独有）：缓存/提前执行/蒸馏/截断/空输出全标注——N2/N3 修复后无已知违背；
2. **检索式长期记忆**（七家唯一）：三层+FTS5 中文 bigram+vec KNN 混合+salience 加权；
3. **DeepSeek 前缀缓存三件套**（字节稳定键序+会话冻结时钟+相邻合并）；
4. **密钥管理最严**（AES-256-GCM 机器指纹+归属校验）；
5. **中文 Windows 深度**（三档终端+现代终端族探测/GBK/IME/UIA 12 工具/Low IL 实测校准）；
6. **测试/发布链纪律**（0 死测试+九门禁+真机资产+ABI 侧车）；
7. **无账号 BYOK+任意端点零破坏**；
8. **工具面最宽**（50 内置）；
9. **实例身份**（网络下载后每份独一无二——六家均无）；
10. **TUI 双语即切**（229 键全量+首启闭环——竞品 TUI 均单语硬编码）。

---

## 5. 竞品对比矩阵（全产品面 · 竞品锚点当日亲验——kernel-eval §5 与本表合并）

| 维度 | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider |
|---|---|---|---|---|---|---|---|
| 技术栈 | Node22+TS | Rust | Node+@jrichman/ink fork | Bun+TS | Python(prompt-toolkit) | Go(bubbletea v2) | Python |
| TUI 双语 | ✅ 229 键即切 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 粘贴协议 | ✅ 协议级自实现（25ms 悬挂超时） | ✅ crossterm 内建 | ✅ 自实现+能力探测 | 未取证 | ✅ prompt_toolkit | ✅ bubbletea | — |
| 鼠标 | ❌（与 codex/kimi 持平） | ❌ | ✅ | 未取证 | ❌ | ✅ | — |
| 实例身份/个性化 | ✅ **品类独有** | ❌ | ❌ | ❌ | ❌ | ❌（machine_id=遥测） | ❌ |
| durable 用户队列 | ✅（N1 守卫待修） | ✅ **工程更强**（独立 dispatch 线程） | — | — | — | 消息级 SQLite | — |
| 会话重放 | checkpoint+回放；无 rollout（取舍） | ✅ rollout JSONL+resume | snapshot | — | ✅ wire.jsonl 线级 | 重启续聊 | git |
| 压缩 | micro→全量→413 强压+三选桥（N2 待修） | 回合前/中/远程 | ✅ 失败护栏+模型映射 | ✅ isOverflow+专用 agent | 摘要 0.85 | 自动摘要 | 弱模型 |
| 循环检测 | 签名+LLM 辅助 | 四层兜底 | ✅ **双模型确认**（≥0.9×2） | doom_loop | force_stop | SHA 窗口 | — |
| 记忆 | ✅ 检索式三层（唯一） | 两阶段 | 文件+人工 inbox | — | — | todos | — |
| 逐编辑撤销 | checkpoint+undoShadows（裁决轻量） | — | — | — | — | — | ✅ 每轮 commit+undo |
| SDK | spawn-attach+HTTP，dist 产物 | TS+Python 双 SDK | stream-json+SDK | HTTP 代码生成 | 平台 API | 50 REST | return_coder |
| 评测 | eval:tasks 10 任务+自检 | core/suite | evals 37 | — | e2e | e2e | ✅ SWE-bench |
| 分发 | npm+zip(ABI 侧车)+scoop+winget | rust bin+npm | npm | curl+npm | pip/uv | Go 单二进制多渠道 | pip |

**差异结论**：wxnodus 独有面（诚实标注/检索记忆/前缀缓存/密钥纪律/中文 Windows 深度/实例身份/TUI 双语）
vs 竞品仍有深度的面——codex durable 工程强度+rollout 重放、gemini 压缩失败护栏+双模型循环确认、
kimi wire.jsonl 线级回放、aider SWE-bench 级评测。**没有一家同时拥有 wxnodus 的三项第一梯队**
（可靠性+形态+纪律）。

---

## 6. 缺陷清单（当前活跃 · 收口版）

### 6.1 内核（kernel-eval N 系列——**批次ⅩⅩⅦ 已收口**：N1-N4/N6 修复+回归锁定，N5 观察级随维护批）
N3 413 重发丢弃 res（双倍计费/工具批静默丢）· N2 micro 未兑现 skip 承诺 · N1 durable ':sub' 死守卫
+孤儿行 · N4 retry/reset/error 缺 session_id · N5 懒加载子代理白名单错集 · N6 提前池缺哨兵守卫；
观察项六条（kernel-eval §4 末）。

### 6.2 产品/架构（非阻塞级）
hermes 目录终裁（334+338+150 文件已隔离待删/接线裁决）· 文档用户:内部 1:2.7 · 评测任务广度 10→37+ ·
agent.ts 2,110 行下一轮拆分候选 · vscode-ext 仍薄（3 文件 vs codex app-server 驱动全家桶）。

### 6.3 有意不追平（定位决策，维持）
OAuth/云账号 · 跨平台 · 桌面/Web/Slack · aider 逐编辑撤销粒度。

---

## 7. 销项总账（08-27 → 08-30 三轮）

| 轮 | 销项 |
|---|---|
| 08-27 晚修复波 | 3-1..3-9 全修（R-1..R-5）+ durable queue + 通知 hook + 出站 fetch 统一 + 三层策略 |
| 08-30 批次ⅩⅩⅣ | C-1 hermes 止血 · C-2 fork 退役 · C-3 core 发布链 · C-4 第一刀 · C-7 依赖 · C-8 勘误 · termcap 扩展 |
| 08-30 批次ⅩⅩⅤ | C-5 i18n 全量（~230 键+首启闭环）· C-4 第二刀评估修正 |
| 08-30 批次ⅩⅩⅥ | C-6 commands 六块（handlersExt -59%）· 评测 harness 勘误（已存在）· durable queue 勘误（已落地） |

---

## 8. 建议路线

1. ~~批次ⅩⅩⅦ = N1-N4 收口~~ **已完成（同日批次ⅩⅩⅦ）**；
2. hermes 目录终裁（向用户提请：删除 or 接线——已隔离零风险）；
3. agent.ts 拆分（照 commands 六块模式：主循环/压缩/子代理/durable 四域）；
4. 评测任务广度 10→37+（拾取 gemini evals 任务形态）；
5. 增强型：鼠标支持（gemini/crush 有）· kitty 键盘协议协商（gemini terminalCapabilityManager 对齐）·
   codex ~~rollout 重放~~ **已落地**（ⅩⅩⅪ）。

---

## 9. 结论

wxnodus 4.0 当前（08-30 收口）真实画像：**三项第一梯队并存**（内核可靠性 / 产品形态 / 工程纪律）+
**七家最大差异化面**（诚实标注·检索记忆·实例身份·TUI 双语·中文 Windows 深度·BYOK）。已知债务全部
显式化且低成本（N 系列≈半天 + hermes 终裁一项决策）；与竞品的剩余差距三类分明：有意不做的（定位）、
低成本可追的（N 系列对应面）、深度工程投入的（rollout 重放/SWE-bench 级评测）。
**清完 N 系列后，本评估将无已知结构性缺陷。**

---

*评估方法：三轮合并（design-eval 主评双路深潜 → 批次ⅩⅩⅣ-ⅩⅩⅥ 落地验证 → kernel-eval 双路深潜）；
竞品锚点当日全部亲验。本文与源码同步演进，重大变更应回改。*
