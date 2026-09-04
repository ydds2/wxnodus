# wxnodus 4.0.2 综合评估报告：内核 / 全代码 / 设计 / 同类 CLI 差异缺陷（2026-09-04 收尾版）

> **取证方法学**：① 四路并行取证子代理（内核域 / 全代码设计 / 竞品对比 / 测试质量纪律），全部只读、锚定 file:line；② 本会话权威门禁实测（3031 用例全绿 · registry 三表 126=126=126 AUDIT_OK · smoke:tui 5/5 · docs 编码/链接 · B1/B3 真机证据 10/10）；③ 竞品克隆目录已从磁盘删除——以 `docs/eval-vs-competitors-2026-08-27.md`（六家克隆 file:line 锚点）为基线 + web 官方来源（URL 见 §5 表）。
> **状态修正说明**：早盘版 `docs/kernel-codebase-eval-2026-09-04.md` 的 D1–D5 缺陷已在本会话 A 批次修复、B1/B3 已落地——本报告为收尾版，状态以本表为准。

---

## 1. 总评

**wxnodus 4.0.2 是一个「工程纪律远超体量」的单人级 Windows AI agent CLI**：可靠性（原子构建、fail-closed 组合根、进程树治理）、安全（单一事实源红线、SSRF 双层、AES-256-GCM）、测试纪律（3031 用例三层契约、八类门禁）三项已进入品类第一梯队；且在七个维度拥有竞品空白形态（诚实降级文化、检索式长期记忆、常驻屏幕视频流、组件注册探活、Mod 整合包、版本双渠道、本机实例身份）。

主要短板集中在**结构债而非功能债**：分层边界穿透与双向环（有自知、门禁在追）、三套未接入的 ink fork（约 9 万行死重）、巨文件、双组合根死代码、文案/魔数漂移——**「做对的事」已做得很好，「把事做薄做净」是下一阶段主题**。

| 评分面 | 分 | 一句话理由 |
|---|---|---|
| 内核（9 域） | **A-** | 代理/安全/进程/审计 A 级；记忆缺时间衰减、版本解析三套重复拉分 |
| 全代码/设计 | **B+** | 分层意图清晰、组合根严谨；DDD 方向不成立 + 死重 + 巨类 |
| 质量与测试 | **A-** | 三层契约真实成立、门禁密集；4 个高优门禁缺口（真机层 CI 盲区为主） |
| 竞品站位 | **独有形态 7 项 · 生态广度落后** | 功能深度一骑绝尘；插件/桌面/分发是现实差距 |

---

## 2. 内核评估（src/kernel · 123 文件 / 19634 行）

### 2.1 分域评分（证据锚点均为本会话或子代理 file:line 实测）

| 内核域 | 评分 | 核心机制（优点） | 主要缺陷 |
|---|---|---|---|
| ① 代理与回合工程 | **A** | 轮次可配 + 签名级循环检测（agent.ts:1724-1734）+ LLM 双模型确认（loopJudge:1745-1756）+ 预算硬停显式闭环（1284-1303）+ 纯文本模型 image_url 三层能力门（providers.ts:168-172, 291-299） | agent.ts 1759 行单闭包——executeTool/loop/压缩/子代理/审批链耦合一处 |
| ② 记忆黑洞 | **B** | 三层记忆 + FTS5 中文 bigram + sqlite-vec 混合召回（memory.ts:313-347）+ 压缩保尾防拆 tool 配对 + embedder 10min 失败冷却 | **无时间衰减**（召回分数仅 rank×salience，无 recency 因子——计划 C5 待办）；embedAndStore fire-and-forget 失败不可观测 |
| ③ 工具执行与安全 | **A** | 硬红线由 POLICY_RULE_SOURCES 单一事实源派生（permissions.ts:33-77）；bash 分级含 wrapper 解包/命令替换提取/多段拆分；winSandbox 本机实测证伪受限令牌后改 Low IL（诚实校准）；审批链 KF-010 fail-closed | ApprovalCache 仅 UI 去重非授权，语义边界靠注释非类型 |
| ④ MCP 协议层 | **B+** | stdio+Streamable HTTP 双传输 + id 关联校验 + lazy-respawn 30s 冷却防风暴 + mcpHealth/闲置下线纯函数（本会话 B3 落地） | 常规工具调用无 transcript 留档（仅 recordMcpCall 计数；modern /mcp connect 有内存 transcript——与 audit 全留痕不对称） |
| ⑤ 屏幕/视觉 | **A-** | ffmpeg gdigrab/ddagrab MJPEG 环缓冲 + scene_score 场景分段 + clip sha256 证据；NCC 模板匹配积分图 O(1)+σ≈0 诚实不伪造；vision 四级通道 + 同图去重；clipboardImage PNG IHDR 零依赖 | ddagrab/VLM 真机受环境阻塞（代码+契约就绪，诚实降级）；三处懒加载单例无统一 reset seam |
| ⑥ 更新/分发 | **B+** | 绝不自动安装 + sha256 + 失败回滚 + 装后验证；manifest 双渠道；bundle zip-slip 三重校验 | **版本解析 3 套独立实现**（selfUpdate.isNewerVersion / bundle.bundleVersionOk / semverRange.parseVersion）；semverRange 有契约测试但生产零调用——孤儿模块 |
| ⑦ 进程与并发 | **A-** | taskRunner 有界进程树终止 + orphan 恢复；execServer HMAC token + timingSafeEqual；processScan 单一事实源（本会话 B1 落地）；term 拒绝伪造关闭 | execServer 普通执行 profile=off 无沙盒（默认关=裸权限，靠 token 单点） |
| ⑧ 身份/审计 | **A-** | instanceIdentity 原子落盘 + 竞态回读；audit 哈希链原子 INSERT...SELECT 防分叉 + 在线校验；secrets TTL 过期；密钥机器指纹 provider-mismatch fail-closed | 机器指纹换机/换用户即解密失败，无迁移路径（诚实但只能重配） |
| ⑨ 横切质量 | **B** | kernel 零 UI/CLI 依赖（本会话复核通过）；db/工具执行/进程枚举全走注入 seam | 25+ 模块级可变单例无统一 reset seam（仅 localVision 有 reset）；错误返回形状 {ok,value}/string/null 三态混合 |

### 2.2 内核横切问题清单（按严重度）

| # | 严重度 | 问题 | 处置建议 |
|---|---|---|---|
| K1 | 高 | 记忆召回无时间衰减（recallHybrid 无 recency 因子） | = master plan **C5**（第四批） |
| K2 | 高 | 版本解析 3 套重复 + semverRange 孤儿模块 | 统一为 semverRange（bundle/selfUpdate 切换调用方） |
| K3 | 中 | 25+ 模块级单例无 reset seam（跨测试污染风险） | 每单例补 reset 函数，测试 beforeEach 调用 |
| K4 | 中 | agent.ts 1759 行单闭包 | 回合循环/工具执行/子代理三段拆出（低风险重构） |
| K5 | 低 | MCP 工具调用无 transcript 留档 | 复用 infrastructure/mcp/mcpTranscriptStore 接生产面 |
| K6 | 低 | 错误返回形状不统一 | 新代码统一 {ok,value}；老面渐进收敛 |

---

## 3. 全代码 / 设计评估（kernel 之外 · 约 32 万行含 packages）

### 3.1 分层体量地图

| 层 | 文件 | 行数 | 最大文件 |
|---|---|---|---|
| kernel | 123 | 19634 | agent.ts 1759 |
| application | 82 | 7180 | installerPackager.ts 367 |
| infrastructure | 70 | 5224 | fileEvidenceStore.ts 723 |
| domain | 49 | 2259 | completionGate.ts 320 |
| bootstrap | 16 | 764 | cliComposition.ts 489 |
| commands(+ext) | 30 | 11303 | handlers.ts 1154 / handlersExt.ts 1046 / profileMemoryBuildCommands.ts 1124 |
| cli | 12 | 3043 | index.ts 1354 |
| tui | 20 | 3521 | runtime.ts 1072 |
| protocol/compat/store/release/其他 | 56 | 5136 | — |
| packages（core+sdk） | 4 | 722 | — |
| packages（hermes-*/旧 ink fork） | ≈346 | ≈92000 | **未被 src 生产面引用** |

### 3.2 依赖方向验证（本会话复核）

- ✅ **kernel 零 UI/CLI 依赖**——真实成立（大小写敏感全量检索零命中）。
- ❌ **DDD 端口-适配器方向不成立**：kernel 运行时反向穿透 infrastructure（llmOnce→outboundFetch、tools→safeWorkspaceFs、mcp→processSupervisor）、application（systemPrompt→i18nService、voice→voiceSessionService）、app/commands（plugins→CommandBus/SLASH）；反向依赖存在（domain→kernel type、infrastructure→kernel/application、application→app）；**六处双向环**（kernel↔commands/application/infrastructure/policy、protocol↔application/domain）。
- 🟢 **仓库自知并在修复**：`scripts/check-cycles.mjs` 已挂 CI（package.json:28），store/db.ts「环 13」、outboundTargetPolicy「环 17」等注释记录已修环——方向正确，速度待提。
- 修复方向：kernel 只依赖 port 接口，具体适配器由组合根注入（与现有 db/工具执行 seam 同范式）。

### 3.3 组合根与生命周期

**cliComposition 质量高**：三阶段固定 ORDER（config/repositories/kernel）、fail-closed 只 dispose 已启动资源、kernel 阶段中途失败先 closeAllMcp 防孤儿（471-475）、幂等逆序 shutdown 聚合失败。本会话 B3 的 mcp-idle-teardown 清扫器已纳入统一 shutdown（timer 注册为 resource、在途豁免、先回收进程再同步工具表）。

**缺陷**：`createApplication`（五阶段第二组合根）为**死代码**——无任何入口调用、五个 bootstrap* 阶段文件均为恒等桩、且阶段无 try/catch（抛异常绕过 dispose，与 cliComposition 不一致）；`hermes-gateway`（hermes-tui 桥接）亦无生产调用（仅 knownFailures 台账留名）。二者应删除或明确声明实验面。

### 3.4 命令系统与 TUI

- **单一事实源成立**：registry 三表 126=126=126（本会话审计脚本运行期导入验证）；驱动 TUI 菜单/帮助/手册/compat/MCP。
- **魔数漂移债**：registry.ts:49「126」、tui/commands.ts:6「126」为硬编码文案，handlersExt.ts:1「108」、registry.ts:244「96」为历史注释——命令数变化即漂移。处置：文案改 `SLASH.length` 派生（A5 测试已锁 user-guide 行数，源码文案待同锁）。
- **巨类风险**：handlers.ts 1154 行 / handlersExt.ts 1046 行 / HandlerCtx「万有上下文」（30+ 可选字段）；ext/ 迁移范式一致但部分文件仍巨（profileMemoryBuildCommands 1124 行/26 注册）。/migrate、/eco、/input、/vision 等仍未迁 ext/。
- **TUI**：**实际使用官方 npm ink@6.8.0**（App.tsx 等 7 处 import，本会话复核）——README「@wxnodus/ink 自研 TUI 渲染器」与实现漂移（AGENTS.md 摘要同漂）；三套旧 fork（hermes-ink/hermes-tui/wxnodus-ink ≈9 万行）private 未接入 = 死重。runtime.ts 状态机质量高（bus→store、窄端注入、TUI 不直连 DB/零网络）。
- 可测性：tui-render.test.tsx 40+ 用例用 ink-testing-library + 桩 bus/agent——只测呈现不测真实事件流；真实 PTY 层在 smoke:tui（未进 CI）。

### 3.5 技术债清单（全代码）

| # | 严重度 | 债 | 建议 |
|---|---|---|---|
| A1 | 高 | kernel↔infra/application/commands 双向耦合 + 6 环 | port 化注入，逐个消环（check-cycles 已盯） |
| A2 | 高 | 三套未接入 ink fork ≈9 万行死重 + README「自研 ink」文案漂移 | 删除或归档 fork；README/AGENTS 改「官方 Ink 6 + 自研组件层」 |
| A3 | 高 | handlers 三巨文件 + HandlerCtx 万有上下文 | 按 ext/ 范式继续拆分；ctx 按命令面切片 |
| A4 | 高 | 双组合根（createApplication 死代码） | 删除（历史由 git 保留） |
| A5 | 中 | 命令计数魔数硬编码（126/108/96） | SLASH.length 派生 + 测试锁定 |
| A6 | 中 | 命令面拆 registry + commandLevels 两文件且 registry↔kernel 环 | ALIASES 下沉 kernel 单侧，registry 只 re-export |
| A7 | 中 | sdk/core 版本 4.0.1 vs 主仓 4.0.2 patch 漂移 | 发布脚本统一 bump |
| A8 | 低 | presentation(ANSI) 与 tui(Ink) 两套呈现层并存 | 观察期，不强行合并 |

---

## 4. 测试与质量纪律评估

### 4.1 体量

381 个测试文件 · 静态 2707 it（参数化展开后运行基线 **3031 passed + 11 skipped**）· kernel/agent+permissions+mcp 域 >450 用例、tui ≈153、cli ≈70 为三主峰。

### 4.2 三层契约纪律——真实成立

纯函数契约（diskStatus/parseHeartbeatLine/NCC/semver）→ 命令层注入/vi.mock（runDoctor 注入 processScan/fetchImpl；vi.mock 全仓仅 29 处/13 文件、vi.hoisted 仅 1 处——纪律极佳）→ 真机夹具（真实 stdio MCP server、真实 dist 子进程、假 ffmpeg 流、本会话 B1/B3 真机证据脚本）。**kernel-doctor.test.ts 是三层同文件的理想范式**。

### 4.3 门禁清单

原子构建交换（dist 永不失窗）· typecheck（src+tests）· docs 编码（BOM/strict-UTF8）· docs 链接 · registry 三表审计 · smoke:tui · known-failures 三态注册表——共八类，防回归面设计成熟。

### 4.4 缺陷清单

| # | 严重度 | 缺陷 | 建议 |
|---|---|---|---|
| Q1 | 高 | `ci` 不含 smoke:tui（TUI 真机层无自动防线） | = master plan **B4**（Windows CI + ConPTY） |
| Q2 | 高 | registry 三表审计在 .tmp/、无 script、未挂 ci | 迁 scripts/ + 挂 ci（check:registry-consistency） |
| Q3 | 高 | hasDist/skipIf 真机层静默 skip——「3031」可能不含进程级契约层 | fail-fast 或 CI 断言 skip 计数 |
| Q4 | 中 | typecheck 不覆盖 sdk/core 独立 noEmit | 加 typecheck:sdk/core 入 ci |
| Q5 | 中 | docs-links.test.ts:13 无守卫 describe.skip = 死测试 | 恢复或 skipIf 带守卫 |
| Q6 | 中 | 脆性断言（真实 statfs/工作集/时钟）低配机抖动 | 范围断言/注入夹具 |
| Q7 | 低 | voice/computer/Windows 域 CI 内单层覆盖（真机靠 evidence:*） | 补命令层中间测试 |
| Q8 | 低 | 静态 it 2707 ≠ 运行 3031 无核账 ratchet | check:test-count 下限锁定 |

---

## 5. 同类 CLI 差异与缺陷对比

> 来源标记：`[基1]`=08-27 六家克隆基线 · `[本]`=本会话真机证据 · `[URL]`=web 官方来源（见 §5.4 表）。Claude Code 无克隆，均标「待核」或公开文档。

### 5.1 对比维度表

| 维度 | wxnodus 4.0.2 | codex | gemini-cli | opencode | kimi-cli | crush | aider | Claude Code |
|---|---|---|---|---|---|---|---|---|
| 交互 TUI | ✅ 官方 Ink 6 重建（三页帮助/选择器/审批/回滚）[本] | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ REPL | ✅ [12] |
| **常驻屏幕视频流** | ✅ /watch：实时捕捉→帧环缓冲→场景分段→任务链→mp4 证据 [本] | — | — | — | — | — | — | ⚠️ computer use（非连续流）[11] |
| **组件注册探活** | ✅ /oasis status/health/topo 真实 initialize 探活 [本] | 部分 app-server | — | 部分 | — | — | — | — |
| **Mod 整合包** | ✅ /modpack 兼容矩阵/sha256/原子回滚 [本] | — | — | — | — | — | — | — |
| **版本双渠道** | ✅ /channel snapshot/release + manifest 选版 [本] | — | — | — | — | — | — | — |
| 长期记忆 | ✅ 三层+FTS5 中文+向量（竞品唯一检索式）[本] | 两阶段抽取 [基1] | 文件+人工 inbox | — | — | todos+摘要 | — | ⚠️ 待核 [12] |
| 密钥安全 | ✅ AES-256-GCM 机器指纹 [本] | keyring | keytar | 明文 auth.json [基1] | keyring | env/op | .env | 待核 [12] |
| 诚实降级 | ✅ 品类独有：voice/FFMPEG/VLM/OCR 全部诚实失败实测 [本] | — | — | — | — | — | — | — |
| 实例身份 | ✅ 本机唯一英文代号+品牌行 [本] | — | — | — | — | — | — | — |
| 卡死自愈 | ✅ 心跳默认开启 + /doctor 孤儿/断档体检（本会话 B1）[本] | — | — | — | — | — | — | — |
| 测试纪律 | ✅ 3031 用例 + 八类门禁（七家密度之首）[本] | ~581 文件 [基1] | 大 | 643 | 218 | 212 | 32 | 强（内部）[12] 待核 |
| Windows 深度 | ✅ 三档终端/Low IL 沙箱/OCR/UIA/GBK 中文（七家最深）[基1] | 一等 ConPTY | 较好 | 部分 | git-bash 依赖 | 一等 | 弱 | 待核 |
| 生态插件 | ⚠️ VS Code 插件 2 源文件、无桌面/Web 面 [本] | ✅ 双 SDK+app-server [1][3] | ✅ IDE 伴生包 | ✅ SDK+Electron+Slack+GH Action [4] | ✅ SDK+web/vis | ✅ 50 REST+SSE | ❌ | ✅ 插件/MCP 生态 [12] |
| 脚本可编程 | ✅ 六入口（wire/serve/ACP/A2A/mcp-server/SDK）**且无密钥 -p 已修 exit 3+NO_API_KEY（A1）** [本] | ✅ exec+JSON | ✅ stream-json | ✅ HTTP+OpenAPI | ✅ wire+SDK | ✅ REST+SSE | ✅ --message | ✅ headless/SDK [12] |
| 分发渠道 | ⚠️ GitHub zip/scoop 就绪；npm 待上架 + 默认 feed 未配（A4 待官方发布）[本] | ✅ npm+brew | ✅ npm | ✅ npm+bun | ✅ npm+pip | ✅ npm+brew | ✅ pip | ✅ npm |
| 多模态 | ✅ 截图即问+GLM 识别+本地 VLM 代码就绪（下载环境阻塞）[本] | ✅ | ✅ 原生 | ⚠️ 部分 待核 | ⚠️ 部分 待核 | ❌ 待核 | ❌ | ✅ 原生 [12] |

### 5.2 wxnodus 相对劣势清单（按严重度）

**高**
1. **生态广度最薄**——无官方桌面/Web 面，VS Code 插件仅 2 源文件；opencode 有 SDK+Electron+Slack+GH Action 全家桶 [4]，codex 双 SDK+app-server 驱动 VS Code [1][3]。建议：SDK 转公开 + 插件增厚为 wire 桥真实面板。
2. **任务级评测 harness 缺位**——仅微基准；aider 有 SWE-bench/Exercism [7]。建议：最小版 = Exercism 多语言 + 本地确定性结局断言。

**中**
3. **分发渠道未闭环**——npm 待上架、更新 feed 默认未配（A4 阻塞于官方 Release 发布）[本]；竞品主流包管理器全通。
4. **MCP 无持久 transcript 面**——工具调用参数/结果不留档，与 audit 全留痕不对称（§2.2 K5）。

**低**
5. **循环检测单模型**——gemini 双模型交叉确认思路可参考（loopJudge 已是单模型判定）[基1]。
6. **工具缓存键未 canonical 化**——kimi `_canonical_tool_arguments` 键序排序思路可参考 [基1]。
7. **机制对齐台账丢失**——gaps.test.ts 随 UI 删除提交被删（08-27 D-7）[基1]。建议：重建差异台账文档。

### 5.3 wxnodus 独有优势清单（竞品无对应形态）

1. **诚实标注/降级文化**——缓存命中/提前执行/截断/FFMPEG_MISSING/OCR/VLM 失败全部显式标注 + 测试锁定「绝不假装」[本]。
2. **检索式长期记忆（黑洞引擎）**——三层 + FTS5 中文 bigram + 向量混合，七家唯一 [本]。
3. **常驻屏幕视频流 /watch**——竞品仅为截图轮询/一次性操作 [本]。
4. **组件注册探活 /oasis**——MCP 任意语言组件真实 initialize 探活 [本]。
5. **Mod 整合包 /modpack + 版本双渠道 /channel**——六家无 [本]。
6. **本机实例身份 + 卡死自愈**（心跳默认化 + /doctor 孤儿/断档体检——8/30 事故教训落地）[本]。
7. **Windows 中文深度**——三档终端 + GBK/IME + UIA + winSandbox 实测校准，七家最深 [基1]。
8. **无账号 BYOK 零破坏**——无 OAuth 门槛，任意 OpenAI 兼容端点 [基1]。

### 5.4 值得「参考不抄袭」引入的机制 TOP10

| # | 机制 | 来源 | 引入方式 | 优先级 |
|---|---|---|---|---|
| 1 | durable user-message queue + rollout 重放 | codex [基1] | 结合 events.jsonl 补用户消息持久队列 | P0 |
| 2 | 任务级评测 harness（SWE-bench/Exercism 思路） | aider [7] | 本地确定性结局断言 | P0 |
| 3 | /btw 旁路问答（保缓存、不入主上下文） | kimi [基1] | 旁路 wire 帧，复用缓存键序 | P1 |
| 4 | Notification hook 事件面 | kimi [5] | 补 hook 事件总线 | P1 |
| 5 | 循环检测双模型交叉确认 | gemini [基1] | loopJudge 升级 | P1 |
| 6 | 工具缓存键 canonical 化 | kimi [基1] | 键序排序后序列化 | P1 |
| 7 | 沙箱多平台（Seatbelt/Landlock/WFP 语义） | codex [基1] | 仅借鉴语义（winSandbox 已原创） | P2 |
| 8 | 动态工作流分解+子代理编排 | Claude Code [9] | 对齐现有 delegate/subagent 范式 | P2 |
| 9 | computer use 常驻控制 | Claude Code [11] | 与 /watch 互补 | P3 |
| 10 | 多客户端共享 workspace | crush [6] | 定位不符，观察不追 | P3 |

**来源 URL 表**：`[1]` [codex rust-v0.138.0](https://github.com/openai/codex/releases/tag/rust-v0.138.0) · `[3]` [Codex Agents SDK 文档](https://developers.openai.com/codex/guides/agents-sdk) · `[4]` [sst/opencode](https://github.com/sst/opencode) · `[5]` [kimi-code hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks) · `[6]` [charmbracelet/crush](https://github.com/charmbracelet/crush) · `[7]` [aider](https://github.com/paul-gauthier/aider) · `[9]` [Claude Code dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) · `[11]` [Claude Code computer use](https://code.claude.com/docs/en/computer-use) · `[12]` [Claude Code docs](https://code.claude.com/docs/en/whats-new)。

---

## 6. 缺陷总台账（四路合并，状态以本会话收尾为准）

| 编号 | 严重度 | 缺陷 | 状态 |
|---|---|---|---|
| K1/C5 | 高 | 记忆召回无时间衰减 | ⏳ 第四批 C5 |
| K2 | 高 | 版本解析 3 套重复 + semverRange 孤儿模块 | ⏳ 待办 |
| A1 | 高 | kernel↔infra/application/commands 双向耦合 + 6 环 | ⏳ 渐进（check-cycles 盯） |
| A2 | 高 | 三套 ink fork ≈9 万行死重 + README「自研 ink」文案漂移 | ⏳ 待办（删/归档 + 文案改官方 Ink 6） |
| A3 | 高 | handlers 巨文件 + HandlerCtx 万有上下文 | ⏳ 渐进 |
| A4 | 高 | 双组合根 createApplication 死代码 + hermes-gateway | ⏳ 待办（删除） |
| Q1/B4 | 高 | smoke:tui 未进 Windows CI | ⏳ 第三批 B4 |
| Q2 | 高 | registry 审计未挂 ci | ⏳ 待办 |
| Q3 | 高 | hasDist 真机层静默 skip | ⏳ 待办 |
| A5 | 中 | 命令计数魔数硬编码（126/108/96） | ⏳ 待办（SLASH.length 派生） |
| Q4 | 中 | sdk/core 无独立 typecheck | ⏳ 待办 |
| Q5 | 中 | docs-links.test.ts 死 describe.skip | ⏳ 待办 |
| Q6 | 中 | 脆性断言（真实 statfs/工作集/时钟） | ⏳ 渐进 |
| K3 | 中 | 单例无统一 reset seam | ⏳ 渐进 |
| K4 | 中 | agent.ts 单闭包 1759 行 | ⏳ 低风险重构候选 |
| A6 | 中 | 命令面拆两文件 + registry↔kernel 环 | ⏳ 渐进 |
| A7 | 中 | sdk/core 版本 patch 漂移 | ⏳ 发布脚本统一 |
| K5 | 低 | MCP 无持久 transcript | ⏳ 待办 |
| K6 | 低 | 错误返回形状三态混合 | ⏳ 渐进 |
| Q7 | 低 | voice/computer/Windows CI 单层覆盖 | ⏳ 渐进 |
| Q8 | 低 | 测试计数无 ratchet 核账 | ⏳ 待办 |
| D6/A4 | 低 | 更新 feed 默认未配 | ⏳ 待官方 Release 发布 |
| B2 | 高 | bash 进程树回收（8/30 事故第二刀） | ⏳ 第三批（已定） |
| — | — | D1–D5（无密钥退出码/文案三件套/offline 行） | ✅ **已修（本会话 A 批次）** |
| — | — | 心跳默认化 + /doctor 孤儿/断档体检（B1）· /mcp 资源列 + 闲置下线（B3） | ✅ **已落地（本会话第二批）** |

---

## 7. 建议路线（与 master plan 对齐的下一阶段）

1. **第三批（已定）**：B2 进程树回收（bash 执行层，回归面最大，单独执行）+ 顺带 B4（smoke:tui 进 CI）+ Q2（registry 审计挂 ci）。
2. **第四批（已定）**：C1–C3 OASIS 收尾 → C5（=K1 记忆时间衰减）→ C4/C6。
3. **本报告新发现项（建议插队）**：A2（ink fork 死重+文案漂移，半天级）→ A4（双组合根删除，小时级）→ K2（semverRange 统一，小时级）→ Q5（死测试修复，半小时级）→ A5（魔数派生+测试锁定，小时级）。
4. **竞品引入**：P0 两项（durable queue + 评测 harness）建议排在第五批头部。

> 历史证据链：`docs/eval-4.0.2-tui-verification-2026-09-02.md` · `docs/kernel-codebase-eval-2026-09-04.md`（早盘版）· `docs/eval-vs-competitors-2026-08-27.md` · `docs/improvement-master-plan-2026-09-04.md` · `scripts/evidence-b1-b3-governance.mjs`（B1/B3 真机证据）。
