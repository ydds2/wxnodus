# wxnodus 4.0 内核评估与竞品差异缺陷说明（2026-08-30）

> **基线**：工作区批次ⅩⅩⅥ 收口态（全量 2926 测试 / 0 失败）；本报告是 `docs/kernel-eval-2026-08-27.md` 的全面复评——
> 其后内核经 08-27 晚修复波（R-1..R-5/C2/C3/P2-14/P2-15/A2/A3）与 T34/T37/T38/T39/T64/T72/批次ⅩⅩⅣ-B 等
> 十余项变更。
> **方法**：双路并行深潜（① 内核 21,103 行全扫 + 08-27 修复复核 + 新缺陷猎捕；② 竞品 8 组锚点亲验——
> 上轮 ⚠️ 未验项全部升 ✅）+ 主会话对头排缺陷（N1/N2/N3）逐锚点复核。结论一律带 file:line。
>
> **先立勘误**：批次ⅩⅩⅥ 台账曾记「durable queue 未做」——**错误**。durable queue 已于 08-27 晚落地
> （P2-14，`kernel/durableQueue.ts` + agent.ts:1945-1977 接线 + SCHEMA v12），本报告 §3 给出其现状与缺口。

---

## 1. 总体判断

08-27 的结论「可靠性工程品类第一梯队」复核成立且加固——该轮列出的全部缺陷（3-1..3-9）已修复且
本轮逐锚点确认仍在位（§2）；两项竞品差距（durable queue、Notification hook）已落地。
**批次ⅩⅩⅦ/ⅩⅩⅧ（同日）已将 N1-N6 全部修复并带回归锁定**（含原「断言过弱」测试的计数/双分支强化；
N5 于ⅩⅩⅧ 经 activateTools 显式传递收口）。新增面缺陷密度高于稳定面的现象本身是教训：
**每轮新增机制必须同批带「断言够强」的测试**（mock 幂等与关键词过宽断言会掩盖行为矛盾）。

三条突出气质不变且加深：诚实标注（缓存/提前执行/蒸馏/截断全标注）、事件闭环（finishEarly 结构性
保证终态对）、前缀缓存三件套（字节稳定键序+会话冻结时钟+相邻合并）。

---

## 2. 分域评估（更新版）

| 域 | 成熟度 | 本轮核验要点（锚点） | 遗留风险 |
|---|---|---|---|
| 主循环/工具执行 | 高 | 确定性结局三处同源；并行调度读写门；canonicalToolArgs 三 key 构造点（:1495/:1602/:1695）✅；批级 unknownRounds（:1715）✅ | N3（413 重发丢弃 res）；N6（提前池缺坏 JSON 哨兵守卫） |
| 流式传输 | 高 | watchdog 三态/外部中止不误判/semanticDelta 防重放（llmStream.ts:474-492/:226-229/:615）本轮精读**未发现缺陷** | 重试路径 callWithAbort 不带 maxTokens（观察） |
| 上下文工程 | 强→中上 | R-1 clampFloat 生效（toolOutput.ts:36-40 + agent.ts:1384，测试 3 条）；compactSmart 归档+FTS 同步（memory.ts:346-386） | **N2（micro 降阈值后未跳过全量——注释与行为矛盾）**；onCompactChoice 内核侧无测试 |
| durable 队列 | 中（新域） | 入队先于处理/finally 收口 done/stale 恢复+一次性 notice（R-5 上限 256）| **N1（':sub' 豁免守卫匹配不到真实子会话 id）**；无 rollout 重放（设计取舍）；孤儿行无清扫 |
| 供应商层 | 强 | AES-256-GCM 归属校验、四层图片守卫、字段分流（providers.ts:76-113/:291-299/:239-278） | 无新发现 |
| 权限/沙箱 | 强 | C1 惰性 import 双调用点全接（:876/:879）；三层策略排序（permissions.ts:128-146） | 无新发现 |
| 子代理 | 中上 | 深度限制+动态危险剔除；N4/N5 已修 | 无活跃遗留 |
| Windows 全域控制 | 中上→强 | 11 computer 工具 + danger→审批映射；ⅩⅩⅨ/ⅩⅩⅩ 修复：急停触发器/DPI 坐标/多显示器/UIA 重试/视口刷新/边界探测异步化 | 遮挡校验+virtualDesktop PMv2 接入待真机验证 |
| 下载链 | 中→强 | ⅩⅩⅨ/ⅩⅩⅩ 修复：SSRF+代理+重试+不可变锚+300MB 上限+清单 4.0.2 | 外层一行安装器无 zip 哈希（纵深内层兜底） |
| 记忆/持久化 | 中上 | 三层+FTS5 bigram+vec KNN 混合（memory.ts:294-334/:398-427）；审计哈希链原子 append（audit.ts:25-41）；checkpoint×10+undoShadows | 无新发现 |
| 错误处理 | 中上（新） | exitCodeForError 结构化优先（errors.ts，7 用例含环引用/4xx 先于文本） | 413 结构化判 exit 1 与内核「413 可压缩重发」分层语义并存（可接受，记录） |

**测试覆盖面**：kernel-* 104 文件（agent 105 it / mcp 41 / permissions 37 / taskRunner 36 / providers 32）。
盲区清单见 §4 各条「测试盲区」注——共性是**mock 幂等或断言关键词过宽**让缺陷路径绿灯。

---

## 3. durableQueue 现状（本轮专项）

- **存储**：`durable_prompts` 表 v12 forward-only（migrations/db/registry.ts:249-261，status 四态+索引）。
- **语义**（kernel/durableQueue.ts）：enqueue（落盘即 queued）→ markRunning → finally markDone；
  recoverStalePrompts 单条 UPDATE...RETURNING（cutoff=now−5min，queued/running→interrupted 保留原文）。
- **对 codex 语义覆盖**：①入队先于回合处理（崩溃不丢用户消息）②队列保消息不保结局（结局归
  RunContext+checkpoint）③stale 恢复+每会话一次诚实 notice。**缺口**：无 rollout 重放（不自动重投
  未完成 prompt——设计取舍，durableQueue.ts:5-8 注释自证）；run_id 列恒 null（闲置）；孤儿行无清扫；
  同会话并发 run 的终态覆写竞态；崩溃后 <5min 重启不恢复（延后到下次 run）。
- **codex 对照锚点（本轮亲验）**：`codex-rs/ext/queue/src/service.rs:65,264,367`（durable revision
  index 轮询+独立 dispatch 线程）；rollout JSONL `rollout/src/recorder.rs:86,953` + 恢复入口
  `core/src/thread_manager.rs:962`（resume_thread_from_rollout）+ fork 前 flush（:933-946）。

---

## 4. 本轮新缺陷清单（按严重度 · 全部主会话或深潜复核锚点）

> **销项快照（批次ⅩⅩⅦ · 同日）**：N1 ✅（isSubagent 显式标志 + purgeDurableRows 清扫 + 测试改真实
> 形态）· N2 ✅（microSufficed 分支 + 确定性编排断言）· N3 ✅（res 落入正常处理 + 调用恰 5 计数）·
> N4 ✅（7 处发射点补 session_id + TUI retry/error 过滤 + 跨会话反例）· N6 ✅（哨兵守卫）·
> N5 ✅（批次ⅩⅩⅧ：activateTools 显式传递——子实例集合并入，父集合污染消除）· 观察项 2/6 顺手（重试路径 maxTokens、循环签名 canonical）。
> 原清单保留如下（历史锚点）：


### N1【中】durable ':sub' 豁免守卫是死代码——子代理目标照常入队 + 孤儿行累积
- **锚点**：agent.ts:1946 `!sessionId.endsWith(':sub')` vs 子会话真实形态 `sub-${Date.now...}` 前缀
  （agent.ts:631-633，execution 缺省时）或父会话 id 透传——**全仓无 `:sub` 后缀生产者**（仅 :836/:1944 注释宣称）。
- **机理**：守卫恒真 → delegate 子代理 run() 照常 enqueue；随机一次性子会话 id 的 running 行崩溃后
  永无 run 触发 recoverStale → durable_prompts 孤儿行永久累积。
- **测试盲区**：kernel-durable-queue.test.ts:72-83 用手工构造的 `'dq-main:sub'` 锁定了一个无生产者的格式——
  绿灯锁死代码。

### N2【中】auto 档 micro 降阈值后未跳过全量压缩——注释/notice 与行为矛盾 + 白烧摘要调用
- **锚点**：agent.ts:1401-1402 注释宣称「轻裁后若已降到阈值下，跳过全量压缩」；实现 :1418-1420 仅发
  notice「未触发全量压缩」，无 skip——流程落入 :1427 else 分支照常 preCompact+全量压缩。
- **影响**：每次阈值穿越多一次摘要 LLM 调用 + 前缀缓存失效 + 用户被告知「未触发」却立即全量。
- **测试盲区**：kernel-agent.test.ts:1509 断言 notice 关键词「压缩|micro」——两个矛盾行为同过。

### N3【中】413 强压重发成功后 `continue` 丢弃 res——A-3 同款未修到此路径
- **锚点**：agent.ts:1521-1522 `if (res) { lastRealPromptTokens=...; continue; }`——对照已修复的重试路径
  （:1552-1555 注释自证「重试成功的 res 直接落入下方正常处理」）。
- **影响**：text 双份流式输出+双倍计费；若 res 是 tool_call 则**整批工具调用被静默丢弃**。
- **测试盲区**：kernel-agent.test.ts:1533-1563 的 mock 对 ≥4 次调用幂等返回同一文本且不数调用次数。

### N4【中】agent.retry / agent.token{reset} / agent.error 不带 session_id——子代理流归属缺口
- **锚点**：reset agent.ts:1543；retry :1538；error :1528/:1549/:1718/:1723/:1734/:1750/:1903——对照已补齐的
  onToken :1142 / agent.tool :838（T72 只补了一半事件面）。
- **影响**：子代理重试的 reset 会清空主面板当前 attempt（TUI 空_sid 放行，runtime.ts:230-232）；serve
  转发（cli/serve.ts:560）把子代理错误归入主会话流。
- **测试盲区**：tui-selfbuilt.ts:970/982 仅测主会话，无跨会话反例。

### N5【低-中】懒加载子代理白名单激活写错目标集合（toolLazyLoad=true 时）
- **锚点**：agent.ts:671-673 把 def.tools 加进**父闭包** activeToolNames；子代理自建集合在 :639/:456-459。
- **影响**：①子代理 schema 仍缺白名单工具（READONLY_SUBAGENT_TOOLS 与 CORE_TOOL_NAMES 差集）；②父激活集被
  永久污染。默认关（观察级部署面）。

### N6【低】提前执行池缺坏 JSON 哨兵守卫
- **锚点**：agent.ts:1494-1498（safeJson 后直接 executeTool）——对照 runOneCall 守卫 :1594-1601。
- **影响**：`{__wxnodus_args_parse_error__}` 哨兵对象被当真实参数提前执行（只读面，浪费+错误结果）。

### 观察项（六项，随维护批消化）
重试/413 重发不带 maxTokens（:1521/:1544）；sessionStart hook 实为每 prompt 触发（:1301 turns===0 恒真）；
循环签名未用 canonicalToolArgs（:1729 与缓存 key 口径不一致）；finishEarly 文案不 mem.append（:1306-1310）；
durable 5min 固定 cutoff + 同会话并发覆写 + run_id 闲置；llmStream watchdog 与 errors.ts 本轮精读未发现新边界问题（如实记录）。

---

## 5. 竞品内核机制矩阵（本轮 8 组锚点全部亲验 ✅——08-27 版 ⚠️ 全部关闭）

| 机制 | wxnodus（锚点） | codex | gemini-cli | opencode | kimi-cli | crush | aider |
|---|---|---|---|---|---|---|---|
| 用户消息持久队列 | durable_prompts 四态+finally 收口（agent.ts:1945-1977）✅ | ✅ ext/queue service.rs:65 独立线程+durable revision index（**更强：轮询变更+独立 dispatch**） | — | — | — | 消息级 SQLite 即时落盘（session.go:340） | — |
| 会话重放/恢复 | checkpoint×10+中断回放；**无 rollout 重放**（取舍自证 durableQueue.ts:5-8） | ✅ rollout JSONL（recorder.rs:86）+ resume_thread_from_rollout（thread_manager.rs:962）+ fork 前 flush | state_snapshot | — | ✅ wire.jsonl 线级回放（wire/server.py:797-852，**外部 UI 重建 agent 状态**） | 重启续聊（session.go:181 GetLast） | git 兜底 |
| 压缩 | 真实 usage+EMA；micro→全量→413 强压三级+onCompactChoice 桥（agent.ts:1346-1476） | 回合前+中+远程 v2 | ✅ 阈值 50%+保尾 30%+压缩模型映射+「压缩反而变大」失败护栏（chatCompressionService.ts:41-52/:461-469） | ✅ isOverflow（input+output+cache 读写，overflow.ts:22）+20k buffer+专用 compaction agent（compaction.ts:358） | LLM 摘要 0.85 | 自动摘要 | 弱模型摘要 |
| 取消路径写入 | 中断回放+checkpoint | — | — | — | — | ✅ WithoutCancel 强制落盘被取消 turn（agent.go:501-518） | — |
| 循环检测 | 签名+短哈希+LLM 辅助+goal 空转 | 预算闸门等四层兜底 | ✅ **双模型确认**（flash<0.9 即否决；两模型均 ≥0.9 才判循环，loopDetectionService.ts:65-688） | doom_loop 3 连 | force_stop_turn | SHA-256 窗口 | — |
| 子代理深度 | 深度限制+只读集+危险动态剔除（:610-696） | ✅ agent_max_depth=1 默认+并发上限（config/mod.rs:222/:3680） | local/remote | task+权限继承 | 劳务市场 | task+agentic_fetch | architect 双模型链 |
| 逐编辑撤销 | checkpoint+undoShadows（轻量替代，用户裁决） | — | — | — | — | — | ✅ 每轮 auto_commit+cmd_undo 校验会话提交（commands.py:553-640） |
| 错误退出码 | 结构化优先 exitCode（errors.ts，本轮新增） | exec json | -p pipe | — | wire | — | — |

**差异结论（较 08-27 版更新）**：
1. 08-27 列出的两项未对齐（durable queue / 通知 hook）**均已关闭**；kimi 三项更深点中 canonical 化已对齐、
   通知 hook 已对齐，**线级回放**（wire.jsonl 外部 UI 重建）成为 kimi 最后一个独有深度点；
2. codex 的 durable queue 在工程强度上仍领先（独立 dispatch 线程+rollout 重放闭环 vs wxnodus 单表+取舍不重放）；
3. gemini 压缩的「失败护栏」（压缩反而变大则放弃+一次性标记）与**双模型循环确认**仍是两家独有深度；
4. wxnodus 独有：诚实标注体系、前缀缓存三件套、FTS5+vec 混合检索记忆、四层图片守卫、Windows 沙箱实测校准。

---

## 6. 建议动作（按优先级）

1. **修 N3**（1 小时）：413 重发 `continue` 改为落入正常处理（A-3 同款修法）+ 补「重发成功 res 不被丢弃」
   的调用计数断言——双倍计费+工具批静默丢弃是用户可感知面。
2. **修 N2**（1 小时）：micro 降阈值后加 skip 分支兑现注释承诺 + 双分支各自断言（notice 矛盾即红）。
3. **修 N1**（1 小时）：守卫改为真实形态判定（`sessionId.startsWith('sub-')` 或 spawnSub 显式传
   `isSubagent` 标志——推荐后者，id 形态不该承载语义）+ 孤儿行清扫（recoverStale 顺带 DELETE 超龄
   interrupted）+ 测试改用真实生产者形态。
4. **修 N4**（半小时）：retry/reset/error 事件补 session_id（T72 收尾）+ TUI/serve 过滤反例测试。
5. N5/N6 随维护批；观察项六条随维护批消化（其中循环签名 canonical 化与 N3 同文件可顺手）。

---

## 7. 结论

内核 4.0 复评：**可靠性工程第一梯队的结论加固**（08-27 全部缺陷销项且锚点在位、两项竞品差距关闭、
竞品 8 组锚点亲验完成）；**durable 队列已落地但有 N1 死守卫**；新一轮风险集中在「增量机制自身」——
N2/N3 是行为与宣称矛盾的诚实性缺口（与本产品最核心的气质冲突，优先修）；N4 是 T72 的半截工程。
修复全部低成本（合计约半天），建议作为下一批（ⅩⅩⅦ）整体收口。

---

*评估方法：双路并行子代理深潜（内核 21,103 行 + 竞品 8 组锚点）+ 主会话头排缺陷锚点复核（N1/N2/N3 亲验）。
本文与源码同步演进，重大变更应回改。*
