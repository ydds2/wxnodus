# wxnodus 4.1 路线清单：Windows 私有化 CLI——缺什么与做什么（2026-08-27）

> **战略定稿（用户 2026-08-27，本清单的唯一过滤器）**：
> 1. **只做 Windows 专属 CLI**——不跨平台、不做账号体系、不做官方 SDK 生态；
> 2. **主轴线 = 拉近与同类产品差距**（codex/gemini-cli/opencode/kimi-cli/crush/aider——抄机制与语义、不抄代码，实现原创并如实记录差异）；
> 3. **完全私有化**——数据不出机、BYOK 任意 OpenAI 兼容端点、气隙/内网一等公民；
> 4. **像区块链代币一样允许任何人二开成体系**——Apache-2.0 + 协议/扩展面公开（wire/serve/ACP/MCP/SKILL.md/AGENTS.md/plugins/hooks）+ `/bundle` 整包分发；
> 5. **只消费开源生态，不自建插件市场**——npm registry / GitHub topic 聚合消费（既有「只收不出」约束的延续），插件/skill/MCP 一律从开源市场接入。
> **明确不做**：跨平台、OAuth 登录、官方 SDK、自托管市场、内建 runtime 捆绑（2026-08-27 二次裁决）。
> **取证口径**：缺口全部带证据锚点（本会话 7 路深潜 + 内核复核 + 兼容性整改实测）；未取证明写。

## 〇、P0 执行进度（2026-08-27 实时）

> **P0 已完成（全 7 卡）**；P1 私有化核心 5/6 落地 + 1/6 发布准备交付（P1-2/3/4/6 ✅，P1-5 winget/scoop 三文件 manifest+发布指南 ✅，实际提 PR 待用户 GitHub 授权）。

| 卡片 | 内容 | 状态 |
|---|---|---|
| C1 | `agent.ts:676` 与 `permissions.ts:302` **双层 require() 死接线**——sandboxFastPath 静默永不生效（且 vitest 注入 require 垫片掩盖了生产死接线，已取证） | ✅ 已修：惰性 `await import` + 静态导入；agent 级接线测试（manual 模式判别器）+ 纯逻辑测试 |
| C2 | 批次2 提前执行标注随缓存传播（3-2） | ✅ 已修：缓存入库裸结果、标注仅本轮回填；新增同 run 缓存命中测试 |
| C3 | 缓存 key 无 canonical 化（3-5，kimi `_canonical_tool_arguments` 语义） | ✅ 已修：`canonicalToolArgs` 递归键序排序（数组顺序保持语义），三消费点共用 |
| C4 | 差距对齐台账持久化 | ✅ `docs/kimi-gap-alignment-ledger.md` |
| D1 | README 断链 3 份协议文档 + docs-links 门禁入 ci | ✅ 补 4 份文档 + `scripts/check-docs-links.mjs` 挂入 ci |
| D2 | AGENTS.md 悬空引用清理 | ✅ 已修 |
| D3 | wxnodus-ink 残留清理 | ✅ 已删 |
| **P1-2** | **企业代理（Phase1+Phase2）** | ✅ **已落地**：`infrastructure/http/outboundFetch.ts`（env 代理 + WinINET 系统代理 + 私网直连红线 + isPrivateHost/matchProxyOverride/mergeNoProxy）；接线 llmStream/llmOnce/vision×2/safeFetchText(ssrf)/mcp×2/selfUpdate/a2a×5/execServer；bootstrap 预取系统代理；doctor 网络代理检查项；9 单测（CONNECT 隧道 mock 代理 + 纯函数）；全量 2558 绿 |
| **P1-3** | **私有端点实测矩阵** | ✅ **已落地**：`scripts/evidence-private-endpoints.mjs`（mock 五类差异 × 7 轴实测：标准/reasoning/缺尾帧/无 usage/无工具/工具轮转）+ `docs/private-endpoints.md`（实测矩阵 + 五类端点接入命令 + 安全面交互 + 真机探针） |
| **P1-4** | **三层策略 + 审计导出** | ✅ **已落地**：`infrastructure/policy/policyLayers.ts`（全局 %ProgramData% > 用户 > 项目 .wxnodus/；全局 deny 不可放宽、allow/ask 具体层优先、层损坏诊断 fail-closed）；agent/doctor 接入；`/audit export --out [--format jsonl\|md] [--since] [--event]` + `/audit verify`（哈希链校验）；**顺带修复 applyRules 平局缺陷**（注释宣称 deny>ask>allow 但排序只比 priority——同 priority 下 deny 会被 allow 抢跑） |
| **P1-6** | **flaky 根治第一轮** | ✅ **已落地（结构性，非 skip）**：①grep 二进制解析自愈（Git usr\bin 常见路径 + 注册表 InstallPath——用户机器与测试环境不再依赖 PATH）②cli-wire-alias 模型调用改本地 mock 端点（WXNODUS_BASE_URL 注入，零网络确定性）③bash 续命时序预算 1.5s→2s（保留「静默才杀」语义） |

---

## 一、缺什么（差距清单）

### A. 私有化部署能力（最贴定位的缺口，最高优先级）

| # | 缺口 | 证据 |
|---|---|---|
| A1 | **分发仍依赖系统 Node（≥22.7）**——企业内网机器「先装 Node」本身就是部署摩擦；zip+install.ps1 已修好多 ABI（本日落地），但运行时未自带 | `package.json engines`；install.ps1 Node gate；devDeps 已有 `postject`（SEA 单 exe 路线可用） |
| A2 | **企业代理零支持**——src 全仓无 `HTTP(S)_PROXY/NO_PROXY/NTLM/PAC/ProxyAgent` 处理；Node fetch（undici）不自动读系统代理 → 内网代理环境模型调用必失败 | 全仓 grep 0 命中（本日取证） |
| A3 | **企业策略与合规面缺失**——权限规则仅本地文件；无「全局>用户>项目」策略层级、无审计导出/集中收集格式（审计哈希链只落本地） | `permissions.json` 本地规则；`audit.ts` 哈希链本地落盘 |
| A4 | **安装/分发面不全**——无 MSI/GPO 静默安装；winget/scoop 只生成 manifest 未实际发布 | `scripts/generate-package-manifests.mjs` 存在，发布动作无 |
| A5 | **私有端点实测矩阵缺失**——`/model add` 支持任意 OpenAI 兼容 ✓，但 vLLM/Ollama/LM Studio/one-api 中转/DeepSeek 本地化的实测兼容矩阵与文档为零 | README `/model add`；无对应文档/测试电池 |
| A6 | **离线资产不全**——气隙安装/升级 ✓，但无离线用户手册/错误码字典（内网机器无网可查） | docs/ 全为内部计划文档；H2 的 user-guide.md 未落地 |

### B. 产品形态（Windows 私有化 CLI 的日常体验）

| # | 缺口 | 证据 |
|---|---|---|
| B1 | **无交互 TUI——七家竞品唯一**；`-p` 一次性执行承载不了交互式开发。重建正解是「薄投影层」（wire 事件流→ANSI 渲染），OutputEvent 规范与投影管线残部仍在，不重蹈 ink 巨件覆辙 | `ee63a5b2` 删 UI；`protocol/events.ts`、`presentation/tui/frontend.ts` 残部 |
| B2 | **IDE 伴生太薄**——VS Code 插件仅 2 个源文件（命令+wire 桥）；私有化开发者的主入口是 IDE，缺成品 UI（诊断/diff/审批卡片） | `packages/vscode-ext/src/` 2 文件（本日复核） |
| B3 | 无内网 web 面板（可选）——`--serve` HTTP 网关已是开放面，企业内网面板可后置 | kimi web UI / crush 50 REST 为参考锚点 |

### C. 内核与可靠性差距（档案内，全部已取证）

| # | 缺口 | 锚点 |
|---|---|---|
| C1 | **`require()` 死接线**——sandboxFastPath 双速权限静默永不生效（最高优先） | `src/kernel/agent.ts:676` + `tsconfig.json:4` |
| C2 | 批次2（流式中途派发）未合入；缓存入库前未剥离「已提前执行」标注（3-2） | `agent.ts:1510-1518` |
| C3 | 工具缓存 key 未 canonical 化（kimi 已做 `_canonical_tool_arguments`） | `agent.ts:1492,1581` vs `kimi toolset.py:184-202` |
| C4 | kimi 差距对齐台账丢失（随 UI 删除提交被删）——知识资产缺口 | kernel-eval §5 |
| C5 | **durable queue/崩溃恢复未对齐 codex**——用户消息持久队列+rollout 重放是最高价值机制差距 | codex `thread-store/queue_store.rs:14`、`rollout_reconstruction.rs` |
| C6 | **无任务级评测 harness**——只有微基准；「可靠性第一梯队」缺可复现证据 | `scripts/bench/run-bench.mjs` only；aider SWE-bench/Exercism、gemini evals 37 |
| C7 | kimi `/btw` 旁路问答、Notification hook 事件无等价 | kimi `soul/btw.py:1-13`、hooks Notification |
| C8 | autoReview 默认关（codex Guardian 参考）；循环检测单模型判定（gemini 双模型置信度 0.9 参考） | `permissions.ts` autoReview 默认关 |
| C9 | **测试 flaky 未根治**——本日三轮全量各有一处不同用例抖动（时序/真实模型调用/环境 PATH），HC-4 计划未执行 | 本日 3 次 `npm test` 实测 |

### D. 文档与工程卫生

| # | 缺口 | 证据 |
|---|---|---|
| D1 | README 断链 3 份协议文档（wire/serve/acp），ci 无 docs-links 门禁 | 本日验证 `Test-Path` 全 false |
| D2 | AGENTS.md 悬空引用 `docs/audit-deep.md`；目录清单列了已不存在的 `wxdbg.log` | 本日验证 |
| D3 | `packages/wxnodus-ink` 仅剩 dist+node_modules 残留（0 源文件） | 本日验证 |
| D4 | 无面向用户的手册：命令总览/错误码字典/退出码表 | docs/ 7 份全为内部文档 |
| D5 | 测试计数口径不一（文档 2539 vs 静态字面 2235+参数化展开） | 本日复核 |

### E. Windows 平台纵深（可选加固）

| # | 缺口 |
|---|---|
| E1 | **Windows ARM64 未验证**（node-screenshots 有 arm64 依赖；better-sqlite3/robotjs arm64 预编译与安装链未取证） |
| E2 | Windows Server 2019/2022、Win10 更老版本边界未验证（现有电池仅 Win10 22H2/Win11 24H2） |
| E3 | 共享盘/SMB 工作区、>260 深路径在工具层全覆盖未取证 |
| E4 | 多显示器高 DPI 深化（证据脚本已有，缺成体系电池） |

---

## 二、做什么（行动波次）

### P0 止血（1–2 天，全部低成本）

1. **修 C1**：`agent.ts:676` 改 `await import()` + 补接线测试——「开关静默失效比不开更危险」。
2. **C2+C4 收口**：修 3-2 后合入批次2；同步持久化「差距对齐台账」新文档。
3. **D1/D2/D3**：补 3 份协议文档或改 README 引用；docs-links 门禁入 ci；清理 wxnodus-ink 残留与 AGENTS.md 悬空引用；统一测试计数口径。
4. **C3**：缓存 key canonical 化（键序排序后序列化，半天）。

### P1 私有化部署核心（1–2 周）

> **用户裁决（2026-08-27）**：A1「零 Node 依赖安装（内置运行时）」**不做**——保留系统 Node ≥22.7 + 多 ABI 侧车（当日已落地）；安装摩擦接受，资源投向其余五卡。

5. ~~A1 自带运行时~~（裁决不做：维持系统 Node + 多 ABI 侧车）。
6. **A2 企业代理**：`HTTP(S)_PROXY/NO_PROXY` + 系统代理 + NTLM（走 Windows 系统凭据）→ undici Agent 接线，模型调用与 http_* 工具同面生效 + 测试。
7. **A5 私有端点实测矩阵**：vLLM/Ollama/LM Studio/one-api/DeepSeek 本地化 五类端点 ×（流式/工具调用/思考字段/限流头）实测电池 + 文档。
8. **A3 策略与审计**：权限规则「全局>用户>项目」三层合并语义；审计哈希链导出格式（JSONL/md）+ `/audit export`。
9. **A4 发布试点**：winget/scoop 实际发布一次（manifest 生成已具备）。
10. **C9 flaky 根治第一轮**（HC-4 方案：轮询 deadline 化 + 时序解耦，连跑 5 轮零 flaky 为过）。

### P2 体验与证据（2–4 周）

11. **B1 TUI 决策执行**（推荐重建）：薄投影层 TUI——wire 事件流→ANSI/终端的纯函数渲染，复用 OutputEvent 规范与投影残部，绝不引入 ink；一期范围：对话流+工具行+审批流+slash 命令。
12. **B2 IDE 伴生加厚**：VS Code 插件补 诊断/diff 视图/审批卡片（wire 协议已具备，纯成品化）。
13. **C6 任务级评测 harness**：Exercism polyglot 思路 + 确定性结局断言，产出首份《任务通过率基线》——私有化 CLI 的质量硬证据。
14. **C5 durable queue 对齐 codex**：events.jsonl 已有基础，补用户消息持久队列 + 中断恢复重放。
15. **C7**：`/btw` 旁路问答 + Notification hook 事件（低改动高收益）。
16. **A6+D4**：`/help` 全量导出生成离线用户手册（命令总览/错误码字典/退出码表），随 zip 分发。
17. **E1/E2 验证**：ARM64 + Server 2019/2022 装包冒烟电池。

### P3 backlog（观察项，不承诺）

18. A3 深化：GPO/域策略下发（**已裁决不做**）；审计集中收集（`/audit export --out` 已支持指向共享，维持现状）。
19. B3 内网 web 面板（--serve 之上的官方薄面板，可选）。
20. C8：autoReview 默认值已裁决（维持默认关，fail-closed 优先，2026-08-27）；循环检测双模型确认评估。
21. E3/E4：共享盘/深路径/高 DPI 电池补齐。

---

## 三、决策点（需要用户拍板）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | **B1 TUI 是否重建** | ✅ 已裁决执行（2026-08-27，目标书明列+未否决）：**薄层 TUI 已重建**——wire 事件→ANSI 纯函数渲染（零 React/Ink 依赖），审批/澄清/密码复用 wire 网关契约；`src/presentation/tui/{ansiRenderer,interactiveLoop}.ts` + 裸 TTY 入口接线 + 8 单测 + conpty 真机冒烟通过 |
| Q3 | **GPO/域策略下发** | ❌ 已裁决不做（2026-08-27）：企业治理维持「本地三层策略（已落地 P1-4）+ 审计导出」；GPO 分发属 Windows 平台能力、非 CLI 职责，wxnodus 保证读+尊重全局层（%ProgramData%）即可 |
| B4 | **双机真机电池** | ❌ 已裁决不做（2026-08-27）：不在本机外维护第二台真机验证环境；真机证据以本机三件套为准（发布链装包冒烟 + 真实模型端到端 + 评测基线），差异面以文档矩阵如实标注「未真机验证」 |

## 〇½、P2 执行进度（2026-08-27 实时）

| 卡片 | 内容 | 状态 |
|---|---|---|
| P2-11 | 薄层 TUI 重建 | ✅ 已落地（见 Q1） |
| P2-14 | durable queue（codex 对齐） | ✅ **已落地**：`kernel/durableQueue.ts` + db-v12 迁移——入队先于模型处理/终态收口 done/崩溃恢复 stale→interrupted + system.notice（每会话一次）/子代理不入队；agent.run 包裹接线；4 单测 |
| P2-13 | 任务级评测 harness | ✅ **已落地**：`scripts/eval/task-eval.mjs` + 3 任务（fibonacci/csv-sum/anagram，零模型依赖评分脚本）——真实端点 env 供给 × N 轮 → artifacts/task-eval.{md,json} 通过率报告；未配置诚实 skip（exit 2）；评分路径实测 PASS。**B3 扩充（2026-08-27）**：任务库 3→10（json-merge/url-query/roman/md-links/days-between/top-words/arith-eval 七领域）+ 每任务 golden 参考解 + `eval:tasks:selftest` 双向评分路径门禁（golden PASS / 无解 FAIL）入 ci |
| P2-15 | `/btw` 旁路问答 + Notification hook | ✅ **已落地**：①/btw 核对——**已有真实实现**（`handlersExt.ts:2111` 只读子代理隔离问答，不打断主对话——原差距评估有误，已更正台账）；②**Notification hook 接线补齐**——hooks.ts 契约早已存在但 agent 从未调用（死接线同类），noticeQueue 注入前触发 `hooks.notification('jobs', text)`，hook 异常绝不阻断注入；2 测试 |
| P2-16 | 离线用户手册 | ✅ **已落地**：`scripts/generate-user-guide.ts`（命令注册表确定性生成 119 命令/13 分类 + 退出码/权限模式/协议入口）+ `npm run docs:user-guide` + zip 安装包随包分发（`package-installer.ts` staged）+ `/help` 指引行 |
| P2-12 | VS Code 插件加厚 | ✅ **已落地（0.2.0）**：失败诊断列表 + git diff 视图（终态后收集，+/- 着色；无 git 诚实降级）；`gitDiff.ts` 零 vscode 依赖；7 测试；vsix 重新打包 |

## 〇¾、生态阶段进度（2026-08-27 实时）

| 卡片 | 内容 | 状态 |
|---|---|---|
| 生态-1 | 二开文档 | ✅ **已落地**：`docs/extension-guide.md`（六类扩展面总览 + 插件/SKILL.md/MCP/hooks/协议的最小可运行示例 + 安全约束 + 只收不出分发 + 消费链测试锚点） |
| 生态-2 | 开源生态消费链路验证与补强 | ✅ **已落地**：补全 **npm 插件包消费链路**（此前 market 声明 plugin 类型但无安装链路）——`market.downloadNpmTarball`（SRI 校验共用面）→ `installPluginFromNpmTarball`（安全解包 → 安装器落位）→ `/market install <npm> --type plugin`；3 新测试（标准包/SRI 标注/坏包 fail-closed/路径穿越拒绝） |
| 生态-3 | 协议面成品化 | ✅ 协议四文档 + wire 示例 + docs-links 门禁（P0 已落地）；本轮新增扩展指南收口 |
| Q2 | **A1 运行时捆绑方式** | ✅ 已裁决（2026-08-27）：**不捆绑运行时**——维持系统 Node ≥22.7 + 多 ABI 侧车（已落地） |
| Q3 | **A3 企业策略深度** | ❌ 已裁决不做（2026-08-27）：GPO/域策略下发不做——本地三层策略已落地（P1-4），全局层 %ProgramData% 供管理员部署即覆盖「域下发」的使用面；审计集中收集维持 `/audit export --out` 指向共享/收集器（已支持） |

## 〇⅘、「其他继续」批次进度（2026-08-28 实时）

> 用户裁决（2026-08-27）：**不做 Q3（GPO）、不做双机真机电池，其余继续**。本批次 = 裁决落账 + B1/B3 收口 + winget/scoop 发布准备 + `/flow` 流图 + 发布链真机验证。

| 卡片 | 内容 | 状态 |
|---|---|---|
| 裁决-1 | Q3 不做 / B4 双机电池不做 / B1 autoReview 维持默认关（fail-closed 优先，无灰度数据不开） | ✅ 已落账（gap-matrix + 本清单决策点） |
| 诚实-1 | exec-server「未真机验证」标注 | ✅ `/remote` 帮助文本 + 命令注册表 + 用户指南（重生成）——双机链路差异如实标注 |
| B3 | 评测任务库 3→10 | ✅ t4 深合并/t5 URL 查询/t6 罗马数字/t7 链接提取/t8 日期间隔/t9 词频 Top-K/t10 表达式求值 + 每任务 golden 参考解 + `eval:tasks:selftest` 双向评分路径门禁（golden PASS / 无解 FAIL）入 ci——10/10 自检绿 |
| P1-5 | winget/scoop 发布准备 | ✅ winget-pkgs **三文件形态**（version/installer/locale——旧单文件新包提交会被拒）+ scoop license 修正 Apache-2.0 + `docs/winget-scoop-publish-guide.md`（步骤 0–4 + 已知未决项诚实标注）+ `packaging/PR-DESCRIPTION.md`；实际提 PR 仍待 GitHub 授权 |
| 新-1 | `/flow` 管线流图可视化 | ✅ `GET /flow`（serve 网关）：纯静态零数据页（零外部资源 + 严格 CSP + no-store，无认证）+ 六阶段流图（真实实现文件锚点）+ 页内凭 token 走同源 fetch 流式 /events 实时点亮（EventSource 不能带 Authorization，不弱化网关认证）；7 测试 + `docs/serve-protocol.md` §3 |
| 链-1 | 发布链真机验证（本机三件套之装包冒烟） | ✅ 全链实测：freeze→package（**4.0.0-rc.1 全量 4545 文件 + 多 ABI 侧车**）→ 解压安装 → 双 shim（wxnodus/wxn）→ 卸载清净（journal 语义）→ serve 网关（/flow 200+CSP、/rpc Bearer、无 token 401） |
| 链-2 | 冒烟发现的三处发布链修复 | ✅ ①安装器 SEMVER 门禁拒绝预发布版 → 放宽 `x.y.z[-prerelease]`（publish-release 同步）；②robocopy 把源树内 staging 目标拷进自身（卸载残留空目录）+ reinstall 旧树嵌套 → `/XD` 显式排除 staging/旧树（回归测试锁定）；③check-pack 断言与 V4 裁撤轨 D-3 脱节 → 按 `WXNODUS_LEGACY_OFFLINE=1` 逃生开关语义修正 |

## 附录：P1 私有化核心细案（2026-08-27 补）

> 每条含：目标 / 现状锚点 / 实施方案 / 改动面 / 验收 / 工作量 / 风险。跨项设计决策见文末。

### P1-1 A1 内置运行时——~~零 Node 依赖安装~~（用户裁决 2026-08-27：不做，方案存档）

> **裁决**：不捆绑运行时。运行时策略定型为「系统 Node ≥22.7（engines 已放宽）+ zip 多 ABI 侧车（默认 ABI + 137，当日已落地）+ 无侧车命中时诚实拒绝指引 Node 22/24」。以下方案仅存档备查。

- **目标**：zip 自包含 `runtime/node.exe` → 目标机不需要预装 Node；ABI 恒等于打包 ABI，原生模块永不因用户 Node 版本崩溃（今日多 ABI 侧车降为「npm link 用户专属兜底」）。
- **现状锚点**：shim 用系统 node（`installerPackager.ts:162-164`）；install.ps1 Node gate ≥22.7（`:68-85`）；manifest v3 侧车（本日落地）。
- **方案**：
  1. `scripts/package-installer.ts` 增 `--bundle-node <node.exe>`（气隙供料）与 `--bundle-node-download <v22.x.y>`（nodejs.org/dist/win-x64 zip，sha256 绑定）；staged 树加 `runtime/node.exe` + `runtime/LICENSE-node.txt`（Node 官方 zip 自带许可证，随包分发合规）。
  2. manifest v3 增 `runtime?: { version, nodeSha256, licenseSha256 }`（确定性防篡改）。
  3. install.ps1：zip 含 runtime → shim 写 `%~dp0runtime\node.exe`，**跳过 Node gate 与 ABI 三路裁决**（内置 ABI 恒等）；不含 → 维持现行语义。install.bat 文案改「免装 Node」。
  4. `smoke-installed.mjs`：存在 runtime 时优先用内置 node 冒烟。
  5. doctor 增检查项「运行时来源（内置/系统）+ 版本」。
- **验收**：移除 PATH 中 node 的干净环境，解压双击 install.bat → `wxnodus --version` 成功；zip 体积增量记录（约 +30MB）；sha256 全链校验与防篡改测试保留。
- **工作量**：1–2 天。**风险**：zip 体积（私有化场景可接受）；SEA 单 exe 因原生 .node 无法静态嵌入、收益下降，二期再评估（Q2）。

### P1-2 A2 企业代理——env/系统代理 + 私网直连红线

- **目标**：内网代理环境（含 Basic 认证）模型调用与工具网络可用；**默认私网段直连不经代理**（数据不出机红线的网络面延伸）。
- **现状锚点**：全仓 0 代理处理（本日取证）；模型调用裸 fetch 且**不走 SSRF**（`llmStream.ts:523`、`llmOnce.ts:46`、`vision.ts:103,208`）；http 工具走 `safeFetchText`（`ssrf.ts:96`）；undici ^7 自带 `EnvHttpProxyAgent`。
- **方案**：
  1. 新建 `infrastructure/http/outboundFetch.ts` 统一出口 `createOutboundFetch()`：dispatcher=`EnvHttpProxyAgent`（读 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` 大小写变体）+ **私网段默认追加 no_proxy**（10/8、172.16/12、192.168/16、169.254/16、localhost）。
  2. 接线：llmStream / llmOnce / vision / balance / downloadService（升级链）/ mcp-http 换统一出口；`safeFetchText` 同 dispatcher——**SSRF 判定仍在目标 URL 层，代理不改变判定**（防「经代理绕过 SSRF」）。
  3. Phase 2：无 env 时读 WinINET 注册表系统代理（`ProxyEnable/ProxyServer`，HKLM/HKCU）；`wxnodus doctor` 显示代理来源与状态。
  4. Phase 3（评估，不引重型依赖）：PAC 需 JS 解释器、NTLM 需凭据中继——先文档化「PAC/NTLM 环境请用 cntlm 等本地中继转 Basic/无认证」。
- **测试**：本地 mock 代理——env 生效 / NO_PROXY 直连 / 私网段默认直连 / 代理下 SSRF 判定不被绕过 / doctor 展示。
- **工作量**：Phase1 1 天；Phase2 1 天。

### P1-3 A5 私有端点实测矩阵——内网模型开箱即用

- **目标**：vLLM / Ollama / LM Studio / one-api / DeepSeek 私有化（SGLang/vLLM 兼容）五类端点开箱即用、矩阵文档化。
- **现状锚点**：`/model add` 任意 OpenAI 兼容（README）；DeepSeek Harness 横切适配（reasoning 字段回传/窗口钳制/图片守卫）；toolTrim 能力裁剪；**模型调用不经 SSRF → 内网 http:// 端点天然可用**（本日取证）——无需改安全面，只需实测+文档。
- **方案**：
  1. `scripts/evidence-private-endpoints.mjs` 实测电池（✅ 已建，2026-08-27）：本地 mock OpenAI 兼容服务器模拟五类差异（标准流式 / 无 reasoning / 有 `reasoning_content` / 不支持工具调用 / 非标 SSE 尾帧）+ 可选真实端点（Ollama 11434、LM Studio、one-api 等）。
  2. 矩阵断言每轴：连接 / 流式解析 / 工具调用 / 思考字段 / max_tokens 钳制 / 429 与断流重试——PASS / 降级 / 拒绝。
  3. 产出 `docs/private-endpoints.md`：每端点×每轴 ✓/✗/注意 + 无 key 端点示例 + 内网 http:// 说明 + 与 A2 的 NO_PROXY 交互说明。
- **验收**：mock 矩阵全绿 + 至少 2 个真实端点实测记录。
- **工作量**：1–2 天。

### P1-4 A3 三层策略 + 审计导出——企业可治理

- **目标**：全局策略可下发（管理员部署）、审计可导出可验证。
- **现状锚点**：用户级 `permissions.json`（deny>allow>ask）；硬红线 `policy/`（SENSITIVE_WRITE）；审计哈希链本地（`audit.ts`）；config 原子写（`store/config.ts`）。
- **方案**：
  1. 策略三层：全局 `%ProgramData%\wxnodus\policy.json`（管理员部署、只读）> 用户（现有）> 项目（工作区 `.wxnodus/policy.json`）。合并语义：**全局 deny 不可被下层放宽**；同 key 具体层优先；接入 modeVerdict 规则源。
  2. `/audit export --format jsonl|md --since <ISO> --out <路径>`（可指向网络共享/日志收集器）；`/audit verify` 哈希链完整性校验。
  3. 全局文件缺失/被篡改 → 拒载 + doctor 报告（fail-closed）。
- **测试**：三层合并单测（放宽被拒/具体优先）；导出+verify 往返；篡改拒载。
- **工作量**：2–3 天。

### P1-5 A4 winget/scoop 试点发布

- **现状锚点（2026-08-27 更新）**：`scripts/generate-package-manifests.mjs` 已升级为 **winget-pkgs 三文件形态**（version/installer/locale——旧单文件形态新包提交会被拒）+ scoop license 修正 Apache-2.0；`docs/winget-scoop-publish-guide.md`（步骤 0–4 全流程 + 已知未决项诚实标注）+ `packaging/PR-DESCRIPTION.md`（双仓库 PR 模板）。
- **方案**：①`publish-release.mjs` 建 Release（真实资产 URL）→ ②`gen:manifests --url --zip` 占位符消除门禁 → ③winget-pkgs 三文件 PR + scoop bucket PR（**需用户 GitHub 账号授权——外部动作**）→ ④发布后 `wxnodus update` 渠道联动冒烟 → ⑤卸载/回滚演练（journal 只删自有文件）。
- **决策**：无账号授权则交付渲染产物 + 本指南供企业内部分发/自建 bucket（winget REST 源 / 私有 scoop bucket）。

### P1-6 C9 flaky 根治第一轮

- **现状锚点**：本日三轮全量实测三类抖动——kernel-tools（grep 依赖 PATH）、cli-wire-alias（真实模型调用 90s 超时）、kernel-bash-encoding（800ms 输出节奏时序）。
- **方案**：
  1. grep 解析自愈（产品级修复）：Windows 上自动探测 Git `usr\bin\grep.exe`（注册表+常见路径），不依赖 PATH——用户机器同样受益。
  2. 真实模型调用测试改本地 mock 服务器（复用仓内 mock provider）；确需真机的标注 `[network]` 移出默认全量。
  3. 时序类按 HC-4：固定 sleep 改轮询 deadline；断言改「条件满足或超时」。
- **验收**：连跑 5 轮全量零 flaky（HC-4 原标准）。

### P1 跨项设计决策

1. **代理×私网**：默认私网段直连（10/8、172.16/12、192.168/16、169.254/16、localhost）——企业代理下内网模型端点/内部 API 绝不外发。
2. **运行时×侧车（裁决定稿）**：不捆绑运行时——zip 用户走多 ABI 侧车（默认 ABI + 137，install.ps1 三路裁决）；npm link 用户走 engines `>=22.7.0` 语义；无侧车命中时诚实拒绝并指引 Node 22/24 LTS。
3. **私有端点×SSRF**：模型端点走裸 fetch（用户显式信任，零破坏）；http 工具保持 SSRF——内网 API 调用需显式放行（blockedHosts 白名单面待验证，列为 A5 验证项）。
4. **执行顺序**：P1-2 → P1-3 可并行推进；P1-4 / P1-5 / P1-6 尾随；P1-5 依赖最终安装器形态（已定型，含侧车）。

---

*本文档为路线快照：P0/P1 执行完成后回改状态；与 `docs/eval-vs-competitors-2026-08-27.md`（差距证据）与 `docs/wxnodus-4.0-hardening-plan-2026-08-21.md`（H 波遗留）互补。*
