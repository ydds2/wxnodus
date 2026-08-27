# 内核复评缺陷修复方案（kernel-eval §3.5 收口 · 2026-08-27 晚）

> **输入**：`docs/kernel-eval-2026-08-27.md` §3.5 复评——3 项已修（C1/C2/C3），本方案收口其余开放项。
> **范围**：仅内核 `src/kernel/`（agent.ts / toolOutput.ts）+ 对应测试；不动已修复波（C1/C2/C3/P2-14/P2-15/A2/A3/P1-4/P1-6）的任何代码。
> **纪律**：每卡「背景（评估锚点）→ 方案 → 验收（新增单测）→ 风险」；改动后 typecheck + 相关套件全绿。
> **执行记录**：见文末 §6（实施后回填）。

---

## R-1【3-7·坐实缺陷】compactionThreshold 等浮点阈值被 clampInt 静默忽略

- **背景**：`agent.ts:1341` `clampN(settingsAny?.compactionThreshold, 0.75, 0.5, 0.95)`，而 `clampN = clampInt`（`toolOutput.ts:23-27`：`Math.floor` 后 `n<=0` 回退默认）——传 0.8 → floor=0 → 静默回退 0.75。**(0,1) 区间所有小数设置全部失效**，配置项形同虚设；整数 1 夹到 0.95 也非用户意图。
- **方案**：`toolOutput.ts` 新增 `clampFloat`（阈值单一事实源模块）：不做 floor，`!isFinite || <=0` 回退默认，其余夹取 [min,max]（语义与 clampInt 一致仅去掉整数化）；`agent.ts:1341` 改用 `clampFloat`。EFF 内十个整数档位维持 clampInt 不动（语义正确）。
- **验收**：`tests/kernel-tool-output.test.ts` 新增——0.8 生效为 0.8（核心回归断言）、0.3 夹到 0.5、2 夹到 0.95、undefined/NaN/0/'abc' 回退 0.75。
- **风险**：极低（纯函数新增 + 一处调用点替换）。

## R-2【3-3】tool_search 被 earlyDispatch 提前执行——激活副作用违背「只读先行零残留」宣称

- **背景**：`tool_search.run` 内 `activeToolNames?.add(h.name)`（激活副作用，agent.ts makeToolSearchTool）+ earlyDispatchHook 仅按 `cacheable===true` 放行（agent.ts 批次2 段）——流式中途提前执行会激活工具；流失败后结果被丢弃但激活残留（无害但不精确），且 tool_search 的意义在模型真实请求时（当轮 toolList 已定，中途激活只影响下轮）。
- **方案**：earlyDispatchHook 在 cacheable 门之后按名排除 `tool_search`（同文件内定义，非跨模块魔法串），注释说明理由；tool_search 保留 `cacheable:true`（回合缓存语义成立：同查询→同命中→激活幂等）。
- **验收**：kernel-agent.test.ts 新增——`toolLazyLoad:true` 下流中途发出 tool_search 就绪信号，断言其工具结果**不含**「已提前执行」标注（未走提前池），同批自定义 cacheable 工具**含**标注（对照组，证明钩子本身工作）。
- **风险**：低（行为收窄：tool_search 一律流尾原路径执行）。

## R-3【3-6】unknownRounds 调用级计数与「连续 N 轮」语义不符

- **背景**：`agent.ts` runOneCall 内未知工具 `unknownRounds++`（:1523）、任一已知工具 `unknownRounds = 0`（:1535）——同批混入 1 个已知工具即清零（模型可借混批永远规避终止）；同批多个未知又叠加（一批 3 个未知 +3，「轮」被当「次」）。注释宣称「连续 N 轮未知工具终止」，实际是「调用级且可被混批清零」。
- **方案**：改**批级计数**——批执行完成后：本批含任一未知工具 → `unknownRounds+1`；本批全已知 → 清零。runOneCall 内两处调用级增删移除（未知工具的提前返回消息/failed 结局保留不变）。
- **验收**：kernel-agent.test.ts 新增两组——① 混批 [已知只读, 未知工具] 连续 3 轮 → 终止（旧语义永不终止）；② 未知轮与纯净轮交替 → 计数被纯净轮清零，正常完成。既有 gap 测试（每轮纯未知批 ×2 终止）行为不变。
- **风险**：低-中（终止条件变严：混批连续未知也计轮）。语义上更贴近注释宣称与「防模型空转」意图；maxUnknownToolRounds 可配（1..20）留有用户裁量。

## R-4【3-8】steerQueue 无上限——长回合高频注入无界增长

- **背景**：`agent.ts:763-767` steer 无条件 push；对照 noticeQueue 有 50 上限。steer 是运行中用户消息注入通道，无界数组在极端场景（长回合+外部程序化注入）内存无终止增长。
- **方案**：上限 50（与 noticeQueue 同档）；满时丢最旧并 `system.notice` 诚实告知（丢弃内容前 40 字预览）——用户消息不静默丢。
- **验收**：kernel-agent.test.ts 新增——连续 steer 60 条后跑一轮，断言注入的 `[steer]` 消息恰 50 条 + 丢弃 notice 可见。
- **风险**：低（50 条未消费注入本身已属异常态，丢弃最旧+可见告知是最优解）。

## R-5【3-9】会话级 Map/Set 无淘汰——长驻进程微泄漏

- **背景**：`sessionClocks`（:256）/`sessionFlags`（:291）/`durableRecoveredNotified`（:1854，P2-14 新增）只增不减；对照 `summarizeGuards`（上限 32 淘汰）与 `seenJobIds`（上限 256 淘汰）——同仓既有正确形态未复用。
- **方案**：三者统一加插入序淘汰（Map 迭代首项即最旧）：sessionClocks/sessionFlags 上限 64（淘汰仅丢冻结时钟/一次性标志，下次访问等价重建，正确性不变）；durableRecoveredNotified 上限 256（与 seenJobIds 同款）。
- **验收**：行为等价性修复（纯内存上界），无专门单测——理由：淘汰后首次访问走「时钟重建/标志重置/通知重发一次」路径，各路径均有既有行为语义且无外部可观测差异；在 §6 记录该取舍。
- **风险**：极低。

## 不做项（明确记录）

- **3-4**（index-advanced 依赖 OpenAI 流式不变式）：非标端点 fail-closed 回退流尾，防御已足够——记录不改。
- **落 commit**：当前工作区含当日修复波（40 文件未提交）+ 本批修复，按仓库纪律「用户要求才 commit」——建议用户验收后一次性分主题提交（本批一个 commit + 修复波一个 commit）。
- **差距台账**：本方案附录 §7 即台账落地（关闭 kernel-eval §5 的文档建议）。

---

## 6. 执行记录（2026-08-27 晚·实施完成）

| 卡 | 落点 | 测试 | 状态 |
|---|---|---|---|
| R-1 clampFloat | `toolOutput.ts`（clampFloat 新增，clampInt 不动）+ `agent.ts` compactAt 换用（EFF 十个整数档位维持 clampInt） | kernel-tool-output +3（核心回归：0.8 生效为 0.8） | ✅ |
| R-2 earlyDispatch 排除 tool_search | `agent.ts` earlyDispatchHook cacheable 门后按名排除（同文件定义非跨模块魔法串） | kernel-agent +1（结果无「已提前执行」标注，真实执行断言） | ✅ |
| R-3 unknownRounds 批级计数 | `agent.ts`：runOneCall 内两处调用级增删移除；批执行后按 `executed.some(e => !tools[e.name])` 计轮 | kernel-agent +2（混批 3 轮终止——旧语义永不终止；交替轮清零不误杀） | ✅ |
| R-4 steerQueue 上限 | `agent.ts` steer：上限 50 满丢最旧 + system.notice 诚实告知 | kernel-agent +1（60 条→50 条注入 + 丢弃 notice 可见） | ✅ |
| R-5 Map/Set 淘汰 | `agent.ts`：evictSessionState（64，sessionClocks/sessionFlags 两处接线）+ durableRecoveredNotified 上限 256 | 无专门单测（行为等价上界——淘汰路径各为「时钟重建/标志重置/通知重发一次」，均既有语义，无外部可观测差异；取舍已记录） | ✅ |

**门禁**：`npm run typecheck` 零错 → 相关 4 套件 152/152 → 全量 `npx vitest run` **2591 passed / 11 skipped（基线）/ 0 failed**。

**行为变化说明（R-3 唯一语义变更）**：混批含未知工具的连续轮从此计入终止阈值（旧：混入任一已知工具即清零）。既有 gap 用例（每轮纯未知批 ×2 终止）与全部 2591 用例行为兼容。

## 7. 附录：kimi-cli 差距对齐台账（4/7→5/7 状态持久化）

| # | 差距项 | 状态 | 本仓落点 | kimi 锚点（亲验） |
|---|---|---|---|---|
| B | 后台通知回流 | ✅ 已合入（f88e3b10） | agent.ts noticeQueue（loop 顶注入） | kimisoul.py:1135-1164 deliver_pending |
| C | 输出 token 钳制 | ✅ 已合入 | agent.ts outputMaxTokens / providers.ts maxTokens 字段分流 | kimisoul.py:1348-1387 _compute_completion_overrides |
| D | 历史归一化 | ✅ 已合入 | historyNormalize.ts（user+user/system+system，宽于 kimi） | dynamic_injection.py:58-84 normalize_history |
| E | 工具去重复用 | ✅ 已合入（当日 C3 键序 canonical 化收口） | cacheable + toolCache + batchInflight + canonicalToolArgs | toolset.py:365-423（_canonical_tool_arguments） |
| F | 流式中途派发 | 🔶 批次2 已实现待提交（当日 C2/R-2 收口） | llmStream onToolCallReady + earlyRuns | 注：kimi 源码未见 on_tool_call 锚点（wxnodus 自研演进），如实记录 |
| G | Notification hook | ✅ 当日 P2-15 接线补齐 | agent.ts 通知注入点 hooks?.notification | kimisoul.py Notification hook |
| — | 其余 2 项 | ❓ 原差距文档已随 UI 删除提交消失，无法复原——以本台账为新事实源 | — | — |
