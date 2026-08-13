# Kimi 通用蓝图 ↔ WxNodus 对照与漂移清单

> 蓝本来源：`C:\Users\20164\Desktop\Kimi_Agent_Skill通用蓝图 (1)\nodus-compat.agent.final.md`（v1.0，2026-07-23，852 行，已全文研读）。
> 目标要求中的「参考蓝图 + 移除 zero-download/zero-dependency 限制」在本清单中逐项对照；
> 状态三档：✅ 已落地（有文件/测试证据）｜🟡 部分落地/有意识漂移（说明差异）｜⬜ 未落地（蓝图方向，明确不纳入当前范围或列入后续）。
> 原则：蓝图绑定「织系 Nodus 平台」的站点适配细节；WxNodus 吸收其**可验证方法论骨架**（状态机/门禁/锻造即验证/授权链/统一注册表/分层执行），能力面换成 WxNodus 自身的 computer use/browser/MCP/Skill。

## 0. 目标级要求对照（先答最严格的五条）

| # | 目标要求 | 状态 | 证据 |
|---|---|---|---|
| G1 | 首次安装后必须选择系统语言（中文/English） | ✅ | `src/application/bootstrap/preBootstrapOnboarding.ts`（decidePreBootstrap/promptLanguageOnStdio/persistPreBootstrapLocale）+ `src/cli/index.ts:57-75` 接线（任何副作用前执行）+ 本次修复 continue 分支丢失 locale 字段的真实 bug + `tests/cli-first-run-language.test.ts`（7 用例：首次提示持久化/二次不提示/--lang 与 env 优先/非法 locale exit 2/非 TTY 回退/stdio [1][2] 映射/双语欢迎）|
| G2 | 参考 Kimi 蓝图 | ✅ | 本清单即对照产物；蓝图八章全部研读（见下文逐章映射） |
| G3 | 移除 zero-download/zero-dependency 限制 | ✅ | 全仓零自制轮子：better-sqlite3+sqlite-vec、playwright-core、robotjs、node-pty、whisper.cpp、ffmpeg、@modelcontextprotocol、undici、yaml、react19 等成熟依赖直接使用；离线仍可选（规则脑兜底），但不再以零依赖为约束（见 §9） |
| G4 | 每个 wxnodus 成为独立艺术品 + 每用户个性化 | 🟡 | 个性化已落地（W2-02 PersonalizationService/`personalization.get/update` RPC、config 用户态、皮肤/主题、模型目录）；「独立艺术品」= 独立可发行 CLI + 每用户 config.json 独立工作区（`resolveDataDir`）——包装/分发级「艺术品化」（图标/命名/打包器）列为后续清单 §10-4 |
| G5 | 提高 AI 生产质量与自主能力的方法 | ✅ | `docs/ai-production-quality-and-autonomy-proposal.md`（七条可验证纪律 + 四条有界自主机制，全部标注落地证据） |

## 1. 蓝图第 1 章：现状解剖（八条结构性局限 L1–L8）

| 蓝图局限 | WxNodus 对照 | 状态 | 证据 |
|---|---|---|---|
| L1 适配器全部手写、静态注册 | 工具目录 `toolCatalog`（校验/危险分级）+ 组件化构建（工具签名→MCP Server） | 🟡 | `src/domain/tools/toolCatalog.ts`、`src/build/*`；「任意站点适配器自动锻造」未做（见 §5 VisionCapture 漂移说明） |
| L2 桥接停留在文案级单向 | W2-06 双向 MCP 协议（stdio JSON-RPC，client+server 双向）、W3-09 PTY、browser/UIA 全窗口控制 | ✅ | `tests/w2-mcp-duplex.contract.test.ts`、`src/infrastructure/computer/*`、`src/domain/pty/pty.ts` |
| L3 无操作录制/轨迹学习 | 未做轨迹录制（蓝图 M1/M2 专属能力，见 §5） | ⬜ | 明确列入 §10-1 |
| L4 视觉代理只用于逐步决策 | GLM-4V 屏幕理解 + computer use 观察-决策闭环；仍未用于「能力归纳」 | 🟡 | `src/kernel/computer/*`、W3-05 `computerUseService.ts` |
| L5 协议能力静态化（固定 5 工具/4 技能） | MCP Server **按工具签名生成**（非固定枚举）+ Skill 打包（agentskills 规范） | ✅ | `scripts/` 组件化构建 + `src/application/extensions/skillLifecycleService.ts` |
| L6 监听闭环场景绑定 | background jobs/定时任务按 scope 参数化（不绑定单一站点） | ✅ | `src/kernel/*` jobs 事件 + `tests/ui-background.test.ts` |
| L7 合规基座缺位 | 合规五项红线：授权存证（ConsentLedger）/AI 标注（深度合成）/审计导出/许可证扫描/robots 护栏 | ✅ | `src/kernel/tools.ts` recordConsent、`src/build/evidence.ts` complianceCheck、W1-07 安全控制面 |
| L8 机器门空实现 | no-fabrication 落地为确定性校验：json.schema verifier、spec 校验、`VERIFIER_AUDIT_SOURCE_MISMATCH` 等 | ✅ | W3-01 16 内置 verifier + `src/domain/build/acceptance.ts` |

## 2. 蓝图第 2 章：Endpoint 抽象 / 三内核 / 六公理

| 蓝图项 | WxNodus 对照 | 状态 | 证据 |
|---|---|---|---|
| Endpoint 统一抽象 → Capability Card | `CapabilityRegistry`（W2-03：声明/探测/快照三态）+ 工具签名目录 | ✅ | `src/application/capabilities/capabilityRegistry.ts`、`tests/w2-capability-registry.contract.test.ts` |
| VisionCapture 内核（双通道录制+归纳） | 视觉通道已具备（截图+坐标+UIA 元素级）；**轨迹录制→归纳→Card 未实现** | 🟡 | `src/infrastructure/computer/windowsUiaDriver.ts`、`virtualDesktop.ts`；录制归纳列 §10-1 |
| CompatNegotiator 内核（字段映射+spec 冻结哈希+双 HITL） | 概念编译器 spec（`src/build/spec.ts`）+ 高影响授权 scope hash（canonical sha256 防漂移）+ review 双签名门禁；「双方字段映射协商」未做 | 🟡 | `src/domain/computer/highImpactApproval.ts`、`src/domain/quality/review.ts` |
| ComponentForge 内核（六态机→三类产物） | 概念编译器：需求→模块分解→脚手架→验证→证据链 + skillLifecycle staging→smoke→原子换入 + MCP Server 生成 | ✅ | `src/build/*`、`src/application/extensions/skillLifecycleService.ts`、`tests/w2-skill-lifecycle.contract.test.ts` |
| 公理一 Endpoint 抽象万物 | CapabilityRegistry 三态 + 16 verifier 能力声明 | ✅ | 同上 |
| 公理二 双通道捕获 | 视觉 ✓（截图+DOM/UIA 锚点）、流量 ✓（browser 每请求 route+URL 策略）；**录制/HAR 落盘** ✗ | 🟡 | `src/infrastructure/computer/playwrightBrowserDriver.ts`、`urlPolicy.ts` |
| 公理三 分层执行 API > DOM > 视觉 | UIA 优先，坐标 fallback 仅在 Default 桌面普通应用 UI 且边界重证后允许；SecureDesktop/UAC/锁屏禁止 fallback | ✅（更严格） | `src/infrastructure/computer/windowsUiaDriver.ts`（`UIA_COORDINATE_FALLBACK_FORBIDDEN`） |
| 公理四 锻造即验证 | 概念编译器启动→探活→读回 + 证据链 + 四质量门 + W3-07 严格验收 DAG | ✅ | `src/build/verify.ts`、`src/domain/build/planDag.ts`、`tests/integration/buildRestartReadback.test.ts` |
| 公理五 合规内核化 | 授权存证/5 权限模式/8 硬红线/AES-256-GCM 密钥（明文不落盘）/审计导出 | ✅ | `src/kernel/*`、W1-07、`src/kernel/redact.ts` |
| 公理六 越用越强（exemplar 回流/recipes） | 黑洞引擎三层记忆+自动吸附+FTS5+向量检索；**exemplar 池/配方沉淀** ✗ | 🟡 | `src/kernel/memory.ts`；exemplar 列 §10-3 |
| 三业务线升维映射 | ①私有化捕获→computer use ②中间件→MCP duplex ③全栈制作→概念编译器 | ✅ | 三个子系统均已独立交付（W1-W3） |

## 3. 蓝图第 3 章：VisionCapture 细节

| 蓝图项 | 状态 | 说明 |
|---|---|---|
| 视觉三元组（截图+坐标+DOM 锚点）录制 | 🟡 | 运行时具备（截图/UIA 元素/坐标变换），**录制落库**未做（§10-1） |
| 流量通道 HAR + APICARV 端点反推 | ⬜ | browser driver 做请求级策略/隔离，不做 HAR→OpenAPI 反推 |
| 系统侧三模式（OpenAPI 逆向/CDC/文件监听） | ⬜ | WxNodus 面向桌面 CLI 场景；数据库侧已有 CDC 等价物（WAL/sqlite-vec 全量索引） |
| 归纳管线（分段/抽象/回放校验） | ⬜ | §10-1（蓝图 M2 内容，需要录制地基） |
| 成本控制与视觉回落 | ✅ | 视觉仅在 computer use 显式调用时计费；分层执行已落地 |

## 4. 蓝图第 4 章：CompatNegotiator

| 蓝图项 | 状态 | 说明 |
|---|---|---|
| 输入三元组（双方 Card+意图+约束包） | 🟡 | 意图门（routeInput）+ PDP 策略 + 能力快照存在；「双方 Card 字段映射」未做 |
| spec 五部分 + 冻结哈希 | ✅ | 高影响审批 `requestHash`（canonical sha256 全参数绑定）+ `BUILD_VERIFICATION_SNAPSHOT` 快照防漂移 |
| 字段映射机器门三规则（来源存在/目标存在/转换可判定） | 🟡 | json.schema verifier + `workspace.diff` 等确定性校验存在；字段映射协商本体未做 |
| 缺口消解四策略 | ⬜ | §10-1 |
| 两道 HITL（防锚定先判后看） | 🟡 | human.approval verifier + review attestation 双签名；防锚定 UI 交互未做 |

## 5. 蓝图第 5 章：ComponentForge

| 蓝图项 | 状态 | 说明 |
|---|---|---|
| 六态状态机（DRAFT→GATE_LINT→GENERATE→VERIFY→ADMIT/REJECTED，REPAIR≤2） | ✅ | skillLifecycle（staging→parse→boundary→hash→smoke→原子换入）+ 概念编译器验证链 + W3-07 DAG |
| GATE_LINT spec 锚定（声明必须命中 spec 出处） | ✅ | `EvidenceService` 审计源核对 + CompletionGate 绑定校验（runId/artifact/environment/policy 全绑定） |
| 三类产物：MCP Server（Streamable HTTP+OAuth2.1）/Agent Skill（三级渐进披露）/WebMCP | 🟡 | MCP Server ✅（stdio 零依赖生成，W2-06 双向）；Skill 包 ✅（agentskills 规范）；WebMCP ⬜（蓝图亦定位为押注性可选产物） |
| VERIFY：静态+动态+LLM 核对员+对抗探针+真实回放+状态断言+held-out 变体 | 🟡 | 启动/探活/读回/重启读回 ✅（`buildRestartReadback`）；对抗探针与 held-out 回放 ⬜（§10-2） |
| 供应链三层门禁（securityScan/注入扫描/最小权限声明） | ✅ | 插件沙箱（W2-08）+ 许可证扫描 + 5 权限模式 + 8 硬红线 |
| 统一能力注册表（六处旧定义→只读投影） | ✅ | CommandRegistry（owner 化）+ ToolCatalog + CapabilityRegistry 单一事实源；命令别名注入兼容旧名 |
| 市场/recipes 分发 | 🟡 | Skill 生命周期注册表三态存在；远程市场 ⬜（蓝图 M4 亦为「锦上添花」） |

## 6. 蓝图第 6 章：三类场景

| 场景 | 状态 | 说明 |
|---|---|---|
| 站⇄站（双 CDP 会话桥接） | ⬜ | WxNodus 是本地 CLI agent；browser driver 已具备每请求策略隔离（可作地基），站点桥接不纳入 |
| 系统⇄系统（OpenAPI→MCP/CDC 管道） | 🟡 | MCP client+server 双向已落地（W2-06）；CDC 管道未做 |
| 站⇄系统（监听→AI→写入） | 🟡 | background jobs + agent 闭环具备；视觉回放写入仅在 computer use 会话内 |
| 运行时治理（分层执行/漂移检测/熔断） | ✅ | 分层执行 ✅；漂移检测=evidence 篡改检测 ✅；熔断=EmergencyStopService + 速率/配额（W2-09 预算）✅ |

## 7. 蓝图第 7 章：合规内核化

| 蓝图红线/绿灯 | 状态 | 证据 |
|---|---|---|
| 红线1 屏障规避禁止 | ✅ | 5 权限模式 + 8 硬红线（任何模式不可绕过）+ computer 边界 fail-closed（锁屏/UAC/受保护 UI） |
| 红线2 封禁信号熔断 | 🟡 | 熔断机制具备（EmergencyStop），平台授权状态库未做（§10） |
| 红线3 身份伪装禁止 | ✅ | 固定 UA 常量 + 浏览器沙盒隔离（无扩展旁路） |
| 红线4 超范围采集 | ✅ | 秘密转写 opaque ref（`VOICE_SECRET_TRANSCRIPT_EXPOSED`）+ 密钥 AES-256-GCM 不落盘 |
| 红线5 授权到期失效 | ✅ | 高影响 grant 单次使用（`APPROVAL_GRANT_REPLAYED`）+ lease 到期 CAS orphaned |
| 红线6 双授权缺一锁定 | 🟡 | 用户授权存证 ✅（ConsentLedger）；平台授权证据槽位 ⬜ |
| 绿灯 P0 官方 API 优先 | ✅ | browser 请求策略默认官方通道；视觉 fallback 受护栏约束 |
| 授权链/凭证库/审计 | ✅ | ConsentLedger + AES 凭证 + audit.json 审计链 + 审计导出命令 |

## 8. 蓝图第 8 章：文件级映射与路线图

| 蓝图项 | 状态 | 说明 |
|---|---|---|
| 新增模块（visionCapture/compatNegotiator/componentForge/capabilityRegistry/consentLedger/credentialVault/platformAuthRegistry） | 🟡 | capabilityRegistry ✅ / consentLedger ✅ / 凭证保管 ✅；visionCapture ⬜ compatNegotiator ⬜ componentForge≈概念编译器 ✅ platformAuthRegistry ⬜ |
| 五张新表（capability_cards/compat_specs/forged_components/consent_records/credential_refs） | 🟡 | consent/audit 已有；compat_* 三表随 §10-1 |
| P0 债务：统一注册表 + 认证基座 | ✅ | CommandRegistry/ToolCatalog/CapabilityRegistry 单一事实源；单机身份=配置用户态 |
| P1 债务：远程市场+签名 / 推流 / 向量检索 | 🟡 | 向量检索 ✅（sqlite-vec）；远程市场签名 ⬜（§10-3）；WebRTC 推流 N/A（CLI 无推流场景） |
| M1 录制地基 | ⬜ | §10-1 |
| M2 单端锻造 | 🟡 | 概念编译器≈锻造骨架（非站点适配器）；站点适配器锻造 ⬜ |
| M3 双方协商 | ⬜ | §10-1 |
| M4 生态 | 🟡 | Skill 打包/分发已具备；WebMCP ⬜ |

## 9. 「移除 zero-download/zero-dependency」落实证据

| 依赖 | 用途 | 状态 |
|---|---|---|
| better-sqlite3 + sqlite-vec | 黑洞引擎（FTS5 中文 bigram + 向量） | ✅ 生产使用 |
| playwright-core | 浏览器驱动（每请求路由/URL 策略） | ✅ 生产使用 |
| robotjs + node-screenshots | computer use 桌面控制/截图 | ✅ 生产使用 |
| node-pty | PTY 终端运行时 | ✅ 生产使用 |
| @modelcontextprotocol（server/client） | 双向 MCP 协议 | ✅ 生产使用 |
| @huggingface/transformers | 离线本地 LLM 通道 | ✅ 生产使用 |
| whisper.cpp/ffmpeg（外部可执行） | 语音转写/录音（下载安装外部工具，不再自造） | ✅ 生产使用 |
| undici/yaml/react19/micromark 等 | 网络/配置/UI/Markdown | ✅ 生产使用 |
| 保留的离线能力 | 无 key 可用（规则脑兜底）+ 离线 token 包——离线是**能力**而非**限制** | ✅ |

## 10. 未落地项清单（诚实声明，附优先级）

1. **轨迹录制→能力归纳（蓝图 M1/M2）**：VisionCapture 录制层与 CompatNegotiator 字段映射协商。WxNodus 当前价值面是「本地 CLI agent」，站点适配器锻造是蓝图绑定织系平台的专属命题；若目标明确要求，可作为后续 wave（依赖：CDP 录制探针 + HAR 落盘 + 归纳回放校验）。
2. **对抗探针 + held-out 变体回放**：build 验证已具备重启读回；参数扰动回放集未做（可复用 W3-08 协调器扩展）。
3. **exemplar 池/recipes 配方沉淀 + 远程市场签名分发**：黑洞引擎已具备存储底座；沉淀与分发管线未做。
4. **「独立艺术品」包装层**：每用户 config 个性化已实现；可发行形态（图标/命名/自包含打包器/安装器）未做——列入后续产品化。
5. **平台授权证据槽位（platformAuthRegistry）**：红线 6 的平台侧证据登记未做（单机 CLI 无多租户目标场景，保留为扩展点）。

## 11. 结论

- 蓝图的可验证方法论骨架（锻造状态机、门禁、spec 冻结哈希、授权链、统一注册表、分层执行、行为级验证、合规内核化）**已系统性落地**于 WxNodus 的 quality/computer/voice/build/PTY/extensions 各层，且全部有测试与 gate 证据。
- 蓝图绑定「织系平台」的站点适配专属能力（轨迹录制归纳、字段映射协商、WebMCP、远程市场）**明确未实现**——这是产品面差异而非工程遗漏，均在本清单中标注与给出后续路径。
- 目标 G1-G5 中，G1（语言选择）、G2（蓝图对照=本清单）、G3（解除零依赖限制）、G5（质量/自主提案）已完成；G4（个性化）已落地、「独立艺术品」包装层列为后续。
