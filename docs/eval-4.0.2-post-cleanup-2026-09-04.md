# wxnodus 4.0.2 清理批后评估：内核 / 全代码 / 设计 / 竞品差异（2026-09-04）

> **取证基线**：git HEAD `d0acfc8b`（清理批闭环后）；批次起点 `1cc334fe`，批次 diff 550 文件 +575/−108,136 行。竞品锚点沿用 docs/eval-vs-competitors-2026-08-27.md（六家克隆 file:line 基线，克隆目录已按约束删除）+ 2026-09-04 web 检索（codex/Claude Code 近两周动态，来源见 §5.5）。
> **与收尾版的关系**：docs/eval-4.0.2-comprehensive-2026-09-04.md（收尾版）评估于清理批之前；本报告为**清理批后复核版**——评分与台账以本表为准，收尾版中已被本批改变的结论逐项标注。
> **方法**：清理批执行会话的一手取证（CI 八轮远端日志、根因链四层、全部门禁实测）+ 当前 HEAD 量化复核（行数地图/巨文件/环 allowlist/关键域 grep）+ 竞品基线文档增量更新。

---

## 1. 总评

清理批兑现了收尾版 §7 的「把事做薄做净」主题：**结构债最大三项（10.8 万行 ink fork 死重、双组合根、版本解析三套）全部清偿**，并意外修复了比报告所知更深的工程卫生问题（master CI 六天红的四层根因链——.gitignore 无锚定吞源码 / build 顺序 / typecheck 依赖构建产物 / 测试随 CRLF checkout 漂移，全部根治且多数转化为新门禁或封闭化测试）。竞品差距中三项（TUI 形态、durable queue、评测 harness）已闭环或起步闭环。

剩余短板收敛为两类：**渐进项**（agent.ts 巨闭包不降反升、handlers 族巨文件、kernel→infrastructure 反向穿透、记忆时间衰减）与**战略项**（npm 未上架、生态广度、单平台）。

| 评分面 | 收尾版 | 本版 | 一句话变化 |
|---|---|---|---|
| 内核（9 域） | A- | **A-（构成改善）** | +durableQueue/B1/B3/K2 闭环；−agent.ts 膨胀至 2133 行、K1 时间衰减仍缺——正负对冲 |
| 全代码/设计 | B+ | **A-** | 死重清偿（最大扣分项移除）+ 组合根唯一化 + 魔数派生 + 文档对齐；巨类残留 |
| 质量与测试 | A- | **A** | 门禁 12→16、六天红根治、Q5 复活、smoke:tui 观察位；Q3/Q8 残留 |
| 竞品站位 | 独有 7 项 · 差距 5 项 | **独有 8 项 · 开放差距 3 项** | TUI/durable queue/评测 harness 三差距闭环；分发/生态/跨平台仍开放 |

---

## 2. 内核评估（src/kernel · 123 文件 / 22,415 行——较收尾版 +2,781 行）

### 2.1 分域评分（变化项加粗）

| 内核域 | 评分 | 核心机制（维持项引自收尾版锚点，不再重复取证） | 本批变化 |
|---|---|---|---|
| ① 代理与回合工程 | A- ↓ | 轮次可配+签名级循环检测+LLM 双确认+预算硬停+image_url 三层能力门（维持） | **agent.ts 1759→2133 行（+374）**——B1 心跳/B3 治理/durable queue 接线全部堆进单闭包，K4 恶化；durable queue 落地本身是 A 面增强（入队先于模型处理+终态收口+崩溃恢复如实告知） |
| ② 记忆黑洞 | B | 三层+FTS5 bigram+sqlite-vec 混合召回+压缩保尾（维持） | 无变化——**K1 时间衰减仍缺**（recallHybrid 排序仍无 recency 因子，memory.ts:313 实核）；embedAndStore fire-and-forget 不可观测仍开 |
| ③ 工具执行与安全 | A | POLICY_RULE_SOURCES 单一事实源+bash 分级+Low IL 实测校准+KF-010 fail-closed（维持） | 无变化 |
| ④ MCP 协议层 | A- ↑ | 双传输+id 关联+lazy-respawn 30s 冷却（维持） | **B3 落地加分**：/mcp list 在线/pid/内存/工具/最后调用列 + 未连接条目真实 initialize 探活 + /mcp idle 闲置自动下线（在途豁免、进程回收先于工具表同步）——真机证据在案 |
| ⑤ 屏幕/视觉 | A- | MJPEG 环缓冲+scene_score+NCC 积分图+四级 vision 通道（维持） | **termcap 三档字符系统**（full 圆角/basic 直角/ascii 保底，termcap.ts 三档表）——测试已同源化（tui-render boxRegexes 从 glyphs() 派生，任何档位环境断言一致） |
| ⑥ 更新/分发 | A- ↑ | 绝不自动安装+sha256+回滚+zip-slip 三重校验（维持） | **K2 闭环**：版本解析统一 semverRange.parseVersion 出口（selfUpdate/bundle 切换+调用方一致性契约锚定 fail 方向语义差异）；版本双渠道/清单维持 |
| ⑦ 进程与并发 | A ↑ | 有界进程树+HMAC token+拒绝伪造关闭（维持） | **B1 落地加分**：心跳默认开启+行尾 pid；processScan.ts 进程枚举单一事实源；/doctor 孤儿进程/心跳断档双体检项（tmp-n9 孤儿模拟真机检出） |
| ⑧ 身份/审计 | A- | instanceIdentity 原子落盘+审计哈希链+密钥机器指纹（维持） | 无变化（换机无迁移路径仍开） |
| ⑨ 横切质量 | B+ ↑ | kernel 零 UI/CLI 依赖+全注入 seam（维持） | **环 allowlist 复核**：src 内部环 4 个**全部为良性已登记**（type-only/dynamic import，逐条带理由）——收尾版「六处双向环」口径中非良性部分已在存量批次修复；**K3 微改善**：reset seam 现有 3 处（localVision/llmStream/sysPackage），大多数模块级单例仍无 |

### 2.2 内核横切清单更新

| # | 严重度 | 状态变化 |
|---|---|---|
| K1 记忆时间衰减 | 高 | ⏳ 仍开（第四批 C5） |
| K2 版本解析三套 | 高 | ✅ **本批闭环**（统一出口+等价类契约，46 用例零漂移） |
| K3 单例 reset seam | 中 | 🟡 微改善（3/25+） |
| K4 agent.ts 单闭包 | 中 | 🔴 **恶化**（1759→2133）——下一批次优先拆分候选 |
| K5 MCP transcript | 低 | ⏳ 仍开 |
| K6 错误形状三态 | 低 | ⏳ 渐进 |

---

## 3. 全代码 / 设计评估（kernel 之外）

### 3.1 行数地图（当前 HEAD 实测）

| 层 | 行数 | 较收尾版 |
|---|---|---|
| kernel | 22,415 | +2,781（B1/B3/durableQueue/版本清单） |
| application | 7,842 | +662 |
| infrastructure | 5,718 | +494 |
| domain | 2,516 | +257 |
| bootstrap | 772 | −?（**双组合根删除后仅剩 cliComposition 单根 489 行**——A4 闭环） |
| commands(+ext) | 7,836 | −3,467（收尾版 11,303——巨文件拆分持续推进：agentFlowCommands 1068/sessionCommands 988 已从 handlers 族析出） |
| cli | 3,435 | +392 |
| tui | 3,963 | **官方 Ink 6 重建**（收尾版口径 3,521 为 fork 删除前混算） |
| 其他（protocol/store/release/presentation/app/lib/build） | ~6,030 | — |
| **src 合计** | **~60.5k** | 结构性瘦身：**packages 死重 106,229 行已删**（hermes-ink/hermes-tui/wxnodus-ink/hermes-shared 四目录，git 历史保留） |

### 3.2 设计面结论更新

- **A2/A4 闭环**：三套 ink fork 彻底删除（用户裁决），README/AGENTS 技术栈文案对齐「官方 Ink 6 + 自研组件层」事实；createApplication 死组合根+五桩+hermes-gateway 整删，组合根唯一化（cliComposition 三阶段 fail-closed 范式成为唯一根）。
- **A5 闭环**：命令计数全部 SLASH.length 派生（registry/tui 模板串+源码零硬编码测试锁）——「126/108」魔数漂移类缺陷从结构上杜绝。
- **A1 渐进未完**：kernel→infrastructure 反向穿透仍在（实核：agent.ts:32 policyLayers、llmOnce.ts:7 outboundFetch、market.ts:14-21 boundedResponse/safeTarArchive/outboundTargetPolicy 三处）——port 化注入仍是下一阶段主题。
- **A3 巨文件族**：commands 面已显著拆分（11,303→7,836），但 kernel 侧恶化——Top 巨文件：**agent.ts 2133**、tools.ts 1759、cli/index 1354、profileMemoryBuildCommands 1168、handlers 1154、runtime 1120。
- **A7 闭环**：三包版本 4.0.2 对齐 + publish-local 发布前版本一致性 fail-closed 断言（防再漂移）。
- **A8 观察维持**：presentation(ANSI) 与 tui(Ink) 双呈现层并存——Ink 6 定型后 tui 面已稳，观察期结论趋向长期共存（wire 渲染器与交互组件层职责不同）。

### 3.3 本批新发现的工程卫生证据（收尾版未覆盖）

**master CI 六天红根因链**（2026-08-29~09-04，八轮远端取证）——四层叠加，每层本地皆绿（被旧 dist/旧链接/本地文件侥幸掩盖）：

1. `.gitignore` 无锚定 `migrations//release/` 静默吞源码目录（`git add src/` 跳过不报错）→ 根锚定修复+注释存档；
2. build 顺序：`build:core` 依赖根包 dist 却跑在 swap-dist 之前 → 顺序修正；
3. `typecheck:tests` 经 core-facade 测试拉入 core 源码，间接依赖构建产物 → paths 映射解耦（类型检查与产物彻底分离）；
4. N2 压缩回归测试读仓库真实文件，est 算术随 CI CRLF checkout 漂移 → 封闭化为临时工作区文件（同文件 1476 行已有先例范式）。

**方法论结论**：这四层全部是「本地绿、CI 红」的环境耦合类缺陷——清理批把它们分别转化为锚定规则/顺序修正/解耦映射/封闭化测试四类**不可复发**的修复。配套地，ci 链新增 lock 零 diff 核账与文档对账豁免机制（历史快照/反引号 token/退役表三层）。

---

## 4. 测试与质量纪律

| 项 | 当前实测 |
|---|---|
| 规模 | 381 测试文件 · 静态 it 2,695 · **运行基线 3015 passed + 11 skipped**（清理批后；净删 16 用例=死组合根/hermes-gateway 测试） |
| 门禁 | **16 命令**（收尾版 12）：typecheck×2 + **typecheck:sdk + typecheck:core（新增）** + build + test:all + known-failures + 发现/覆盖 + **check:registry-consistency 126=126=126=126（新增）** + lint + 环 + docs×2 + eval selftest |
| 远端 | GitHub Actions windows-latest 三 job（gate/vscode-ext/install-smoke）+ test 三分片；单轮 9~13 分钟；**六天红已修复**（run 33834843578 首绿 → 33837703220 最终绿） |
| smoke:tui | 本地三连跑绿 + **CI 观察位挂载**（continue-on-error；远端首跑 success——观察点 1/5；升格硬门禁条件：连续 ≥5 轮绿或一周） |
| known-failures | 三态注册表维持；KF-002（hermes-gateway）随代码删除成为历史台账条目如实保留 |

残留缺口（沿收尾版编号）：

- **Q3（高）hasDist/skipIf 静默 skip**——真机层用例在无 dist 环境静默跳过，「3015」可能不含进程级契约层的完整面。**六天红事件强化了此缺口的重要性**（本地绿≠可复现绿正是同一族问题）——建议下一批与 B2 同做。
- Q8（低）测试计数 ratchet 仍缺——check:test-count 下限锁定待办。
- Q6 脆性断言——本批已根治 2 处（tui-render 档位、N2 CRLF），同类扫描可继续。

---

## 5. 同类 CLI 差异与缺陷对比（竞品基线 2026-08-27 + 增量）

### 5.1 收尾版差距清单的闭环核账

| 差距项（收尾版 §5.2） | 状态 | 证据 |
|---|---|---|
| 高·生态广度最薄（无桌面/Web、VS Code 插件 2 源文件） | ⏳ 仍开放 | wire/serve/ACP 开放面维持；SDK/插件增厚未动 |
| 高·任务级评测 harness 缺位（仅微基准） | 🟡 **起步闭环** | scripts/eval 28 任务（t1-t28）+ runner + selftest **已入 ci 链**；距 SWE-bench 级广度尚远（对位 aider），但「确定性结局断言」骨架成立 |
| 中·分发未闭环（npm 未上架、默认 feed 未配） | ⏳ 仍开放 | `npm view wxnodus` 404（2026-09-04 实测）；publish-npm.yml 就绪待官方 Release |
| 中·MCP 无持久 transcript | ⏳ 仍开放 | K5 维持 |
| 低·循环检测单模型 / 工具缓存键未 canonical 化 | ⏳ 仍开放 | loopJudge 单模型维持；args 键序敏感维持 |
| ——（收尾版 TOP10 #1 durable queue P0） | ✅ **闭环** | src/kernel/durableQueue.ts（P2-14）入队先落盘+终态收口+stale 恢复，agent/flowPage 已接线——codex 机制对齐完成（收尾版勘误确认，本版维持结论） |
| ——（收尾版 TOP10 #2 评测 harness P0） | 🟡 同上起步闭环 | 见上 |

另：基线版 §5.1「无交互 TUI——七家唯一」这一**战略级形态缺口已闭环**（官方 Ink 6 + 自研组件层重建：三页帮助/选择器/审批浮层/钉底结构验收测试 40+ 用例）；§5.4 文档卫生五项中断链三份协议文档、AGENTS 悬空引用、面向用户文档断层（user-guide.md 126=126 命令对账）**均已在存量批次+本批闭环**，且 docs-links 门禁（含三层豁免）现已同时覆盖脚本与测试双面。

### 5.2 独有优势（竞品无对应形态——较收尾版 7→8 项）

1-7. 诚实标注文化 / 检索式长期记忆 / 常驻屏幕视频流 /watch / 组件注册探活 /oasis / Mod 整合包+版本双渠道 / 本机实例身份+卡死自愈（维持，锚点见基线文档 §4）。

8. **新增：门禁密度与「本地绿=远端绿」工程**——16 命令门禁 + CI 同源纪律 + 六天红四层根因的全根治（含 CRLF/产物解耦这类环境耦合免疫），门禁工程深度对七家竞品的领先幅度扩大（codex 401 TODO/opencode executeStream 未实现等纪律缺口维持，见基线 §4.6）。

### 5.3 仍开放的差异化缺陷（按严重度）

| 级 | 缺陷 | 对位竞品证据（基线锚点） |
|---|---|---|
| 战略 | **npm 分发未上架**——安装摩擦（一键 GitHub 直装已就绪但非包管理器主渠道）；更新 feed 默认未配 | codex npm+brew+GitHub Releases 三渠道；gemini/opencode npm 直装 |
| 战略 | **生态面**：无官方 SDK 成品/桌面/Web/深度 IDE 集成 | codex TS+Rust 双 SDK + app-server；opencode SDK+Electron+Slack+GH Action；Claude Code 插件+Agent SDK 生态（且 2026-06 起 Agent SDK 计费独立化，生态投入加码） |
| 中 | **Windows 独占**——放弃 macOS/Linux（六家全跨平台；codex Rust 单二进制跨平台分发） | package.json os:["win32"] |
| 中 | 机制长尾：循环检测单模型（gemini 双模型 0.9 置信度）/ 缓存键 canonical 化（kimi）/ /btw 旁路（kimi）/ D-Mail 时间旅行（kimi）/ MCP transcript（现代 /mcp 内存面 vs audit 全留痕不对称） | 基线 §5.3 表 |
| 低 | 单一模型供应商依赖深度绑定 BYOK 路线（无 OAuth——有意裁决，维持） | 基线 §5.1 |

### 5.4 基线后竞品动态（2026-09-04 检索）

- **codex**：Rust 化持续深化（单二进制免 Node、~95% Rust），分发三渠道并进；ChatGPT 登录用户 8/31 起被限制 GPT-5.4 系模型（API key 专属）——**BYOK 路线的价值反向强化**（wxnodus 定位受益）。
- **Claude Code**：v2.1.260（全屏 diff 面板、headless/桌面命令扩展）；Agent SDK 于 2026-06 计费独立后生态投入加码——**生态差距项的战略压力增大**，建议 SDK 转公开优先级上调。

### 5.5 来源

基线：docs/eval-vs-competitors-2026-08-27.md（六家 file:line 锚点）。动态：[InfoQ codex Rust 报道](https://www.infoq.cn/article/o5iuvfmdjwkkakxfzhzp)、[iThome](https://www.ithome.com.tw/news/169341)、[知乎 codex 安装教程 2026-09-03](https://zhuanlan.zhihu.com/p/2074880096264111344)、[ChatGPT/Codex 更新日志](https://learn.chatgpt.com/zh-Hans/docs/changelog)、[Anthropic Release Notes 2026-09](https://releasebot.io/updates/anthropic)、[Agent SDK 计费变化](https://usagebox.com/articles/anthropic-june-15-agent-sdk-credit-split-claude-4-retirement)、[Claude Code Changelog](https://claudefa.st/blog/guide/changelog)。

---

## 6. 缺陷台账总更新（四路合并后状态）

| 编号 | 严重度 | 状态（本版） |
|---|---|---|
| A2/A4/K2/A5/A7/Q2/Q4/Q5/Q1(B4) | — | ✅ **清理批闭环**（B4 处观察位阶段②，升格条件在案） |
| D1-D5（无密钥退出码/文案三件套/offline 行） | — | ✅ 存量批闭环（收尾版已记） |
| B1/B3 | — | ✅ 已落地（收尾版已记） |
| K4 agent.ts 单闭包 | 中→**中高** | 🔴 恶化（2133 行）——建议与 B2 同批前置拆分 |
| K1/C5 记忆时间衰减 | 高 | ⏳ 第四批既定 |
| B2 进程树回收 | 高 | ⏳ 下一批次（单独执行） |
| Q3 hasDist 静默 skip | 高 | ⏳ 建议提级（六天红同族问题） |
| A1 分层解耦 | 高 | 🟡 渐进（环已全良性化；反向穿透 3+ 处仍在） |
| A3 handlers/巨文件 | 高 | 🟡 渐进（commands 面大降，kernel 面恶化） |
| K3/K5/K6/Q6/Q7/Q8 | 中低 | ⏳ 渐进 |
| D6/A4 更新 feed + npm 上架 | 低（外部条件） | ⏳ 待官方 Release 发布 |
| TOP10 #3-#6（/btw、hook 事件、双模型、canonical 键） | P1 | ⏳ 未动 |
| TOP10 #7-#10 | P2-P3 | ⏳ 观察/不追维持 |

## 7. 路线建议（下一阶段）

1. **B2 进程树回收**（既定第三批）——建议前置 **K4 agent.ts 拆分**（2133 行已是全仓第一巨文件，B2 又要动执行层，先拆后改回归面更小）；
2. **Q3 hasDist 提级**与 B2 同批（六天红证明了「本地绿≠可复现绿」的系统性风险）；
3. 第四批 C1-C3（OASIS 收尾）→ C5（=K1）→ C4/C6 维持既定；
4. **SDK 转公开**建议提级（Claude Code Agent SDK 生态加码的外部压力 + wire/serve/ACP 开放面已成，包装成本低于重建）；
5. B4 观察位跟踪（≥5 轮绿升格）；B5 wire 版本化随批顺带。

> 历史证据链：docs/eval-4.0.2-comprehensive-2026-09-04.md（收尾版）· docs/eval-vs-competitors-2026-08-27.md（竞品基线）· docs/cleanup-batch-plan-2026-09-04.md + docs/improvement-master-plan-2026-09-04.md F 节（清理批闭环记录）· CI run 33834843578 / 33837703220（六天红转绿证据）。
