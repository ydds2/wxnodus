# wxnodus 4.0 内核评估与竞品差异缺陷说明（2026-08-27）

> **复评更新（2026-08-27 晚·同日第二轮）**：本报告 §3 缺陷清单中的 3-1/3-2/3-5 已在当日修复波（工作区未提交，40 文件 +1787/−1538，全部标注 C1/C2/C3/P2-14/P2-15/A2/A3/P1-4/P1-6）中修复并带测试；3-7 由「观察」升级为**坐实缺陷**；另新增六项机制（两项正是本报告 §4 列出的竞品差距项）。复评明细见 §3.5。内核测试 171/171 绿（kernel-agent 89 + kernel-permissions 46 + kernel-llmStream 36）。

> **评估口径**：仅内核 `src/kernel/`（UI 已于 ee63a5b2 整体移除，非交互入口不改动内核主线）。
> **基线**：git HEAD f88e3b10（kimi-cli 批次1，差距对齐 4/7）+ 未提交批次2（流式中途派发）；全量 2539 测试绿、typecheck/lint/cycles 绿。
> **证据纪律**（audit-context-building 采纳）：结论一律带 `file:line`；本轮亲自复核的锚点标 ✅；沿用 2026-08-21 审计锚点但本轮未复核的标 ⚠️；无法取证的明写「未取证」，不猜测当事实。
> **本轮精读**：agent.ts（全文）、llmStream.ts（全文）、providers.ts（全文）、historyNormalize.ts、toolOutput.ts、events.ts、permissions.ts 要点、tools.ts cacheable 面、kimi-cli 四机制锚点（kimisoul.py / dynamic_injection.py / toolset.py）。

---

## 1. 总体判断

**架构质量高于实现完成度**的 8-21 结论本轮复核仍然成立，且经过 V4 六波修复后，运行时工程（重试/超时/压缩/编码）已追平安全工程。三条突出气质：

1. **诚实标注文化**（独有竞争力）：截断必标注、缓存命中必标注、提前执行必标注、蒸馏必标注、未知窗口不写字段零破坏、空输出归一为「（无输出）」——模型与用户永远知道发生了什么（`toolOutput.ts` maskNote/offload 预览、`agent.ts:1502,1510,1584`）。
2. **事件闭环纪律**：`finishEarly` 保证任何提前返回都发 `agent.message`+`agent.end`（`agent.ts:1225-1229`），「35 工具调用后无输出」类缺陷被结构性消灭；`events.ts:81` 高频 token 事件不落盘+4MB 轮转。
3. **前缀缓存工程**：字节稳定键序重建（`providers.ts:212-223`）、会话冻结时钟（`agent.ts:232`）、相邻同角色合并（`historyNormalize.ts`）三者协同，DeepSeek 自动前缀缓存从第一段起可命中——多数竞品（含 opencode 被点名的问题）做不到。

**主要风险面不在机制设计，而在「接线层」与「半成品灰度功能」**（见 §3）：8-21 审计四大根因之首「精心设计的安全机制被接线层短路」又出现一例。

---

## 2. 内核各域评估

| 域 | 成熟度 | 亮点（锚点） | 缺陷/风险 |
|---|---|---|---|
| 主循环与工具执行 | 高 | 确定性结局三处同源（`lastToolOutcome`，agent.ts:763/1523/1560）废除「失败/异常」子串启发式；并行调度读写门（只读并行/含写串行，agent.ts:1573-1596）；批量槽位保序+tool_call_id 各自保留；未知工具/循环/空转三检测分级可配（EFF，agent.ts:246-258）；轮次耗尽强制总结再诚实兜底（agent.ts:1677-1698） | `require()` 接线死代码（§3-1）；`unknownRounds` 计数语义漂移（§3-6） |
| 流式传输 | 高 | 严格 SSE 解析器（尾帧宽容 B-17、tool_calls index 校验、[DONE] 语义）；双档 idle watchdog+全程硬顶（llmStream.ts:158-165）根治 120s 一刀切；等待网络模式 60s 封顶退避（llmStream.ts:580-596）；429 限额状态解析（llmStream.ts:191-200）；降级链+jitter 防风暴 | 无（本轮未见新问题） |
| 上下文工程 | 强 | 真实 usage 优先+EMA 校准（agent.ts:1279-1284）；micro-compaction→全量压缩→413 强压重发三级（agent.ts:1305-1415）；旧工具掩码（toolOutput.ts:141-167）；输出 offload 落盘+续读提示；中断恢复工具产出回放（agent.ts:1156-1169） | `clampN` 对浮点阈值（compactionThreshold=0.75）的处理未复核（未取证）；steerQueue 无上限（agent.ts:723） |
| 供应商层 | 强 | AES-256-GCM 机器指纹密钥+provider 归属校验（providers.ts:76-113）；四层图片守卫（能力门→历史文本化→发送前 textify→视觉通道描述，providers.ts:291-299）；o 系/gpt-5 省略 temperature 与 max_completion_tokens 字段分流（providers.ts:239-278） | 无 |
| 权限与沙箱 | 强（机制）/ 中（接线） | bash 分段+`$()`/反引号递归分类+只读白名单加严（permissions.ts:206-244）；SENSITIVE_WRITE 下沉 apply_patch targets（permissions.ts:318-327）；规则 deny>allow>ask+execpolicy 首词索引；fail-closed 审批默认 | **sandboxFastPath（M-3 双速权限试点）接线死代码**（§3-1）——机制存在、开关永远不生效 |
| 工具层 | 高 | `cacheable` 声明式纯读标注（9 个内置+tool_search，tools.ts:143 等 9 处）替代硬编码名单，缺省 false fail-closed；tool_search 入装配链（热重载不丢，agent.ts:197-221）；参数 schema 前置校验+坏 JSON 哨兵回喂自纠（agent.ts:1483-1489） | 缓存 key 未做参数 canonical 化（§3-5） |
| 子代理 | 中上 | 深度限制+只读工具集+危险工具按 danger 动态剔除（agent.ts:577-631）；preToolUse 钩子继承；通知不回流防污染（backgroundNotify:false） | 无 |
| 记忆/事件/持久化 | 中（冻结维护轨） | events.jsonl 分级落盘+轮转；checkpoint 自动快照限 10 份（db.ts 差距 #6）；审计哈希链 | sessionClocks/sessionFlags Map 只增不减（§3-9） |

---

## 3. 本轮新发现缺陷清单（按严重度）

### 3-1【中】sandboxFastPath 接线用 `require()`——NodeNext ESM 下永远抛错，双速权限试点静默失效

- **锚点**：`src/kernel/agent.ts:676`（`require('./winSandbox.js')`）+ `tsconfig.json:4`（`"module": "NodeNext"`）。
- **机理**：agent.ts 全文件 ESM（其余动态导入均为 `await import()` 形态），ESM 作用域无 `require` → 求值抛 ReferenceError → 被 `try/catch` 吞掉 → `modeVerdictOpts` 恒 `undefined` → `settings.sandboxFastPath===true` 也不传入 modeVerdict → 双速权限（M-3「沙盒内免审批」试点）**真实运行中永不生效**。
- **证据佐证**：`tests/kernel-permissions.test.ts:299-310` 直接以显式 opts 测 modeVerdict 纯逻辑——接线层（agent.ts:672-680）零测试覆盖，绿测试掩盖死接线。
- **定性**：8-21 审计根因①「安全机制被接线层短路」的第二次出现（首例是 S-3 system-touch 被 mark 秒过）。
- **修复建议**：改 `await import('./winSandbox.js')`（modeVerdictOpts 的 IIFE 改 async 或惰性启动时预加载）；补一条 agent 级接线测试（settings.sandboxFastPath=true 且沙盒开启时，低危写走 approve 免审批）。

### 3-2【低】批次2：提前执行结果把标注文案一并入 toolCache

- **锚点**：`agent.ts:1510-1518`——`out = (await early) + '（…已提前执行…）'` 后 `toolCache.set(cacheKey, out)`。
- **后果**：下一轮同参缓存命中（agent.ts:1502）会再叠一句「结果已缓存」，模型看到两条时序矛盾的标注（「提前执行」标注随缓存传播到它从未提前执行过的回合）。诚实性轻微受损，非功能故障。

### 3-3【低】批次2：tool_search 被 cacheable 提前派发有隐藏副作用

- **锚点**：`agent.ts:198-208`（tool_search.run 内 `activeToolNames?.add(h.name)`）+ `agent.ts:1385`（`def.cacheable !== true` 才拦）。
- **后果**：流式中途提前执行 tool_search 会激活工具（副作用）；流失败后结果被丢弃但激活残留（无害，仅「只读无副作用」宣称不精确）；提前派发期间 `executeTool` 同样发 `agent.tool` start/complete 与 sessionStream 事件，流失败丢弃结果后事件流留有执行痕迹（审计噪音）。

### 3-4【低】批次2：`index-advanced` 就绪信号依赖的流式不变式对非标端点不成立

- **锚点**：`llmStream.ts:439-444`（新 index 首 fragment ⇒ 更小槽位完整）。
- **评估**：对 OpenAI 兼容端点成立；对交叠分片的非标端点是「可能拿到半截 arguments」→ `safeJson` 抛错被静默吞掉（agent.ts:1391）→ 流尾走原路径。**防御已足够**（fail-closed 回退），仅记录为已知假设，无需改。

### 3-5【低】工具缓存 key 未 canonical 化参数——键序敏感

- **锚点**：`agent.ts:1492`（`JSON.stringify(c.args ?? {})`）对比 kimi `toolset.py:365`（`_canonical_tool_arguments`，✅ 亲验）。
- **后果**：同语义不同键序（模型两次生成的 JSON 键序不同）→ 缓存 miss → 纯读工具重复执行。概率低、代价小；kimi 显式做了 canonical 化，wxnodus 没有。

### 3-6【低】unknownRounds 计数被同批有效工具清零

- **锚点**：`agent.ts:1479-1491`（未知工具 `unknownRounds++`，随后任一有效工具 `unknownRounds = 0`）。
- **后果**：「连续 N 轮未知工具终止」退化为「整批全未知才计数」——模型混入 1 个已知工具即可永远规避未知工具终止（轮次上限兜底仍在，非无限循环）。语义与注释宣称不完全一致。

### 3-7【观察】clampN 用于浮点阈值未复核

- `agent.ts:1297` `clampN(settingsAny?.compactionThreshold, 0.75, 0.5, 0.95)`——clampN 定义本轮未定位（grep 未命中 kernel 目录，可能在别处），若实现为整数 floor 化则 0.75 被破坏。测试全绿说明默认路径正常，但 settings 覆盖路径的浮点处理待查。

### 3-8【观察】steerQueue 无上限 / 3-9【观察】sessionClocks/sessionFlags/seenJobIds 之外的两个 Map 只增不减

- `agent.ts:723`（steerQueue 无 cap，对照 noticeQueue 的 50 上限）；`agent.ts:232,267`（会话时钟与标志 Map 无淘汰——长驻进程多会话场景微泄漏）。均属工程债级。

### 3.5 复评（2026-08-27 晚）——当日修复波核验

**已修复（含测试实证）**：

| 原编号 | 修复标记 | 核验结论 |
|---|---|---|
| 3-1 require() 死代码 | C1 | ✅ `agent.ts:696-712` 惰性 `await import` + 一次性解析缓存（`modeVerdictOptsResolved`）+ 加载失败诚实降级；**两处 modeVerdict 调用点（:876,:879）全数换用 `await resolveModeVerdictOpts()`**，无残留直调；带正例（真实文件写出）+ fail-closed 反例两条接线级测试。**额外收获**：修复中发现 permissions.ts `isWithinDir` 有**同病根第二处**（`require('node:path')`）一并修复（顶层静态导入）——同病根扫描是正确直觉 |
| 3-2 缓存标注污染 | C2 | ✅ `agent.ts:1553-1567`：缓存入库裸结果 `earlyRaw`，标注只加当轮回填；测试断言「同 run 内缓存命中不携带标注」 |
| 3-5 缓存 key 键序敏感 | C3 | ✅ `canonicalToolArgs`（`agent.ts:185-191`，sortKeysDeep 递归排序 + 循环引用诚实回退链）；**三个 key 构造点统一替换**（提前派发 :1431 / 回合缓存 :1536 / 批内去重 :1628）——对齐 kimi `_canonical_tool_arguments` 语义 |

**升级确认**：

- **3-7 → 坐实缺陷（低-中）**：`clampN` 实为 `clampInt`（`agent.ts:164` ← `toolOutput.ts:23-27`：`Math.floor` 后 `n<=0` 回退默认）——`compactionThreshold` 传入 (0,1) 区间任何小数（如 0.8）→ floor=0 → **静默回退默认 0.75，该配置项实际不可用**（整数 1 会夹到 0.95，同样非用户意图）。修法：浮点阈值专用 clamp（不做 floor、判 `Number.isFinite` 即夹取）。

**仍开放**（→ **当晚已全部收口**，见 `docs/kernel-remediation-2026-08-27.md` 执行记录：R-1 修 3-7 / R-2 修 3-3 / R-3 修 3-6 / R-4 修 3-8 / R-5 修 3-9；+7 单测，typecheck 零错，全量 2591 绿；3-4 维持记录不改）。

**当日新增机制（评估驱动 + 竞品差距补齐）核验**：

| 标记 | 机制 | 核验结论 |
|---|---|---|
| P2-14 | 用户消息持久队列（codex durable queue 对齐） | ✅ 语义正确：入队先于回合处理（崩溃不丢用户消息）、队列保消息不保结局（结局归 RunContext+checkpoint，不双写）、stale 恢复每会话一次通知、子代理排除；存储层规范（`kernel/durableQueue.ts` + SCHEMA_VERSION 12 迁移）。**本报告 §4 的「codex durable queue 未取证是否落地」就此关闭——现已落地** |
| P2-15 | Notification hook 接线（kimi 对齐） | ✅ `agent.ts:1299-1303` 通知注入点补调 `hooks?.notification`；注释自证「契约早已存在、接线缺失（死接线同类）」——**本报告 §4 的「wxnodus 无通知 hook 事件」差距就此关闭** |
| A2 | 统一出站 fetch（env 代理 + 私网直连） | ✅ 新基础设施 `infrastructure/http/outboundFetch.ts`（139 行：proxyOverride/noProxy 合并/私网判定）；七个内核出站点（mcp/vision/a2a/selfUpdate/ssrf/execServer/llmOnce）统一接入；SSRF 判定仍在 URL 层先于代理（策略不因代理打折）；vision/llmOnce 用静态导入并注明「动态 import 微任务延迟破坏同步契约」——细节考究 |
| A3/P1-4 | 三层策略（全局>用户>项目）+ applyRules 排序精化 | ✅ priority > 具体度（有 pattern 先）> deny>ask>allow 三级平局裁决（`permissions.ts:128-146`）——修复「注释宣称 deny 优先但从未实现」；带平局/优先级正反测试；doctor 增策略层检查项（损坏如实 fail） |
| P1-6 | grep 二进制解析升级 | ✅ PATH 之外探测 Git for Windows 常见安装路径（Program Files/LocalAppData）——「装了 Git 没进 PATH」机器上 grep 可用 |
| — | market 共用下载面 / doctor 代理面 | ✅ `downloadNpmTarball` 抽出为三类安装共用；doctor 增网络代理检查（info/ok 分级） |

**复评结论**：当日修复波质量高——三处修复全部带接线级/边界级测试（含反例），两项新增机制精准关闭本报告列出的竞品差距，且 permissions.ts 同病根第二处的发现说明修复者做了病根扫描而非只修点名处。**唯一新坐实问题为 3-7（compactionThreshold 配置失效）**，建议随下一批顺手修复。

---

## 4. 与竞品的机制差异矩阵

> ✅ = 本轮亲自复核锚点；⚠️ = 沿用 8-21 审计锚点（本轮未复核，clone 版本可能有差异）；— = 竞品无对应/未取证。

| 机制 | wxnodus（落点） | kimi-cli | opencode | gemini-cli | codex | crush | aider |
|---|---|---|---|---|---|---|---|
| 通知回流 | jobs.complete→noticeQueue→loop 顶注入（agent.ts:735-759,1257） | ✅ deliver_pending(limit=4)+Notification hook（kimisoul.py:1135-1164）——**wxnodus 无通知 hook 事件** | — | — | — | — | — |
| 输出钳制 | min(用户上限/预留, 窗口−已用) floor 1024，未知窗口不写字段（agent.ts:1285-1294,providers.ts:274-278） | ✅ max_completion_tokens=窗口−输入估算−安全余量（kimisoul.py:1348-1387） | — | — | — | — | — |
| 历史归一化 | user+user 与 system+system 合并（historyNormalize.ts:26-39） | ✅ 仅 user 合并+跳过通知消息（dynamic_injection.py:58-84）——**wxnodus 更宽** | — | — | — | — | — |
| 工具去重 | cacheable 声明式（缺省 false）+回合缓存+批内 inflight 去重（agent.ts:1500-1589） | ✅ 同批全工具 canonical 参数去重（toolset.py:365-423）——**kimi 对写工具同参同批也合并**（视同参为模型错误），wxnodus 只合并纯读（保守，防非幂等写误合并）；**kimi 有参数 canonical 化，wxnodus 没有** | — | — | — | — | — |
| 流式中途派发 | 批次2（未提交）：index-advanced 就绪→cacheable 先行（llmStream.ts:329-341,497） | 未取证（注释称 on_tool_call 参考；kimi soul 层为「收集完整结果后执行」模型，未见中途派发锚点） | — | — | — | — | — |
| 重试/断网 | 分类重试+等待网络 60s 封顶+可见 notice（llmStream.ts:144-156,580-611） | ⚠️ | ⚠️ 重试上限+jitter | — | ⚠️ UnboundedConnectionRetries 同族；**durable user-message queue 未取证是否落地** | ⚠️ mid-stream 恢复 | — |
| 压缩 | 真实 usage+EMA、micro→全量→413 强压三级（agent.ts:1279-1415） | ⚠️ 413→压缩→重试同族（agent.ts 注释引 kimi 0.20.2） | ⚠️ isOverflow→needsCompaction（✅ processor.ts:475-481 亲验） | ⚠️ chatCompressionService | ⚠️ ContextWindowExceeded 分支 | — | — |
| 流中断语义 | stream reset 事件（agent.ts:1431）+已收工具结果回放（agent.ts:1156-1169） | — | ⚠️ mid-stream 错误保留重试 | ✅ RETRY 事件「UI discard partial」（geminiChat.ts:76-84 亲验） | — | — | — |
| 编辑容错 | fs_edit 三级容错+行尾保真（applyPatch.ts 回灌） | — | ✅ detectLineEnding（edit.ts:23-27 亲验） | — | — | ⚠️ 空白自动纠正 | ✅ 四级降级（editblock_coder.py:134 起亲验） |
| 坏 JSON 回喂 | 哨兵消息「参数 JSON 无效：<片段>」自纠（agent.ts:1483-1489） | ✅ 同批 ToolParseError 回喂（toolset.py:356-363） | ⚠️ InvalidTool 伪工具 | — | ⚠️ RespondToModel | — | — |
| 权限模型 | 四模式+规则 deny/allow/ask+execpolicy 首词索引+会话授权（permissions.ts:311-327） | — | ⚠️ permissions 同输入重复拦截 | ⚠️ policy 分层 | ⚠️ 三维矩阵+auto_review | — | — |
| 沙箱 | winSandbox 双态令牌/Low IL（机制 ✅，双速试点接线失效 §3-1） | — | ⚠️ | ⚠️ sandbox | ⚠️ sandbox | — | — |
| MCP 自愈 | lazy-respawn 30s 冷却（mcp.ts） | — | — | — | — | ⚠️ reconcile 状态机（internal/agent/tools/mcp/lifecycle.go 亲验存在） | — |
| 循环检测 | 签名+输出短哈希+LLM 辅助判定+goal 空转检测（agent.ts:1610-1646,1766-1785） | ⚠️ force_stop_turn(tool_call_repeat)（kimisoul.py:1338-1342） | — | — | — | ⚠️ 死循环检测 | — |
| 事件流/审计 | typed bus+jsonl 轮转+哈希审计链 | ⚠️ wire.jsonl 线级回放（更强） | — | — | — | — | — |
| 撤销/恢复 | checkpoint 限 10+undoShadows+中断回放 | — | — | — | ⚠️ rollout/fork/归档 | — | ⚠️ 逐编辑 undo |

**差异结论**：wxnodus 在「可靠性工程 + 诚实标注 + 前缀缓存 + 中文 Windows」四个面上领先或持平；kimi-cli 在「通知 hook 事件、参数 canonical 化、线级回放」三处更深；codex 的 durable queue 与崩溃恢复、aider 的逐编辑撤销粒度是仍未对齐的两块（后者经用户裁决用 checkpoint+undoShadows 轻量替代，不追平属有意）。

---

## 5. kimi-cli 差距对齐现状（4/7 → 进行中 5/7）

| # | 差距项 | 状态 | 证据 |
|---|---|---|---|
| B | 后台通知回流 | ✅ 已合入（f88e3b10） | agent.ts:730-759 |
| C | 输出 token 钳制 | ✅ 已合入 | agent.ts:1285-1294 / providers.ts:274-278 |
| D | 历史归一化 | ✅ 已合入 | historyNormalize.ts + agent.ts:1064 |
| E | 工具去重复用 | ✅ 已合入 | tools.ts 9 处 cacheable + agent.ts:1574-1589 |
| — | 流式中途派发（on_tool_call） | 🔶 未提交批次2（+46/+26 行） | llmStream.ts:329-341 / agent.ts:1377-1392 |
| — | 其余 2 项 | ❓ 未取证 | 原「docs 差距分析」文档与 tests/gaps.test.ts 已不在仓库（后者随 ee63a5b2 UI 删除提交被删），7 项清单无法完整复原 |

**⚠️ 建议**：差距清单是活文档，但原文档已删。批次2 合入时（届时 5/7）请在 docs/ 持久化一份「kimi-cli 差距对齐台账」，避免清单只存在于提交信息与代码注释中。

**批次2（未提交）实现质量评述**：设计正确——就绪信号幂等（emittedIdx 每 index 至多一次）、fail-closed（cacheable 门+JSON 解析失败静默回退流尾）、流失败诚实 notice（agent.ts:1396-1399）、结局计量诚实记 other。风险点即 §3-2/3-3/3-4。修掉 3-2（缓存入库前剥离标注）即可合入，3-3/3-4 属记录级。

---

## 6. 建议动作（按优先级）

1. **修 3-1**（半天）：`agent.ts:676` 改动态 import + 补接线测试——双速权限是 R-8 登记的「低概率/高影响」面，开关静默失效比不开更危险（用户以为沙盒内免审批已生效）。
2. **批次2 收口**（1 小时）：修 3-2 后合入，同步补「差距对齐台账」文档（§5）。
3. **3-5 canonical 化**（半天，可选）：对齐 kimi `_canonical_tool_arguments`，键序排序后序列化做缓存 key。
4. **3-6/3-8/3-9**：工程债级，随维护批消化。
5. **未取证项回填**：codex durable queue 是否落地、clampN 浮点行为、kimi on_tool_call 锚点——三处建议下次评估前补验。

---

## 7. 结论

内核整体：**4.0 的内核已达到「可靠性工程」品类第一梯队**——流式/重试/压缩/图片守卫四根最硬的骨头都啃下来了，且有测试锁定；诚实标注文化与事件闭环纪律是同类中少见的工程气质。差距不在机制，在**接线层纪律与台账持久化**：一个 `require()` 让一个灰度功能静默失效，一份被删的差距文档让 7 项清单无法复盘——这两件事的修复成本都极低，先做。
