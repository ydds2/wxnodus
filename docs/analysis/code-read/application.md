# src/application/ 逐文件精读 digest（81/81 文件，6132 行，2026-08-17）

> 100% 代码覆盖审计。每文件：职责 / 关键导出（起始行号）/ 闭环连接点（bus 事件、kernel import、调用方 file:line）。
> 说明：application 目录内没有 bus.emit/listen；唯一事件面是 createGatewayService 的 subscribe/publish（适配器装配层）。
> kernel/agent.ts 是 agent.* / system.notice / reasoning.delta 事件的唯一源，经 wxGateway.attachBus 转发。

## 根级（11 文件）

### application/applicationServices.ts（15 行）
- 职责：应用服务聚合端口——Presentation 只依赖此层（sessions/prompts/commands/memory/pty 五端口）。
- 导出：interface ApplicationServices（L9）。
- 连接：import commandService/memoryService/promptService/sessionService/ptyService（L2-7）；被 src/bootstrap/bootstrapTypes.ts:2 引用。

### application/commandGrammar.ts（63 行）
- 职责：命令词法/语法——引号、转义、flag、-- 终结符（全入口共享 raw grammar）。
- 导出：parseCommand（L35，内部 tokenize L6）。
- 连接：import protocol/errors+results+commands；被 application/commandService.ts:5 调用；tests/wave1/w1-04-command-contract.test.ts。

### application/commandRegistry.ts（81 行）
- 职责：命令注册表——owner 化注册、精确错误码、dispose 只移除本人登记项。
- 导出：createCommandRegistry（L14）：register L17 / unregisterOwner L30 / swapOwner L38 / list L49 / execute L52；type CommandRegistry L81。
- 连接：import protocol（commands/operationContext/errors/results）；被 commandService.ts:4 消费。

### application/commandService.ts（22 行）
- 职责：CommandService 端口 + 基于 grammar/registry 的 factory。
- 导出：interface CommandService（L7）；createCommandService（L11）。
- 连接：import commandGrammar.parseCommand（L5）+ commandRegistry 类型；被 applicationServices.ts:2 聚合；tests 覆盖。

### application/createGatewayService.ts（49 行）
- 职责：W2-02 GatewayService 分派器——所有 presentation adapter 的唯一委托目标；未知 method → GATEWAY_METHOD_UNKNOWN；handler 异常 fail-closed GATEWAY_METHOD_FAILED。
- 导出：createGatewayService（L11，request L15 / subscribe L32 / publish L39）；type GatewayMethodHandler（L9）。
- 连接：实现 gatewayService.ts 端口；被 src/cli/headlessGateway.ts:8；memoryGatewayMethods.ts:4 复用其 handler 类型；publish 为 application 内唯一事件发布面（订阅者异常不阻断）。

### application/ecosystemStatus.ts（113 行）
- 职责：W8-11 Windows 生态互依状态面板（/eco）——每项系统能力真实探测（缓存），非 Windows 诚实降级。
- 导出：probeEcosystem（L42）、renderEcosystem（L104）、interface EcosystemProbe（L13）。
- 连接：import kernel/voice.js:8（probeSapiTtsAvailable/probeSapiStt）、kernel/computer/ocr.js:9（probeWindowsOcr）；被 src/commands/handlersExt.ts:96（renderEcosystem）。

### application/gatewayService.ts（19 行）
- 职责：统一 Gateway 服务端口（request/subscribe/publish?）。
- 导出：interface GatewayServiceRequest（L5）、GatewayService（L14）。
- 连接：被 4 个 presentation adapter（cliGatewayAdapter.ts:1、httpGatewayAdapter.ts:3、inProcessAdapter.ts:3、tuiInProcessGatewayAdapter.ts:1、wireGatewayAdapter.ts:1）与 headlessGateway.ts:9 消费；createGatewayService.ts 实现之。

### application/memoryService.ts（59 行）
- 职责：P0-05 记忆应用服务权威——append/update/delete/search/list 唯一入口；scope 只由注入的可信 context 构造，input 不可伪造作用域。
- 导出：interface MemoryService（L27）、MemoryScopeContext（L15）、MemorySearchInput（L22）；createMemoryService（L40）。
- 连接：import domain/memory（memoryRepository/memoryScope）；被 cli/index.ts:166+355、tools/toolExecutors.ts:14+96、memory/memoryToolService.ts:5 调用。

### application/promptService.ts（6 行）
- 职责：Prompt 提交应用服务端口。
- 导出：interface PromptService（L4）。
- 连接：被 applicationServices.ts:4 聚合（实现由组合根注入）。

### application/sessionService.ts（6 行）
- 职责：Session 应用服务端口。
- 导出：interface SessionService（L4）。
- 连接：被 applicationServices.ts:5 聚合。

### application/toolExecutionService.ts（17 行）
- 职责：工具执行应用服务——唯一委托 ToolExecutionPipeline，不直连实现/进程。
- 导出：interface ToolExecutionService（L7）；createToolExecutionService（L11）。
- 连接：import domain/tools/toolExecutionPipeline；被 applicationServices 聚合面引用（src 内仅此）。

## autonomy（4 文件）

### application/autonomy/budgetService.ts（18 行）
- 职责：全维预算服务——reserve/commit/release + restart 快照 + evidence。
- 导出：class BudgetService（L8）：open L10 / reserve L11 / commit L14 / release L15 / snapshot L16 / evidence L17。
- 连接：import domain/autonomy/budgetDimensions + infrastructure/sqlite/budgetRepository；src 内无调用者（测试覆盖，自主性编排预留）。

### application/autonomy/progressDetector.ts（34 行）
- 职责：六类无进展检测（状态不变/重复动作/重复错误/无新证据/震荡/预算停滞）——计数器持久化，达阈值稳定停止。
- 导出：class ProgressDetector（L5）：observe L11 / snapshot L33。
- 连接：import domain/autonomy/progressReasons + infrastructure/sqlite/progressStateRepository；progressStateRepository.ts 反向引用其 ProgressState 类型。

### application/autonomy/recoveryService.ts（56 行）
- 职责：W2-10 lineage recovery——lease 未过期拒绝介入；过期先 CAS orphaned，worktree/evidence 校验后只返回三个稳定决策。
- 导出：class RecoveryService（L28）：recover L31；interface RecoveryServicePorts（L13）、RecoveryResult（L23）。
- 连接：import domain/autonomy/autonomyRecords + infrastructure/sqlite/recoveryRepository；src 内无调用者（测试覆盖）。

### application/autonomy/subagentService.ts（109 行）
- 职责：W2-10 子代理启动服务——worktree + 预算逐维 min 收窄 + 作用域只缩不扩。
- 导出：narrowBudgets（L19）、narrowScope（L35）、class SubagentService（L64）：start L67 / stop L92 / isReadOnlyToolId L99；assertOwnedFileScope（L105）。
- 连接：import infrastructure/autonomy（subagentHost/worktreeManager）；被 src/commands/handlersExt.ts:3209 使用。

## bootstrap（1 文件）

### application/bootstrap/preBootstrapOnboarding.ts（147 行）
- 职责：严格 pre-bootstrap 参数解析 + 首次 zh/en 语言选择（help/version 零副作用，locale 只读）。
- 导出：parsePreBootstrapArgs（L30）、decidePreBootstrap（L75）、readLocaleFile（L110）、promptLanguageOnStdio（L119）、persistPreBootstrapLocale（L134）；interface PreBootstrapArgs L8 / PreBootstrapDecision L18。
- 连接：import infrastructure/config/configRepository、domain/config（configSchema/configPrecedence）、i18n/i18nService.translate（L6）；被 cli/index.ts:58、bootstrap/setupWizard.ts:4、cli/args.ts:131。

## build（4 文件）

### application/build/adversarialProbe.ts（69 行）
- 职责：对抗探针——对可执行计划注入 held-out 变体重放，变体意外通过即整体失败 PROBE_VARIANT_UNEXPECTED。
- 导出：class AdversarialProbe（L22）：assess L24 / run L49；interface ProbeCase L8 / ProbeReport L14。
- 连接：import domain/build/planDag.executePlanDag（L6）；src 内无调用者（tests/adversarial-probe.contract.test.ts）。

### application/build/buildService.ts（172 行）
- 职责：Acceptance-driven BuildService——staging 事务 + 严格验收 + 单一 DAG + 原子换入；开放域请求永不伪造完成。
- 导出：class BuildService（L69）：compileAndRun L75 / assertSnapshot L169；interface BuildRequest L19 / BuildServicePorts L43 / BuildDecision L29。
- 连接：import domain/build（acceptance/buildRun/planDag）、quality/completionCoordinator（L11，isGenuine/owns 防伪冒 L103/133/142）；被 commands/handlers.ts:664、commands/buildRouting.ts、build/specAcceptance.ts。

### application/build/buildServiceWiring.ts（293 行）
- 职责：Wave 3 Build 生产端口组装（唯一生产闭环）——staging→内置 verifier→evidence close→reviewer Ed25519 签名→CompletionGate→coordinator；未实现 verifier 一律 crash，快照缺失 fail-closed。
- 导出：createProductionBuildWiring（L145）；interface ProductionBuildWiring L140 / ProductionBuildWiringInput L45。
- 连接：import quality/verifierRegistry（L16）、quality/evidenceService（L17）、quality/completionCoordinator（L18）、domain/quality（completionGate/review/verifier/evidence）、infrastructure/build/workspaceTransaction（L22）；被 commands/handlers.ts:633。

### application/build/buildVerificationCoordinator.ts（40 行）
- 职责：重启读回协调器——证明真实进程替换（第二进程 ID 必须不同）、端口释放、业务读回一致。
- 导出：class BuildVerificationCoordinator（L18）：verifyRestart L20。
- 连接：无 import（纯端口）；仅 tests（buildVerifierFailure/buildRestartReadback）。

## capabilities / compliance（2 文件）

### application/capabilities/capabilityRegistry.ts（125 行）
- 职责：能力注册表——Wave1 兼容类（七项基础能力）+ Wave2 扩展类（fenced surface 不跑 probe，required probe 失败→blocked），同一 CapabilityPort。
- 导出：class Wave1CapabilityRegistry（L28）：snapshot L58 / require L59；class Wave2CapabilityRegistry（L81）：create L83。
- 连接：import infrastructure/capabilities/probeRegistry（类型）；被 cli/index.ts:207（makeMcpIncoming 的 CapabilityPort）。

### application/compliance/platformAuthRegistry.ts（56 行）
- 职责：平台授权槽位最小版（蓝图 §7.2）——到期自动失效/撤销/封禁信号熔断；无平台授权证据即物理锁定（红线 6）。
- 导出：class PlatformAuthRegistry（L14）：register L17 / status L26 / revoke L37 / suspend L43 / isBlocked L49。
- 连接：无外部 import；src 内无调用者（tests/forge-compliance-release.contract.
