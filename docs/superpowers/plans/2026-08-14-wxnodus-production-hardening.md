# WxNodus V3 生产化完善计划

## 总原则

当前状态是“可运行 legacy 产品 + 已形成的 modern contract/service islands”，不是 production-ready：真实组合根仍为 `src/cli/index.ts`，`src/bootstrap/createApplication.ts` 尚未接管 CLI；HTTP、browser、memory、hook、task、scaffold、completion 和 release gate 均存在 legacy 或重复事实源。

必须保持以下边界：

- 保留 W1-09 WeakSet receipt ownership，继续使用 `evidenceStore.owns()` 与 `reviewerVerifier.owns()`；不新增或信任 `trusted` 字段。
- evidence 缺失、未闭合、篡改、取消或环境不可判定只能是 `blocked`、`incomplete` 或 `inconclusive`，不能生成 `succeeded`。
- Gate E 在没有 Win11/Win10 两份真实物理 receipt 前保持 `blocked`，不生成本机模拟 receipt。
- 明文密钥绝不落盘；继续使用 AES-256-GCM，HTTP/Market token 只保存 hash。
- 8 条硬红线、PDP、approval、CSRF、SSRF、路径边界和平台授权全部 fail-closed。
- 先建立兼容 facade、路由快照和可观测断电 gate，再迁移和删除 legacy；不先删除生产路径。
- 最终命令不自动 npm publish、Git tag、GitHub release 或外部发布。

实现阶段创建 `docs/superpowers/plans/2026-08-14-wxnodus-production-hardening.md`；每项按“合同/RED 测试 → 最小实现 → 真实入口接线 → regression/legacy cutoff → evidence”小步提交。本计划本身不修改仓库。

## 目标唯一调用链

```text
CLI/TUI/Wire/HTTP/MCP
  -> authenticated source/session/scope/policy context
  -> GatewayService/application service
  -> security hook -> PDP/approval/budget UoW
  -> effect fence/supervised execution
  -> verifier -> EvidenceService.close/readVerified
  -> reviewer attestation -> CompletionGate.decide (owned receipt)
  -> completionTransport -> CLI/HTTP/Wire/TUI 状态
```

transport 不得从 `ok`、非空文本、`[GOAL_DONE]`、handler 未抛异常或任意 `pass` 推导成功。保留状态映射：`succeeded=0/200`、`failed=1/422`、`blocked=2/409`、`incomplete=3/424`、`inconclusive=4/503`、`cancelled=130/499`。

---

## Wave 0：发布真相、协议和 RED 约束

### W0-01 CompletionGate 唯一事实源

修改/新增：

- `src/application/quality/completionCoordinator.ts`
- `src/domain/quality/completionDecisionReceipt.ts`
- `src/domain/quality/completionGate.ts`
- `src/application/build/buildService.ts`
- `src/kernel/agent.ts`、`src/app/CommandBus.ts`
- `src/build/gate.ts`、`src/build/evidence.ts`
- `src/cli/serve.ts`、`src/cli/index.ts`、`src/presentation/wire/*`
- `scripts/run-completion-gate.mjs`

coordinator 串联 verifier registry、evidence close/readback、reviewer attestation 与 CompletionGate；只有被 WeakSet owner 持有的 `succeeded` receipt 才能让 BuildService commit。模型文本和 `[GOAL_DONE]` 仅触发验证，缺 verifier 为 `incomplete`。脚本改成 TypeScript coordinator 的薄 adapter，重算 rootDigest、required criterion、path boundary，并验证 reviewer/ownership。

新增/扩展：`tests/wave-p0/p0-completion-authority.test.ts`、KF-023/KF-024 正式 regression、closed-evidence/evidence-conflict/failure-propagation 测试。必须证明 tampered/unclosed evidence、required cancelled/inconclusive、伪造 receipt 均不能成功，所有 transport 对同一 receipt 状态一致。

### W0-02 known-failure 与 release eligibility 分离

修改 `src/release/knownFailures.ts`、`src/release/gateDefinitions.ts`、`scripts/run-wave-gates.ts`、`scripts/run-wave3-gates.mjs`；新增 `src/release/releaseEligibility.ts`、`scripts/check-release-eligibility.mjs`、`tests/wave-p0/p0-release-signal.test.ts`。

保留 `test:known-failures` 的 oracle 语义：它的绿色只表示缺陷稳定复现。另建 blocker eligibility：open P0 返回 `RELEASE_BLOCKED_OPEN_P0`、status `blocked`、exit 2；普通回归失败 1；缺证据 3；不可判定 4；取消 130。required 的 failed/blocked/cancelled/inconclusive/incomplete 均不得放行。KF 修复必须原子完成：正式 regression 纳入 discovery/manifest、删除 case、registry 写 `resolved`、绑定 `regressionFile/resolvedBy`。

### W0-03 evidence/requirement 版本化约束

新增 `src/release/evidenceIndexSchema.ts`、`src/release/requirementEvidenceResolver.ts`，扩展 evidence/requirement schemas 和 coverage tests。保留历史 Wave 0 schema，通过版本化扩展。release 模式要求 requirement 为 `verified`，evidence ID 唯一且存在于当前 index，attachment/hash/schema/candidate/platform/profile/scenario/gate 全部匹配；`planned/implemented/skipped/blocked/not_applicable` 不能关闭 release requirement。当前 requirements 不得被伪改成 verified。

**Wave 0 完成定义：** CompletionGate 成为唯一决定者；公开 gate 保留 0/1/2/3/4/130；当前 Gate E 仍诚实 blocked。

---

## Wave 1：P0 安全原语与 legacy bypass

所有子项先写 RED 测试，再最小实现和真实入口接线。

### P0-01 HTTP

将 `src/cli/serve.ts` 降为 facade；新增 `src/presentation/http/httpServer.ts`、`csrfPolicy.ts`，接入已有 `httpSecurity.ts`、`httpGatewayAdapter.ts`、`httpTokenStore.ts`、`httpSessionIsolation.ts`。除最小 `/health/live` 外全部 Bearer 认证；health 不返回 dataDir/cwd/model/统计；SSE 绑定 subject/session；请求 body 有流式上限；OPTIONS 必须验证 Origin、method、headers 和 `Sec-Fetch-Site`，不得无条件 204；无 Origin 的非浏览器客户端仍必须认证。新增 `HTTP_CSRF_BLOCKED`、`HTTP_CORS_PREFLIGHT_DENIED`、`HTTP_REQUEST_BODY_TOO_LARGE`。测试 `tests/wave-p0/p0-http-serve-security.test.ts` 加 kernel/W1-03 回归。

### P0-02 Browser

新增 `src/application/computer/browserSessionService.ts`，把 `src/kernel/tools.ts`、`src/commands/handlersExt.ts` 的 browser 入口接到 `PlaywrightBrowserDriver`。可信 `ToolCtx.sessionId` 不从参数读取；每 session 独立 BrowserContext；popup、redirect、子资源、worker、download 均经同一 URL route policy；`connectedAddress` 缺失必须 fail-closed；close 校验 owner。`src/kernel/browser.ts` 只保留委托 facade，禁止共享 page fallback。新增 production wiring test，KF-012 迁移为绿色 regression。

### P0-03 Installer

新增 `powershellLiteral.ts`、`dependencyClosure.ts`、`installerPathPolicy.ts`；修改 `installerPackager.ts`、`installerManifest.ts`、`zipArchive.ts`、`scripts/package-installer.ts`。appName、entry、path 不直接插入 PowerShell 源码；脚本读取 manifest 或使用严格 literal encoder。统一拒绝 `/`/`\\`、`..`、drive/UNC、保留名、重复和大小写冲突。packager 消费已验证 candidate，不再只收集 `dist/cli`；形成静态/动态 import、production dependency、native addon、assets、bundled Node runtime 的 closure；未解析动态 import 显式声明，否则 `INSTALLER_DEPENDENCY_CLOSURE_INCOMPLETE`；start.cmd 使用包内 runtime。测试覆盖 `$()`、反引号、引号/换行、漏 sibling、删 closure、空 PATH、tamper/rollback。

### P0-04 Scaffold

新增 `src/infrastructure/fs/pathBoundary.ts`，修改 scaffold、tools、`workspaceTransaction.ts`、BuildService。请求只接受 workspace root 和 root-relative target；lexical 与 realpath/symlink/junction containment 双检；写入 staging，CompletionGate 成功后 atomic commit，失败 rollback。复用 `BUILD_PATH_OUTSIDE_WORKSPACE`、`BUILD_STAGING_COMMIT_FAILED`；覆盖 absolute、`..`、cross-drive、symlink、junction；KF-022 原子迁移。

### P0-05 Memory scope

将 `src/application/memoryService.ts` 与 modern SQLite repository 设为 append/search/update/delete 唯一 authority；修改 legacy memory、tools、commands、serve、TUI gateway。scope 从可信 context 构造，repository 最底层约束 FTS/vector/dedup/read/update/delete；global 仅显式 opt-in；legacy 只作为迁移读取源。覆盖 session/project/global、ID update/delete、伪造 HTTP session；迁移 KF-013/KF-014。

### P0-06 Hook fail-closed

新增 `src/application/hooks/securityHookAdapter.ts`；修改 `src/kernel/hooks.ts` 和相关 tests。结构化 HookDecision；security-critical crash/timeout/missing/malformed 全部 deny；notification-only 只有显式 policy 才可继续并写审计；通过 ProcessSupervisor 终止进程树；hook policy 纳入 grant snapshot。复用 `HOOK_EXECUTION_FAILED`、`HOOK_TIMEOUT`、`HOOK_MALFORMED`、`POLICY_CHANGED`，迁移 KF-026；deny 时 approval、budget、effect journal 均不得产生副作用。

### P0-07 Effect fence

新增 `src/domain/effects/effectFence.ts`；修改 `taskRunner.ts`、`processSupervisor.ts` 和 subagent host/service。每 attempt 建 AbortController、generation、lineage、fence；kill 原子撤销 fence、abort、等待 process-tree ack；新 effect/journal/evidence/budget commit 重新验证；无法确认终止返回 `PROCESS_TERMINATION_FAILED` 或 inconclusive，不报告正常 cancelled。新增内部 `EFFECT_FENCE_STALE`，覆盖迟到提交、孙进程、retry generation；迁移 KF-025。

### P0-08 SSRF

新增 `boundedResponseReader.ts`、`outboundTargetPolicy.ts`，改造 `src/kernel/ssrf.ts` 为结构化 `OperationResult`。Content-Length 预拒绝；chunked/压缩后按真实字节逐 chunk 限制并 cancel/abort；header/body-idle/redirect-chain deadline；DNS 失败 fail-closed；每跳 authorize，connected IP 必须属于授权集合；per-host/global connection limit；proxy 不得绕过限制。新增 `OUTBOUND_HTTP_*` 错误码和 streaming test。KF-011 只代表 scheme 防护，不得误算完整修复。

**Wave 1 完成定义：** P0 tests、typecheck、build、主测试通过；上述真实入口不再绕过 modern controls；open blocker 只保留明确环境 blocked。

---

## Wave 2：唯一生产组合根与 Gateway

### W2-01 Factory 与 routing snapshot

新增 `src/bootstrap/createProductionBootstrapOptions.ts` 及实际 config/repositories/kernel/extensions/presentation factories；修改 bootstrap types/phases/createApplication。注册 SQLite、memory/session/evidence/token ownership、MCP、plugin scopes、event hub 和所有 disposer。使 `headless` 真正不 import React/Ink；将核心 GatewayService 与 source-bound GatewayPort 分开。引入不可变 `CompositionRoutingSnapshot`（root：legacy/shadow/modern；capability：legacy/shadow/modern/required），operator 可用 `--composition-root`/`WXNODUS_COMPOSITION_ROOT` 指定，workspace 不得降级 modern/deny。

### W2-02 GatewayService

实现 `src/application/gatewayService.ts` dispatcher，复用 gateway/events protocol、in-process/HTTP/Wire/TUI adapters，统一传播 source/session/correlation/signal；未知 method 稳定失败，不回退 legacy；completion 只接 owned receipt。

### W2-03 CLI lifecycle

将 `src/cli/index.ts` 收缩为 pre-bootstrap、routing、production bootstrap、transport binding 和统一 shutdown。修复 Wire 在 gateway 创建前启动、prompt keepalive TDZ、分支直接 `process.exit`；`bootstrapShutdown.ts` 改为全部 disposer 尝试并聚合错误，SIGINT/SIGTERM/正常结束/bootstrap failure 走同一幂等关闭。

### W2-04 真实 E2E 与 legacy reachability

新增 production composition/CLI/Wire/HTTP/TUI/MCP stdio+HTTP/legacy-cutoff process-level tests；必须 spawn `dist/cli/index.js` 或 packed bin，不能用 fake GatewayPort。加入 AST/import dependency gate、constructor gate、runtime legacy usage counter；modern-required 时 legacy 不可达，显式旧路径返回 `LEGACY_PATH_DISABLED`；shadow 不得双执行副作用。

**Wave 2 完成定义：** CLI/Wire/HTTP/TUI/MCP 共享一次 bootstrap、一个 GatewayService、一个 service graph、一个 shutdown，真实 E2E 证明 readiness、session/correlation/cancel、认证和资源关闭。

---

## Wave 3：现代能力逐项接线

按顺序执行，并在每项通过正式 regression 后才把路由从 shadow 切 modern：

1. **Session/SessionStart**：修改 session generator/domain/persist/read/SessionService；canonical/hash 在 generate、validate、persist、read-back 四处重算；每个 session 生命周期只生成一次，能力/hook snapshot 完成后原子持久化；修复“全零 hash 通过”的测试。
2. **Memory**：作为 Gateway method 切换所有读写入口，验证 ownership/scope。
3. **Build**：`/build`、`scaffold_build`、scaffold/verify/gate/evidence 全部 delegate `BuildService.compileAndRun`；唯一 preview/staging/verifier/evidence/CompletionGate/commit authority。
4. **CLI → Wire → HTTP**：按此顺序切 headless transport；Wire ready 前拒绝，HTTP 同步启用 security adapter；终态只来自 completionTransport。
5. **Voice**：补齐 VoiceSession、audio device、FFmpeg/whisper worker、transcript storage、AbortSignal、state transition、cleanup，再将 kernel/TUI voice 降为 facade；无真实设备保持 blocked。
6. **Computer/Browser**：所有 robot/UIA/Playwright/computer_open 经 ComputerUseService + PDP/approval/postcondition/evidence；observe-only shadow 不得第二次 Act；真实 Windows acceptance 前不切默认 modern。
7. **Plugin**：concrete OS-enforced sandbox/probe、permission broker、signature verification、owner scope 原子升级/disable；legacy plugin loader 只能是 compatibility adapter。
8. **Subagent**：live process host（start 返回 running receipt）、scope/budget 传递、worktree realpath、effect fence、stop/cancel/recovery；修复 fenced=false 成功和过早删除 worktree。
9. **MCP**：extensions phase 接入 outgoing client 并纳入 shutdown；再启用 incoming stdio/Streamable HTTP；只发布真实 delivered surface，`NOT_DELIVERED` fail-closed。
10. **TUI**：逐步把 `WxGatewayKernel` 缩成 presentation adapter；TUI 不直接访问 DB/agent/memory，resume 使用真实 session。

**Wave 3 完成定义：** 所有真实入口接线；modern-required 下 legacy import/constructor/usage 为零；具体 sandbox、真实设备等缺失时保持 blocked，不宣称 delivered。

---

## Wave 4：发行边界、安装器和首次体验

### DX-01 data-dir

修改 `src/cli/args.ts`、`src/cli/index.ts`、`preBootstrapOnboarding.ts`、`src/kernel/paths.ts`。`--data-dir` 进入唯一 parser，结果贯穿 locale、SQLite、logs、MCP、plugins、models/cache、HAR；优先级 CLI > env > cwd default；help/version 不创建目录；non-TTY 不挂起。新增 parser 和 packed process smoke。

### DX-02/03 npm boundary/clean smoke

修改根 `package.json`、`packages/wxnodus-ink`、tsconfig/build scripts；新增 package boundary/build/pack scripts 和 tests。根包使用正向 `files` allowlist，仅运行时/metadata/README/LICENSE，禁止 src/tests/docs/artifacts/db/secrets/本机路径；ink 的 runtime/types 输出 dist，workspace 外可解析。分开验证 npm tgz clean install 与 airgap self-contained installer，记录 tgz/hash、清单、module resolution、HOME/cwd/data-dir 隔离。

### DX-04 installer lifecycle

让 `scripts/package-installer.ts` 消费冻结 candidate（ID/commit/tgz hash/OS-arch-Node cell/staged tree/entrypoint），不再猜 `dist/cli`；验证 manifest 后 staging、postcondition、atomic switch、upgrade/recover/uninstall；ownership journal 不删除外部 data。缺 runtime/dependency、tamper、postcondition 失败均 fail-closed，保留 deterministic ZIP/readback。

### DX-05 English/first-run

扩展 `en.ts`、`zh-CN.ts` 与 presentation 文案；新增 catalog coverage 和 CLI/TUI snapshots。domain 保留 code/key/params，presentation 本地化；JSON/Wire code 不本地化；en 禁止中文 fallback。packed process 验证首次 TTY 只提示一次、non-TTY 不提示、`--lang` 优先级和 `--lang en --help` 无中文。

**Wave 4 完成定义：** packed npm 和 installer 可在 workspace 外运行；help/version/first-run/data-dir/English process smoke 通过；airgap 缺失时是 blocked/incomplete，不把 ZIP 自校验称为产品运行证据。

---

## Wave 5：Market 信任与 HAR 隐私

### W5-01 Market

修改 `marketSigning.ts` 为 canonical signed envelope，将 id/kind/version/publisher/payload digest/expiry/scope 纳入签名；新增 `marketTrustRoot.ts`、`marketPolicy.ts`、SQLite market repository/migrations。trust root 独立 pinned，不能从 item server 获得；支持 generation 单调递增、旧 root 授权 rotation、retirement/revocation。Market `/keys`、`/publish`、`/revoke` 使用管理 Bearer token hash、scope、nonce/replay、body limit、审计 journal；相同 id/version 不可覆盖。测试 server 同时替换 item+key、重启持久化、撤销、回滚、权限、重放和 DB integrity。

### W5-02 HAR

新增 `redactionPolicy.ts`、`harQuotaPolicy.ts`、`harRetention.ts`；修改 `harCaptureAdapter.ts`、`cdpHarProbe.ts`。事件进入内存/evidence 前即删除 URL userinfo 和敏感 query（token、access_token、refresh_token、api_key、client_secret、signature、code 等）；无法安全 parse 则拒绝。限制 event/URL/session/file/directory bytes、文件数和 retention；超限写 `complete:false`、reason、counts、policy digest；pending Map 在 complete/fail/abort/finalize 清空；临时文件+fsync+rename；retention 只删 owned 文件。secret 不得出现在内存、HAR、日志、attachment。

---

## Wave 6：证据、Gate E/H/I 与唯一 finalizer

### W6-01 Requirement evidence

落地 evidence index/import/resolver；当前 candidate 绑定 runId、commit、artifact ID/SHA、suite/platform/profile/scenario/gate、import provenance，使用 repo-relative path，禁止历史 candidate 借用。只有当前 candidate 的 passed closed evidence 才能将 R01–R20 标为 verified；否则保持 planned/blocked/incomplete。

### W6-02 Gate E

修改 `windowsAcceptanceContract.mjs`、`run-windows-acceptance.mjs`、`provision-windows-runner.ps1`、场景脚本和 aggregator。显式 `--runner-snapshot`；真实探测 self-hosted/interactive/unlocked desktop、物理麦克风、SAPI voice/playback、双物理显示器、negative-origin monitor、mixed-DPI/per-monitor DPI、fixture lock；voice cancellation 必须真实执行。全部 required scenarios 每个 passed scenario 至少有 hashed attachment。

拆除循环依赖：`receipt-core.json`（不含 manifest hash）→ `manifest.json`（hash core+attachments）→ manifest 外 `receipt-index.json`（引用两者 hash）。aggregator 先重算 index/manifest/rootDigest/entries，再解析 core；closure 由 validator 计算。Win11 24H2 build 26100 与 Win10 22H2 build 19045 必须绑定同一 frozen candidate/run/artifact；任一 runner blocked，aggregate 仍 blocked。

### W6-03 Gate H/I

Gate H 使用真实 npm boundary、workspace 外 clean install、airgap installer、install/upgrade/recover/uninstall/tamper/blank HOME+data-dir evidence；不能用 fixture-only contract 替代。Gate I 只接受真实 Linux/macOS worker receipt；本机 skip/模拟不算通过。

### W6-04 `release:finalize`

新增 `scripts/finalize-release.mjs`、`check-release-surface.mjs` 与 release/failure tests。唯一 operator-facing 命令为 `npm run release:finalize`；`pack:release` 仅 candidate builder，旧 `gate:*` 仅诊断。顺序固定为：import evidence → legacy reachability → requirement coverage → 读取 immutable candidate → report → recompute hashes → 比对 E/H/I digest → release gate → completion gate → report/sign。finalizer 不重建 candidate、不发布、不 tag；缺证据、candidate drift、blocked receipt、skip-as-pass 必须非零。只有 A–I、requirements 和 CompletionGate 全部通过才可生成 GA success certificate；否则只生成事实报告。

---

## 依赖、提交边界和最终验收

依赖图：`W0 truth/protocol → W1 security → W2 composition root/Gateway → W3 service wiring → W4 distribution/experience → W5 Market/HAR → W6 candidate/evidence/physical gates/finalizer`。W1 的 path boundary、PowerShell literal、bounded reader、effect fence、hook adapter 可在 W0 RED 后并行；DX-01 必须早于 clean first-run；installer 必须消费已验证 candidate；HAR 脱敏必须早于长期存储；candidate 必须在 Gate E/H/I 前冻结。

每个子任务提交边界：合同+RED；最小实现；真实入口接线；regression/legacy cutoff；evidence/report。每个 Wave 运行：

```text
npm.cmd run typecheck
npm.cmd run typecheck:tests
npm.cmd run build
npm.cmd run check:test-discovery
npm.cmd test
npm.cmd exec -- vitest run tests/wave-p0
npm.cmd run test:known-failures
```

物理/发布阶段运行真实 runner 命令、`gate:completion -- --run <immutable-run-id>` 和 `release:finalize -- --candidate <frozen-candidate-id>`；环境不足只记 blocked/incomplete/inconclusive。

最终完成定义：真实 CLI bin 调用 production `createApplication`；所有入口共享一个 Gateway/application graph/shutdown；P0 blocker 清零或明确 blocked；legacy dependency/runtime/behavior gates 关闭；Build/Memory/Computer/Voice/Plugin/Subagent/MCP 真实接线；npm/airgap workspace 外运行；data-dir 与 English 全链路通过；Market 独立 root+持久化+认证；HAR 预存储脱敏+配额；R01–R20 绑定当前 candidate verified evidence；Gate H/I 真实通过；Gate E 有同一 candidate 的 Win11/Win10 双物理 closed receipt；唯一 `release:finalize` 成功。任何条件不满足都保持真实状态，不标记 goal complete。