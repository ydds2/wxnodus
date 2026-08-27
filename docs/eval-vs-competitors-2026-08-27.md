# wxnodus 4.0 评估与同类 CLI 竞品差异缺陷说明（2026-08-27）

> **取证基线**：wxnodus4.0 仓库 git HEAD `f88e3b10`（+4 个未提交改动）；6 家竞品克隆于 `Desktop\cli-compare\`（codex `9dd3d6a` 2026-08-17 / gemini-cli 0.56.0-nightly 2026-08-17 / opencode `a97fec8` 2026-08-17 / kimi-cli v1.49.0 2026-08-03 / crush `ed15da4` 2026-08-17 / aider 0.86.3.dev 2026-05-22）。
> **方法**：7 路并行源码深潜（1 路 wxnodus 独立复核 + 6 路竞品），全部结论带 `file:line` 锚点；未取证处明写，不猜测当事实。本报告与 `docs/kernel-eval-2026-08-27.md`（内核域）互补，覆盖全产品面。

---

## 1. 总评

**一句话**：wxnodus 4.0 的内核工程（流式/重试/压缩/安全/诚实标注）已达到品类第一梯队，测试与发布链纪律甚至领先全部竞品；但产品形态（无 TUI、无官方 SDK/IDE 深度集成、Windows 单平台）与生态广度是六家中最窄的，且存在「机制完备但接线层短路」的重复性缺陷。

| 维度 | 评分 | 说明 |
|---|---|---|
| 内核可靠性工程 | **A（9/10）** | 14 类错误分类重试、双档 watchdog、三级压缩、确定性结局、事件闭环——与 codex/gemini 同级，部分更细 |
| 安全工程 | **A-（8.5/10）** | AES-256-GCM 密钥+归属校验、bash 分段、SSRF 三层、图片四层守卫、Low IL 沙箱；扣分项＝sandboxFastPath 死接线 |
| 工程纪律 | **A（9/10）** | 335 测试文件/2235+ 用例（静态计数，运行时宣称 2539）、九命令门禁、ratchet、证据链——密度为七家之首 |
| 记忆与上下文 | **A-（8.5/10）** | 唯一检索式长期记忆（FTS5 中文 bigram+向量）；codex 两阶段抽取、gemini 纯文件+人工审批，其余无 |
| 产品形态 | **C（6/10）** | 唯一无 TUI 的 CLI；headless 六入口完整但生态面（SDK/IDE/桌面/Web）为七家最薄 |
| 文档 | **B-（7/10）** | 内部计划/审计文档极佳；面向用户文档断层（README 断链 3 份协议文档、无用户手册） |
| **综合** | **8.0/10** | 「强内核、窄产品、高纪律」——差距不在机制而在接线层与形态补全 |

---

## 2. wxnodus 4.0 现状快照（独立复核数据）

| 项 | 事实 |
|---|---|
| 版本/仓库 | 4.0.0-rc.1 · 新仓库 67 提交（2026-08-21 起）· Apache-2.0 |
| 规模 | src 约 4.7 万行（kernel 102 文件 1.77 万行）· 测试 335 文件 · `it(/test(` 字面 2235 处 + it.each 50 处 |
| 入口 | `-p` / `--wire`(`--stream-json`) / `--serve` / stdin 管道 / `--mcp-server` / ACP——六入口全在（`src/cli/index.ts:45-46,428-430,596-623,628-629,707`） |
| 工具 | 49 个内置（`src/kernel/tools.ts`）：fs 3 + bash + 检索 3 + http 3 + memory 4 + browser 7 + computer 12 + LSP 3 + apply_patch + delegate/todo/skill_load/notify/repo_map/cron_create/credential_form/wx_cmd/command_search/scaffold_build/view_image/tool_search；cacheable 纯读标注恰 9 处 |
| 交互 TUI | 已整体移除（`ee63a5b2`），`wxnodus` 无参输出诚实指引后退出 |
| 平台 | Windows 独占（package.json `"os": ["win32"]`），Node ≥22 |
| 记忆 | 黑洞引擎：working/archival/recall 三层 + FTS5 中文 bigram + sqlite-vec 向量 + 异步入箱 + 策展 |
| 安全 | 六档权限模式、bash 分段切分、winSandbox 双态令牌/Low IL（实测校准）、AES-256-GCM 密钥、SSRF IPv6/NAT64、图片四层守卫 |
| 持久化 | SQLite 主库 + events.jsonl 4MB 轮转 + sessionStream + checkpoint×10 + 审计哈希链 + undo-shadows |
| 发布链 | zip 安装包（manifest sha256 闭包+SBOM+ABI）+ 干净机冒烟 + freeze/finalize + `wxnodus update`（气隙 `--file`）+ 产物迁移框架 |

---

## 3. 七家全量对比矩阵

> ✅ 已取证锚点；— 未发现；❓ 未取证。工具数均为内置（不含 MCP/插件注入）。

| 维度 | wxnodus | codex | gemini-cli | opencode | kimi-cli | crush | aider |
|---|---|---|---|---|---|---|---|
| 技术栈 | Node22+TS | Rust(~130 crate) | Node+TS | Bun+TS | Python | Go | Python |
| 交互 TUI | **无** | ✅ ratatui | ✅ Ink | ✅ @opentui | ✅ kosong | ✅ bubbletea | ✅ REPL |
| headless | 6 入口 | exec+`--json` | `-p`+pipe+stream-json | run+pipe+serve | `-p`+wire+stream-json | `crush run`+serve | `--message/--apply` |
| 内置工具数 | **49** | ~20 | ~26 | ~15 | 16 | ~29 | 0（edit 格式） |
| apply_patch | ✅ 三级容错 | ✅ lark 语法 | ❌ 用 replace | ✅ 按模型切 patch/edit | ❌ StrReplaceFile | ✅ edit/write | ✅ SEARCH/REPLACE 四级（第4级死代码 `editblock_coder.py:184`） |
| 循环检测 | 签名+短哈希+LLM 辅助 | 四层兜底（预算闸门/Guardian 窗口/压缩回退护栏/new_context_window 断环——无专门模块） | 哈希周期+双模型确认(置信度0.9) | doom_loop 3 连 | streak≥12 强停 | SHA-256 窗口 | — |
| 压缩 | 三级（micro→全量→413强压） | 回合前+回合中+远程 v2 | 阈值50%+snapshot 二次校验 | isOverflow 保尾40k | LLM 摘要(0.85) | 自动摘要 | 弱模型摘要 |
| 重试/断网 | 14 类分类+等待网络 60s | 5s→60s+WS→HTTPS 回退 | 10 次 5s→30s | 指数退避+Retry-After | tenacity | OnRetry 重置 | — |
| 长期记忆 | **三层+向量检索** | 两阶段抽取 | 文件+人工 inbox（无检索） | — | — | todos+摘要 | — |
| repo map | ✅ ≤400 token | — | ❓ | — | — | ❌ filetracker 替代 | ✅ pagerank |
| 沙箱 | ✅ Low IL 实测校准 | ✅ Seatbelt/Landlock/WFP 四平台 | ✅ docker/bwrap+Win Restricted Token | — | ❓ | — | — |
| 密钥 | **AES-256-GCM 归属校验** | keyring | keytar | auth.json 明文 | keyring | env/op | .env |
| 崩溃恢复 | checkpoint×10+中断回放 | **rollout 重放+durable queue** | state_snapshot | onInterrupt 落盘 | checkpoint | WithoutCancel 落盘 | git 兜底 |
| MCP | ✅ 客户端+lazy-respawn | ✅ 双向（client+server） | ✅ | ✅ +OAuth | ✅ | ✅ +OAuth | ❌ |
| hooks/skills | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅（含 Notification 事件） | ✅/✅ | ❌/❌ |
| LSP | ✅ 3 工具+lspClient | ❌ | ❓ | ✅ 客户端 | ❌ | ✅ 8 工具 | ❌ |
| ACP/A2A | ✅ ACP+A2A | ❌ | ✅ ACP | ✅ ACP | ✅ ACP | ❌ | ❌ |
| 子代理 | ✅ 只读工具集 | ✅ 深度限制 | ✅ local/remote | ✅ task+权限继承 | ✅ 劳务市场 | ✅ task+agentic_fetch | ❌（architect 双模型链） |
| Windows | 独占+三档终端+UIA | 一等（sandbox-rs/ConPTY） | 较好（原生沙箱） | 部分（FFI；V2 欠 PowerShell 路径） | git-bash 依赖 | 一等（named pipe） | 弱（notepad/MessageBox） |
| 可编程接口 | wire+serve+ACP | app-server+双 SDK+JSONL | stream-json+ACP+SDK | HTTP+WS+OpenAPI+SDK | wire+SDK+web UI | 50 REST+SSE | return_coder |
| IDE/桌面 | VS Code 插件（2 文件，薄） | VS Code+双 SDK | IDE 伴生包 | VS Code+Electron+Slack+GH Action | web+vis | — | — |
| 评测 harness | 微基准（无任务级） | core/suite | evals 37+三沙箱 E2E | — | tests_e2e wire 协议 | e2e | **SWE-bench+Exercism** |
| 测试文件数 | **335** | ~581 | 大 | 643 | 218 | 212 | 32 |
| 单二进制 | ❌ Node22 门槛 | ✅ | ❌ | ❌ | ✅ pip | ✅ | ✅ pip |
| 账号依赖 | **无（BYOK）** | ChatGPT OAuth | Google OAuth | 可选网关 | Kimi 账号为主 | Hyper 订阅为主 | 无（litellm） |

---

## 4. wxnodus 领先面（七家中独有或第一梯队）

1. **诚实标注文化（品类独有）**：缓存命中/同批合并/提前执行/蒸馏/截断/空输出全部带显式标注（`agent.ts:1502,1510,1529,1543,1584`）——对照 aider「模型输出直接写盘执行」、opencode 密钥明文落盘，这是 wxnodus 最独特的工程气质。
2. **检索式长期记忆**：黑洞引擎（三层+FTS5 中文 bigram+sqlite-vec 混合检索+跨会话召回+图片摘要）是七家唯一；gemini 是「文件+LLM 抽取+人工 inbox」路线（无检索）、codex 两阶段写读、kimi/crush/aider 基本没有。
3. **DeepSeek 前缀缓存工程**：字节稳定键序+会话冻结时钟+相邻合并三件套（`providers.ts:212-223`）——多数竞品做不到（含 opencode 被点名的失败案例）。
4. **密钥管理最严**：AES-256-GCM 机器指纹派生 + provider 归属校验防密钥错发（`providers.ts:76-113`）；竞品里 opencode 明文 auth.json、kimi/gemini/codex 依赖 OS keyring。
5. **中文 Windows 深度**：三档终端能力（modern/cmd/no-vt）、GBK/IME/QuickEdit 加固、UIA 元素级桌面控制（12 个 computer 工具）、winSandbox 双态令牌经本机实测证伪后改 Low IL 并如实记录（对比 gemini 仍走 Restricted Token）——七家最深。
6. **测试/发布链纪律**：335 测试文件对 4.7 万行 src（约 1 测试文件/140 行）；九命令门禁+ratchet+known-failures 显式登记+Windows 真机验收电池（`tests/acceptance/`、`scripts/run-windows-acceptance.mjs`）+发布证据链——严谨度为七家之首（codex 401 处 TODO、opencode executeStream 未实现、aider 第 4 级降级是死代码，均无此层门禁）。
7. **无账号 BYOK + 任意 OpenAI 兼容端点零破坏**：gemini 无 OpenAI 兼容接入、kimi/codex/crush 以官方账号为主，wxnodus 的「目录外模型不裁不拦」是差异化定位。
8. **工具面最宽**：49 内置（含 computer use 12、LSP 3、browser 7、确定性工具族、cron/jobs/通知）——数量为七家之最（crush 29 居次）。

---

## 5. 差距与缺陷（按严重度分级）

### 5.1 产品形态缺陷（战略级）

- **无交互 TUI——七家中唯一**。`ee63a5b2` 移除后仅剩非交互入口；对照六家全部保有 REPL/TUI。若定位是「CLI 主体对齐同类」（约束二），这是最大的形态缺口；决策本身是用户裁定的，但需接受「交互型用户直接流失到 codex/gemini/crush」的后果。
- **生态面最薄**：无官方 SDK（codex TS+Python 双 SDK、opencode JS SDK+OpenAPI、kimi Python SDK）、无桌面/Web/Slack 面（opencode 全家桶）、VS Code 插件仅 2 个源文件（vs codex app-server JSON-RPC 驱动 VS Code 扩展）。现有 wire/serve/ACP 是「开放面」而非「成品集成」。
- **单二进制缺位**：Node≥22 门槛（kimi/crush/aider 均有单二进制/单包分发）；hardening-plan 已裁决不补（尊重 npm 生态），但客观上是安装摩擦。
- **无官方 OAuth**（有意为之）：接不了 ChatGPT/Gemini/Kimi 官方订阅型用户，仅 BYOK 一条路。
- **Windows 独占**：`"os":["win32"]`——定位清晰但放弃 macOS/Linux 市场（六家竞品全跨平台）。

### 5.2 内核缺陷（已独立复核，与 kernel-eval-2026-08-27 一致）

| # | 缺陷 | 锚点 | 严重度 |
|---|---|---|---|
| D-1 | **sandboxFastPath 接线用 `require()`，NodeNext ESM 下抛错被 try/catch 吞——双速权限灰度功能静默永不生效** | `src/kernel/agent.ts:676`（`require('./winSandbox.js')`）+ `tsconfig.json:4` | 中高（用户以为沙盒内免审批已开） |
| D-2 | 批次2（流式中途派发）未提交，且缓存入库前未剥离「已提前执行」标注——标注会随缓存跨回合传播 | `agent.ts:1510-1518` | 低（合入前必修） |
| D-3 | tool_search 提前派发的「纯读无副作用」宣称不精确（有激活残留+审计噪音） | `agent.ts:198-208` | 低 |
| D-4 | 工具缓存 key 未 canonical 化（裸 `JSON.stringify(c.args)`），键序敏感致同参 miss——kimi 已做 `_canonical_tool_arguments`（`toolset.py:184-202`） | `agent.ts:1492,1581` | 低 |
| D-5 | unknownRounds 被同批任一有效工具清零——「连续 N 轮未知工具终止」退化为「整批全未知才计数」 | `agent.ts:1479,1491` | 低 |
| D-6 | clampN 对浮点阈值（compactionThreshold=0.75）行为未复核；steerQueue 无上限；sessionClocks/sessionFlags Map 只增不减（长驻多会话微泄漏） | `agent.ts:1297,723,232` | 观察级 |
| D-7 | **kimi 差距对齐台账丢失**（原 gaps.test.ts 随 UI 删除提交被删，7 项清单无法复盘） | — | 过程债 |

### 5.3 机制差距（对位竞品，部分为有意不追平）

| 竞品机制 | wxnodus 现状 | 建议 |
|---|---|---|
| kimi **D-Mail 时间旅行**（工具消息回滚至历史 checkpoint，`denwarenji.py:6-29`） | 无等价（只有 /rewind 手动回滚） | 观察；与 checkpoint 机制同源，成本低 |
| kimi **/btw 旁路问答**（保缓存、不入主上下文，`soul/btw.py:1-13`） | 无 | 可选对齐 |
| kimi **Notification hook 事件** | 只有 jobs 回流 notice，无 hook 面 | 补 hook 事件（kernel-eval 已点名） |
| codex **durable user-message queue + rollout 重放 + 崩溃恢复**（`ext/queue/service.rs`） | checkpoint×10+中断回放，但无「用户消息持久队列」 | 最高价值差距之一；结合 events.jsonl 可低成本对齐 |
| codex **Guardian 自动审查** | autoReview 有但默认关 | 评估默认策略 |
| gemini **循环检测双模型确认**（置信度 0.9） | 单模型 LLM 辅助判定 | 可选加固 |
| gemini **PolicyEngine TOML 分层策略** | 六档模式+规则文件（语义同族） | 持平，不需动 |
| crush **多客户端共享 workspace + herdr 集成** | 无 | 定位不符（单机单用户），不追 |
| aider **逐编辑 undo/auto-commit** | checkpoint+undoShadows 轻量替代（用户已裁决不追平） | 维持裁决 |
| 任务级评测 harness | 只有微基准 `scripts/bench/run-bench.mjs`；aider 有 SWE-bench/Exercism、gemini 有 evals 37、codex 有 core/suite | **建议补**：这是「可靠性工程第一梯队」宣称的硬证据缺口 |

### 5.4 文档/仓库卫生缺陷（本轮新发现）

1. **README 断链 3 份协议文档**：`docs/wire-protocol.md`、`docs/serve-protocol.md`、`docs/acp-zed-jetbrains.md` 均不存在（wire/serve/ACP 入口在代码里完好，文档没了）——且 ci 门禁无 docs-links 检查（hardening-plan H3 自己提过但未落地）。
2. **AGENTS.md 悬空引用**：`docs/audit-deep.md` 不存在（AGENTS.md 为 `/init` 生成物，其中用户注记段引用）；`wxdbg.log` 列在目录清单但仓库已无此文件。
3. **packages/wxnodus-ink 仅剩 dist+node_modules 残留**（0 源文件），仍留在工作区混淆视听。
4. **面向用户文档断层**：docs/ 7 份全是内部计划/审计（1795 行），无用户手册/命令总览/错误码字典（H2 的 user-guide.md 计划未落地）；对照 kimi docs 64 篇、crush README 978 行、gemini 文档站。
5. 测试宣称口径：文档「2539 测试」为运行时展开计数，静态字面 2235——建议统一口径表述。

---

## 6. 建议动作（按优先级）

1. **修 D-1**（半天）：`agent.ts:676` 改 `await import()` + 补接线测试——「开关静默失效比不开更危险」。
2. **批次2 收口**（1 小时）：修 D-2（缓存入库前剥离标注）后合入；同步持久化「kimi 差距对齐台账」新文档（修复 D-7）。
3. **文档断链修复 + docs-links 门禁**（半天）：补 3 份协议文档或改 README 引用；把 docs-links 检查加回 ci；清理 wxnodus-ink 残留与 AGENTS.md 悬空引用。
4. **D-4 canonical 化**（半天）：对齐 kimi `_canonical_tool_arguments`（键序排序后序列化作缓存 key）。
5. **任务级评测 harness**（1-2 天）：最小可用版 = 拾取 aider 的 Exercism polyglot 思路 + 本地模型无关的「确定性结局」断言；补足「可靠性第一梯队」的硬证据。
6. **对齐评估**：codex durable queue（结合 events.jsonl 现状）、kimi /btw 旁路问答与 Notification hook——三者均为低改动高收益。
7. **产品形态决策留痕**：无 TUI 是当前最大产品差异——建议在 docs 中显式记录「以 wire/serve/ACP 生态代偿 TUI」的路标与第三方消费案例（VS Code 插件增厚或与现有 IDE 集成共存），避免每次评估都重复讨论。
8. **工程债批**：steerQueue 上限、Map 淘汰、clampN 浮点复核、autoReview 默认值裁决——随维护批消化。

---

## 7. 结论

wxnodus 4.0 的真实画像：**内核已具备与 codex/gemini 同台竞技的可靠性工程，且拥有七家独有的诚实标注文化与检索式记忆；但产品形态收窄到「headless 工具 + 开放协议面」，生态与用户文档明显滞后于内核水平**。最大的两类风险都不是机制问题：一是接线层纪律（D-1 死接线是「精心设计的机制被短路」根因的第二次出现），二是知识资产流失（差距台账被删、协议文档断链）。两者修复成本都极低，先做；随后用任务级评测与 durable queue 对齐，把「第一梯队」从自我评估变成可复现证据。

---

## 8. 修复记录（同日落地：运行时兼容——Node 24 + zip 安装链 ABI 死锁）

> 用户裁定整改方向「运行时兼容：Node 24 + zip 安装链 ABI 死锁」，当日实施完成。

**取证结论**：全仓唯一 V8-ABI 绑定的原生模块是 **better-sqlite3**——robotjs/node-pty（`pty.cc:799 NODE_API_MODULE`）为 NAPI、node-screenshots 为 napi-rs、sqlite-vec 为 SQLite 可加载扩展（`vec0.dll`），三者跨 ABI 稳定。ABI 死锁因此收敛为单点。

**落地变更**：

| # | 变更 | 落点 |
|---|---|---|
| 1 | better-sqlite3 `^11.10.0 → ^12.11.1`（镜像可得的 12.x 最新；上游同时发布 ABI 127/137 预编译） | `package.json:110` |
| 2 | engines 放宽 `>=22.7.0`（废除 `<24` 上限——与安装器「>22 全收」口径对齐，消除自相矛盾） | `package.json:141` |
| 3 | zip 多 ABI 侧车：manifest schemaVersion 3 + `nativeAbis`（abi/path/sha256 绑定）；zip 内 `native-abis/<abi>/<path>` 辅助目录 | `src/application/release/installerPackager.ts` |
| 4 | install.ps1 ABI 三路裁决：本机 ABI==打包 ABI 直接装 → 侧车命中则 sha256 校验后替换 staging 内二进制 → 无侧车诚实拒绝（`INSTALLER_ABI_UNSUPPORTED` + Node 22/24 指引）；native-abis 用完即删不入安装树 | 同上（模板） |
| 5 | 打包脚本 `--node24-binary <file>`（气隙供料）/ `--node24-download`（asset API 两段下载 + tar 解包） | `scripts/package-installer.ts` |
| 6 | install.bat / install.ps1 文案修正（22.7+/22-24 LTS，废除「18+」陈旧口径） | `installerPackager.ts` |
| 7 | 顺带修复：`scripts/package-installer.ts` 合成根 package.json 的字符串字面量内嵌裸换行（HEAD 即坏，脚本无法被解析——发布链潜伏缺陷） | `scripts/package-installer.ts:162` |
| 8 | 测试：侧车入包/确定性/sha256 绑定/非法 ABI 与路径越界 fail-closed；ps1 三路裁决标记断言 | `tests/installer-packager.contract.test.ts` |

**验证**：tsc（src+tests+script）零错误 · lint 绿 · 打包器测试 23/23（含真实 PowerShell 安装与防篡改拒装）· better-sqlite3 12.11.1 + sqlite-vec 0.1.9 加载与 KNN 查询实测通过 · 全量测试套件复核中。

**遗留**：本机网络无法直连 GitHub 资产 CDN（asset API 可通），`--node24-download` 在发布机验证；Node 23（ABI 131）等非 LTS 行无侧车 → 诚实拒绝并指引 22/24——与「不虚增兼容面」口径一致。

---

*评估人：DSH 会话（7 路并行深潜）· 复核日期 2026-08-27 · 本文档与源码同步演进，重大版本变更应回改。*
