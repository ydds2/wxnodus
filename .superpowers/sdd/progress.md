# WxNodus V3 Production Hardening Progress

## Workspace

- Worktree: `C:/Users/20164/Desktop/WxNodusV3CLI-production-hardening`
- Branch: `feature/production-hardening`
- Baseline: `7452895a2a499c2a8da6729fe11851cb4e4befba`
- Plan: `docs/superpowers/plans/2026-08-14-wxnodus-production-hardening.md`
- Status: in progress; not production-ready; Gate E remains blocked.

## Invariants

- Preserve WeakSet receipt ownership through `evidenceStore.owns()` and `reviewerVerifier.owns()`; do not add or trust a `trusted` field.
- Missing, unclosed, tampered, cancelled, or inconclusive evidence never yields `succeeded`.
- Do not manufacture Win11/Win10 physical receipts. Gate E remains `blocked` until both real OS-keyed receipts bind to the same immutable candidate.
- Do not publish, tag, push, create releases, or mark the goal complete automatically.

## Baseline verification — 2026-08-14

- `npm ci`: passed (309 packages installed; deprecation warnings only).
- Full `npm test`: failed: 7 files, 2 tests.
  - Five UI suites could not load `packages/wxnodus-ink/dist/entry-exports.js`. Root `npm run build` compiles the root `dist` but does not build this local package output; this is a reproducible setup/package-boundary defect.
  - `tests/kernel-taskRunner.test.ts` failed once because a child log was still empty. Isolated-root rerun passed 13/13; retain as an observed flaky/race signal, not a resolved defect.
  - `tests/kernel-voice.test.ts` expects real files under git-ignored `data/voice`; isolated worktree rerun failed 1/7. This is a non-portable test prerequisite and cannot be counted as product evidence.
- `npm run build`: passed, but did not create `packages/wxnodus-ink/dist/entry-exports.js`.
- Isolated-root UI rerun after root build: still failed all five suites with the same missing local-package dist error.
- Isolated-root taskRunner rerun: passed 13/13.
- Isolated-root voice rerun: failed 1/7 due to absent ignored whisper binary/model.
- Main checkout and isolated worktree remained clean after verification.

Baseline is accepted as accurately characterized, not green. Wave work must preserve these failures in reports until their owning waves repair them (taskRunner/effect fence in Wave 1, package boundary and voice packaging in Waves 3–4).

## Wave ledger

| Item | Status | Notes |
|---|---|---|
| Baseline/worktree | completed | Correct ancestry and isolated root verified; baseline failures classified above. |
| W0-01 Completion authority | core-complete | WeakSet receipt + coordinator + gate + evidence write perimeter + BuildService + gate:completion adapter + Gate G wired; transport cutoffs (CommandBus/agent/CLI/HTTP/Wire) deferred to Wave 3 wiring. |
| W0-02 Release eligibility | core-complete | `releaseEligibility` + `check-release-eligibility` adapter; open KF blocks with `RELEASE_BLOCKED_OPEN_P0`; required gate failed/blocked/cancelled/inconclusive/incomplete/na never release; resolved-KF regression existence enforced. |
| W0-03 Evidence/requirements | core-complete | Versioned evidence index + requirement resolver; verified requirements must bind current candidate/index fully; current all-planned requirements stay unverifiable (20/20 `REQUIREMENT_NOT_VERIFIED` in release mode). |
| Wave 1 security | P0 batch done | P0-01 serve auth+CSRF+health-minimal+413; P0-02 browser session service (owner close, connectedAddress fail-closed); P0-03 PS literal + installer path policy; P0-04 pathBoundary; P0-05 memory scope authority; P0-06 hook fail-closed + KF-026 migrated; P0-07 effect fence + KF-025 migrated; P0-08 bounded reader/target policy + safeFetchText rewired (DNS fail-closed, oversized rejected not truncated). Remaining Wave 1 wiring: kernel/browser.ts facade delegation + KF-012; installer dependency closure (Wave 4 DX-04). |
| Wave 2 composition root | in progress | W2-01 immutable `CompositionRoutingSnapshot`; W2-02 GatewayService dispatcher (`createGatewayService` — unknown method stable-fails, no legacy fallback); W2-03 unified idempotent shutdown (all disposers attempted, failure ids aggregated). Remaining: production bootstrap factory wiring, CLI lifecycle consolidation, real E2E (W2-04). |
| Wave 3 capabilities | pending | Modern service islands not fully wired. |
| Wave 4 distribution/DX | pending | Includes local ink build boundary and voice asset portability. |
| Wave 5 Market/HAR | pending | Independent trust root and pre-storage redaction required. |
| Wave 6 physical/finalizer | pending | Gate E/H/I evidence unavailable; remain blocked/incomplete. |

## W0-01 authority perimeter — 2026-08-14

Verified chain: `FileEvidenceStore → ReviewerAttestationVerifier → CompletionGate → CompletionCoordinator → owned CompletionDecisionReceipt`.

- `FileEvidenceStore`: synchronous input snapshots for `append`/`appendClosed`/`appendBundle`; root pinned via `resolve()`; pre-existing root/parent junction writes rejected; root-wide cross-process writer lock (bounded retries, fail-closed `EVIDENCE_WRITE_LOCKED`, identity-checked release); exact-once record serialization; returned ref derived from the published bytes; post-publish `verifyRunBundle` readback with rollback on mismatch (new-run cleanup, old-run restore); reviewer receipts minted only via `readVerifiedClosed`.
- `CompletionGate`: required criteria matched as a set against the signed binding, results emitted in signed order; `requiredCriterionIds` part of the signed review binding; v1 attestations verified for historical integrity but never authorize completion (`REVIEW_ATTESTATION_SCHEMA_UNSUPPORTED`); new attestations signed as schemaVersion 2.
- `CompletionCoordinator`: genuine brand (`#brand`), prototype-bound `decide`/`owns` calls bypass subclass overrides, trusted clock only.
- `BuildService`: `ports.decide` removed; commit authority is solely an owned `succeeded` receipt from the injected genuine coordinator; every post-stage failure abandons staging; snapshot carries artifactId/environmentHash/policyHash.
- Gate G (`evaluateWave1Gates`): evidence/reviewer ownership plus coordinator receipt; no local criteria aggregation; missing/fake coordinator fail closed.
- `gate:completion`: `scripts/run-completion-gate.mjs` is now a launcher only; `src/cli/runCompletionGate.ts` orchestrates the authority (bundle integrity → persisted binding+attestation → reviewer trust config → owned receipts → owned decision); missing inputs block; exit codes propagate exactly; `run-wave3-gates.mjs` preserves Gate G child exit codes.
- Regressions: 104 passed / 5 skipped across the W0-01 suites plus cross-process writes (both records preserved, no lock artifacts; pre-existing lock fails closed without run mutation).
- Known baseline gaps unchanged: five UI suites need `packages/wxnodus-ink/dist/entry-exports.js` (Wave 4); `tests/kernel-voice.test.ts` needs git-ignored `data/voice` assets (Wave 3–4).

## Wave 0 verification — 2026-08-14

- `npm run build` / `typecheck` / `typecheck:tests` / `check:test-discovery`: passed.
- Focused authority regression set (23 files): 255 passed / 5 skipped.
- `test:known-failures` oracle: 31/31 (open cases emit stable failure codes; resolved cases are green regressions on disk).
- Full `npm test`: 1490 passed / 10 skipped / 1 failed + 5 UI suites — identical to the characterized baseline (voice assets absent; local ink dist missing). No new regressions.
- `git diff --check`: clean. Wave 0 committed as `7146357`, `fa59d4e`, `37acb5c`.
- Honest status: CompletionGate is the sole decision authority in the domain/app/release layer; Gate E remains `blocked` (no physical receipts); CommandBus/agent/CLI/HTTP/Wire transport cutoffs remain un-wired and are tracked as part of Wave 2–3 composition wiring, not counted as done here.

## Wave 2 progress — 2026-08-14

Committed as `50bb8e5` (W2-01), `3c7e796` (W2-02), `1fc0ee3` (W2-03), `2e6fada` (branding UI). Merged to master as `6c8edcb` — master now carries all Wave 0–2 + branding work; merged-master full suite is 198 files / 1651 passed / 10 skipped / 0 failed (exit 0), typecheck x2 + discovery clean. The single worktree voice failure does not exist on master (voice assets are untracked in the main checkout only).

- W2-01: immutable `CompositionRoutingSnapshot` (`src/bootstrap/compositionRouting.ts`) — operator flag/env/workspace precedence; modern/required downgrade denied; default legacy.
- W2-02: `createGatewayService` dispatcher — full source/session/correlation/signal propagation; `GATEWAY_METHOD_UNKNOWN` for unknown methods (no legacy fallback); handler exceptions fail closed (`GATEWAY_METHOD_FAILED`); optional `publish` event path.
- W2-03: `bootstrapShutdown` now attempts every disposer in strict reverse order, aggregates failing resource ids, and reuses the settled result on repeated calls.
- Branding UI: persistent black-hole brand bar (accretion-disk gradient rule + event-horizon core ◉), turn separators rebranded, `brandRule.ts` pure functions TDD'd; all seven UI suites green in the worktree after building the local ink dist (`packages/wxnodus-ink/dist/entry-exports.js`).
- Full suite now: 1650 passed / 10 skipped / 1 failed — the only failure is the known voice-asset gap (`tests/kernel-voice.test.ts`). The five UI suites that previously failed on missing ink dist are now green locally; wiring the ink build into the root build chain remains a Wave 4 (DX-02) boundary item.
- Remaining in Wave 2: production bootstrap factory wiring, CLI lifecycle consolidation, real process-level E2E (W2-04).

Committed as `481ceda` (P0-04), `12eb537` (P0-05), `9a44dd7` (P0-06), `ecf43eb` (P0-08 infrastructure), `567778c` (P0-07).

- P0-04: `src/infrastructure/fs/pathBoundary.ts` (lexical + realpath/symlink/junction double check) wired into `WorkspaceTransaction` commit/diff; junction escape now `BUILD_PATH_UNSAFE_SYMLINK`.
- P0-05: `MemoryService` is the append/update/delete/search authority; scope comes only from injected trusted context; forged session inputs impossible; cross-scope update/delete `MEMORY_SCOPE_DENIED`; global read requires explicit opt-in.
- P0-06: structured `HookExecutionOutcome` + `decideSecurityHook`; security-critical hook crash/timeout/missing/non-zero exit deny; KF-026 migrated (case retired, formal regression green).
- P0-07: task kill aborts the agent-line effect fence; late subagent results never settle; KF-025 migrated (case retired, formal regression green).
- P0-08 (infrastructure): `boundedResponseReader` (Content-Length pre-reject; real-byte chunk limit with stream cancel) and `outboundTargetPolicy` (scheme/target/DNS fail-closed; private address in resolved set rejects). Kernel `safeFetchText` rewiring to these primitives is not yet done.
- Verification: build/typecheck/typecheck:tests/discovery clean; full suite 1518 passed / 10 skipped / 1 failed + 5 UI suites — identical characterized baseline, no new regressions; known-failure oracle 31/31 (25 open emit stable codes, 6 resolved are green regressions incl. KF-025/026).


## Wave 3 progress — 2026-08-14

Committed as `251c21a` (W2-03/04 CLI lifecycle), `6c8edcb` (merge to master), and the W3 Build routing step.

- Merge: Wave 0-2 + branding now live on master; merged-master suite 198 files / 1651 passed / 0 failed.
- W2-03/04: `src/cli/headlessGateway.ts` (real headless wire gateway - dispatcher + responder semantics with fail-closed timeouts), keepalive TDZ fixed, unified idempotent shutdown wired across serve/keepalive/TUI/signals, real `dist/cli` process-level smoke (version/help/exit codes, zero side effects, unknown-flag fail-closed exit 2).
- W3 Build step 1: `src/commands/buildRouting.ts` - build capability routing (declared capability > root default; modern/required fail closed with `BUILD_MODERN_UNAVAILABLE` while `compileAndRun` production wiring is incomplete; legacy/shadow unchanged). `/build` handler enforces it.
- Full suite: 201 files / 1666 passed / 10 skipped / 0 failed.
- Remaining W3: `BuildService.compileAndRun` full production ports (staging workspace/verifier map/nodes/static entry/completion input), then session/memory/voice/computer/plugin/subagent/MCP/TUI in order.


## Wave 4 progress (DX-02) — 2026-08-14

- DX-02 build boundary: root `build` now chains `build:ink` (esbuild bundle of `packages/wxnodus-ink`) before `tsc`. Simulated clean checkout (`rm -rf dist packages/wxnodus-ink/dist` → `npm run build`) rebuilds both and all ten UI suites pass (91/91). Contract test `tests/wave4/w4-build-boundary.test.ts` locks the chain.
- Full suite: 202 files / 1669 passed / 10 skipped / 0 failed.
- Remaining DX: npm tgz boundary (files allowlist), installer lifecycle, data-dir parser, English/first-run.


## Wave 3 progress (Build wiring) — 2026-08-14

- `src/application/build/buildServiceWiring.ts`: production port assembly for `BuildService.compileAndRun` — real `WorkspaceTransaction` staging, verifier-map against the 16 builtin verifier descriptors, real probe (file.exists/file.content/command.exit-code implemented; the other 13 crash honestly, never fake-pass), real `EvidenceService.close` → `readVerifiedClosed` → Ed25519 reviewer attestation → `CompletionGate` → coordinator owned receipt. Missing snapshot providers fail closed (`BUILD_SNAPSHOT_UNAVAILABLE`).
- `buildService.ts` contract fix: `nodes` factory now receives the spec, and the static-entry check runs after the DAG (scaffold writes the project into staging first) — previously the pre-check on an empty staging dir would always fail in production.
- Tests: `tests/wave3/w3-build-service-wiring.test.ts` 6/6 — full chain to an owned `succeeded` receipt with real evidence store + real signatures.
- Full suite: 203 files / 1675 passed / 10 skipped / 0 failed.
- Remaining: `/build` handler modern branch wiring (reviewer key persistence + snapshot services), then session/memory/voice/computer/plugin/subagent/MCP/TUI.


## Wave 3 progress (reviewer key persistence) — 2026-08-14

- `src/application/quality/reviewerKeyService.ts`: persisted Ed25519 reviewer identity — private key encrypted (AES via injected cipher, machine-fingerprint bound in production), plaintext never touches disk; idempotent load-or-create; corrupted ciphertext fails closed (`REVIEWER_KEY_CORRUPT`) instead of silently regenerating (which would invalidate all historical attestations).
- Interop test proves the full chain now runs end-to-end with a persisted key service: `createReviewerKeyService` bundle → `createProductionBuildWiring` → `compileAndRun` → owned `succeeded` receipt.
- Full suite: 204 files / 1681 passed / 10 skipped / 0 failed.
- Remaining for `/build` modern branch: spec→acceptance contract (rule-brain specs carry no verifierId — honest fail-closed until structured acceptance exists), snapshot service wiring (environment/capability/policy), then handler flip.


## Wave 3 progress (Session step 1) — 2026-08-14

- `src/domain/sessions/sessionStart.ts`: `validateSessionStart` now recomputes the canonical sha256 and rejects all-zero/drifted hashes (`SESSION_START_HASH_MISMATCH`) — previously only the 64-hex shape was checked and `'0'.repeat(64)` passed. Canonical serialization and hashing are single-source in the domain; generator reuses them.
- `readSessionStart`: read-back recomputation — disk tampering (field change without hash) and half-written/non-JSON files are rejected.
- Contract test fixed: the old assertion that an all-zero hash passes now asserts rejection; new tamper/malformed read-back cases added (7/7).
- Full suite: 204 files / 1681 passed / 10 skipped / 0 failed.
- Remaining Session: generate once per session lifecycle + atomic persistence after capability/hook snapshot + production entry wiring (TUI/kernel session creation).


## Wave 3 progress (Session step 2) — 2026-08-14

- `src/application/sessions/sessionStartService.ts`: per-session artifact service — generate exactly once per session lifecycle (in-flight dedup for concurrent ensure, disk reuse with read-back recomputation, tamper rejection without silent regeneration), atomic persistence (tmp+rename) confirmed by read-back.
- Tests 4/4: exactly-once generation, concurrent dedup, disk reuse, tamper rejection.
- Full suite: 205 files / 1685 passed / 10 skipped / 0 failed.
- Remaining Session: production entry wiring (TUI/kernel session creation calling ensure with real capability/hook snapshots).


## Wave 3 progress (Session step 3, production wiring) — 2026-08-14

- `/new` now calls the session start service: artifact (capability snapshot from the builtin verifier capability union, hook snapshot from settings.hooks sessionStart, sha256 binding) is persisted atomically before the session row is inserted; generation failure fails the command closed (no artifact-less sessions).
- Real-bug fixes found by the process test: empty model on no-key runs now falls back to `rule-brain` (validator rejects empty model); artifact dir is `<cwd>/data/sessions/<id>/session-start.json` (resolveDataDir → `join(cwd,'data')`).
- Process-level test `tests/wave3/w3-session-start-cli.test.ts` spawns the real `dist/cli -p /new` and validates the on-disk artifact through `validateSessionStart` (sha256 recomputation).
- Full suite: 206 files / 1686 passed / 10 skipped / 0 failed.


## Wave 3 progress (Memory gateway methods) — 2026-08-14

- `src/application/memory/memoryGatewayMethods.ts`: memory append/update/delete/search exposed as Gateway methods; scope is built only from the trusted `GatewayServiceRequest.sessionId` (params-carried forged sessionId is ignored — proven by test); missing text fails closed with specific codes; cross-session update/delete denied at the service boundary.
- Full suite: 207 files / 1691 passed / 10 skipped / 0 failed.
- Remaining Memory: production wiring of legacy `/memory` command + `memory_search` tool + agent recall onto these gateway methods (kernel memory stays as migration read source).


## Wave 3 Memory status — 2026-08-14 (decision made, facade done)

- 数据模型决策（用户定夺）：**影子双写、观察后切换**——legacy 消息写入是唯一行为事实源，影子同步写 modern 显式记忆记录（session scope，失败只计数不上抛，零行为回退）；召回观察期保持 legacy，一致性验证后再定召回策略。
- 影子双写（`4f77baa`）：`src/application/memory/memoryShadow.ts`——append 委托 legacy + 影子写 user/assistant 到 memory_records（contentHash 去重）；`/memory shadow` 观察报告（两模型计数 + 影子健康 + `recallSource:'legacy'` 诚实声明）；CLI 组合根统一装配（agent/handlers/serve 全部经影子包装）；进程级 smoke 验证（legacy 2 条 → shadow 2 条）。
- 入口切换（`aaad645`）：`/memory`（search/delete/update/pin|fade|reset/list）与 `memory_*` 四工具全部切 session-scoped `MemoryService`；scope 只来自可信 `ToolCtx.sessionId`（agent 内部状态注入，参数不可伪造）；端口缺失 fail-closed（`memoryServiceFor 缺失——不回退 legacy 假成功`）。仓库层新增 `list`（作用域隔离）。
- 切换暴露的两个真实缺陷已修：① modern `memory_fts` 原用 unicode61（中文检索退化）→ 统一 `bigramZh` 预处理（`src/infrastructure/sqlite/bigramZh.ts` 单一实现 + `bigram_zh` SQLite 函数注册 + `memory_schema_meta` marker one-time 回填，绝不重复）；② legacy 倍率语义（×3 置顶）与 modern salience∈[0,1] 的语义冲突 → `salienceFromMultiplier` 单调映射（1→0.5、3→0.75、0.3→0.23）+ `salienceFlag` 旗标阈值（0.55/0.45）。
- 测试：`w3-memory-shadow.test.ts` 5/5、`w3-memory-entry-switch.test.ts` 4/4（工具增删改查全闭环走 modern、跨会话隔离、legacy messages 表零触碰）、kernel-tools/store-db/w3-memory-gateway/kernel-memory 全绿。
- 全量：221 文件 / 1753 通过 / 10 跳过 / 0 失败；build/typecheck×2/discovery 干净；CLI 进程 smoke（/memory shadow、/memory list 经 modern 路径）通过。
- 剩余观察项：agent 自动召回仍走 legacy（决策既定——一致性验证后另定）；embedding 向量召回需 worker 接线（pending 状态诚实保持）。


## Wave 1 收尾 / W1-08 生产 ToolExecutionPipeline — 2026-08-14

- 控制面置备（`aeb6cc2`）：`provisionSecurityControlPlane`（幂等 / policy checksum 漂移轮换 / budget 轮换重置 used）；`installSecuritySchema` 幂等化；UoW 公开 `appendJournalEntry` / `commit` / `release`（release 退款、归零清键不留残渣）、`activePolicySnapshotId`/`activeBudgetSnapshotId`。
- 生产装配（`69f63d8`）：`createProductionToolExecution`——11 ports 全真实：resolve=ToolCatalog（builtin:workspace.read/write、network.fetch、process.spawn、memory 五描述符）；validate=required 键校验；normalize=argsHash+effect 资源实例化（NormalizedExecution 携带 toolId）；decide=SqlitePolicyRepository+decideEffect（deny→POLICY_DENIED）；authorizeAndReserve=canonical AuthorizationContext+issue/consume 同事务（require_approval 走审批桥，无桥 APPROVAL_UNAVAILABLE）；execute=pathBoundary/safeFetchText/超时强杀/memory scope 真实实现（未接线 TOOL_EXECUTOR_UNWIRED）；appendJournal=UoW 哈希链；verifyPostcondition=真实再探（写后存在性/大小）；captureEvidence=sha256 原子证据落盘（篡改读回 TOOL_EVIDENCE_INTEGRITY_FAILED）；commitBudget/releaseBudget=退款落链。`DEFAULT_TOOL_POLICY`（allow memory/filesystem.read；require_approval write/network/process；无规则 deny）。
- 消费端接线（`4912a9d`）：plugin broker 权限请求（/plugin modern 分支 ctx.toolPipeline）与 MCP delivered memory surface（`createMcpIncomingServer` 注入生产 pipeline，`builtin:memory` 真实返回 session 显式记忆 verified receipt）都走生产 pipeline；broker/pipeline 未装配时两处保持原诚实 fail-closed（PLUGIN_BROKER_PIPELINE_UNAVAILABLE / NOT_DELIVERED）。CLI 组合根装配 policy/budget 置备 + TUI 审批桥。
- 测试：`w1-08-pipeline-provisioning.test.ts` 5/5、`w3-tool-execution-wiring.test.ts` 11/11（全链 allow 回执 + journal 链 + 证据读回；APPROVAL_UNAVAILABLE/POLICY_DENIED 零副作用；真实写+后置再探；越界释放退款；BUDGET_EXCEEDED；hard redline PDP 拒绝；TOOL_NOT_FOUND；预取消无预算泄漏；MCP adapter 真实 verified receipt；broker 越界 fail-closed）。
- 全量：223 文件 / 1769 通过 / 10 跳过 / 0 失败；build/typecheck×2/discovery 干净；CLI 进程 smoke（policy/budget 快照激活 + /memory shadow + 确定性计算）通过。
- 剩余：agent 主路径 executeTool 尚未切到生产 pipeline（legacy 工具执行保持——迁移需 toolId/effects 全表映射，另行一步）；MCP `session` surface 仍 CAPABILITY_UNAVAILABLE（registry fence，诚实保持）。


## Wave 3 progress (transport readiness) — 2026-08-14

- KF-027 migrated atomically (case retired, formal regression added): the wire stdin RPC frame handler in `src/cli/index.ts` now gates dispatch behind `wireReady` — frames arriving before gateway/frontend/subscription assembly complete return `WIRE_GATEWAY_NOT_READY` instead of being silently dropped or dispatched early.
- Known-failure oracle: 31/31 (23 open stable + 7 resolved green regressions incl. KF-027).
- Full suite: 208 files / 1693 passed / 10 skipped / 0 failed.
- Remaining transport: HTTP terminal-status parity under the security adapter (mostly done in P0-01), then Voice/Computer/Plugin/Subagent/MCP/TUI.


## Wave 3 progress (Voice step 1) — 2026-08-14

- `src/commands/voiceRouting.ts`: voice capability routing (same shape as build routing) — modern/required fails closed with `VOICE_MODERN_UNAVAILABLE` while kernel/TUI voice is not yet a `VoiceSessionService` facade; legacy/shadow unchanged. `/voice` handler enforces it.
- VoiceSessionService/domain/audio-contract/worker-failure tests already exist (W3-03/04 suites); facade collapse is the remaining step.
- Full suite: 209 files / 1698 passed / 10 skipped / 0 failed.


## Wave 3 progress (Computer/Browser step 1) — 2026-08-14

- `src/commands/computerRouting.ts`: computer + browser capability routing (shared generic, same fail-closed shape as build/voice) — modern/required fails closed with `COMPUTER_MODERN_UNAVAILABLE` / `BROWSER_MODERN_UNAVAILABLE` while ComputerUseService full-port wiring (PDP/approval/postcondition/evidence) is incomplete; legacy/shadow unchanged; `/computer` and `/browser` handlers enforce it.
- Full suite: 210 files / 1703 passed / 10 skipped / 0 failed.


## Wave 3 progress (Plugin/Subagent/MCP step 1) — 2026-08-14

- `src/commands/extensionRouting.ts`: plugin/subagent/mcp capability routing (shared generic) — modern/required fails closed (`PLUGIN_MODERN_UNAVAILABLE` / `SUBAGENT_MODERN_UNAVAILABLE` / `MCP_MODERN_UNAVAILABLE`) while the respective production wiring (OS sandbox/permission broker/signature; live process host/effect fence; extensions phase + shutdown) is incomplete; legacy/shadow unchanged. `/plugin`, `/mcp`, `/delegate` handlers enforce it.
- Wave 3 routing coverage now spans build, voice, computer, browser, plugin, subagent, mcp — all fail-closed, all legacy-preserving.
- Full suite: 211 files / 1708 passed / 10 skipped / 0 failed.


## Wave 3 progress (TUI step 1) — 2026-08-14

- `src/bootstrap/tuiRouting.ts`: TUI assembly routing — modern/required fails closed (`TUI_MODERN_UNAVAILABLE`, unified shutdown then exit 2) while `WxGatewayKernel` is not yet collapsed to a presentation adapter; legacy/shadow unchanged. CLI TUI assembly enforces it before constructing GatewayClient.
- Wave 3 routing now covers all eight capabilities: build, voice, computer, browser, plugin, subagent, mcp, tui — every modern request fails closed with a specific code until the real wiring lands; every legacy/shadow path preserves current behavior.
- Full suite: 212 files / 1713 passed / 10 skipped / 0 failed.


## Wave 3 progress (Voice step 2, state machine + transcript storage) — 2026-08-14

- `VoiceSessionService` now enforces the domain state machine (`transitionVoice`) — illegal jumps fail closed (`VOICE_ILLEGAL_TRANSITION`); transcribe requires the legal `speech_detected` precondition; successful exit walks thinking→idle, abort cancelling→idle, failure error→idle.
- Transcript storage port added: transcription text is persisted through the injected store and the service only ever returns the opaque `transcript://<id>` ref (plaintext never flows out of the service layer); save failures surface as the terminal result.
- Existing voice suites updated to the legal state path (7 suites / 19 tests green).
- Full suite: 213 files / 1718 passed / 10 skipped / 0 failed (one heapdump test timed out under parallel-suite load in the first run; isolated rerun 7/7 in 2.6s — environment flake, not a regression).


## Wave 3 progress (Voice facade done) — 2026-08-14

- `src/kernel/voice.ts` `stopAndTranscribe` now delegates execution to `VoiceSessionService` (production deps: async whisper supervisor with AbortSignal + process-tree kill, temp cleanup, transcript store persisting under `dataDir/voice/transcripts/<id>.txt` with opaque-ref-only reads). Kernel keeps capture/device enumeration/TTS as a platform adapter. `VOICE_FACADE_DONE` flipped true — modern voice routing is now live; voice suites 20/20.
- Full suite: 213 files / 1716 passed / 10 skipped / 0 failed.


## Wave 3 progress (Computer wiring) — 2026-08-14

- `src/application/computer/computerWiring.ts`: production port assembly for `ComputerUseService` — observer/driver delegate to kernel ComputerUse (screenshots/robotjs), postconditions reuse the 16 builtin verifiers (unimplemented verifiers crash honestly; observation values pass through fully so re-observe anchors like `path` reach verifier inputs), injected pdp/approvals/evidence fail closed when absent.
- `src/application/computer/computerEvidenceStore.ts`: real on-disk audit evidence (JSON + sha256 binding + atomic write + read-back recomputation; tamper rejected `COMPUTER_EVIDENCE_INTEGRITY_FAILED`).
- Tests 4/4: full pipeline stage order with evidence read-back, fail-closed without pdp, tampered-evidence rejection, high-impact kind recognition.
- Full suite: 214 files / 1720 passed / 10 skipped / 0 failed (two flaky timeouts under parallel load — taskRunner log-flush and heapdump — pass 20/20 in isolation, unrelated to this change).
- Remaining: `/computer` handler modern branch assembly (approval bridge type + request mapping) then COMPUTER_SERVICE_WIRED flip; browser wiring.


## Wave 3 progress (Computer facade done) — 2026-08-14

- `/computer` modern branch assembled for real: `ComputerUseService` shared pipeline with kernel driver, high-impact approval bridge via `ctx.gateway.requestApproval` (no bridge → `COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED` fail-closed), on-disk evidence via `createComputerEvidenceStore`. Unverifiable actions return `COMPUTER_POSTCONDITION_FAILED` honestly (never fake success). Kernel construction routes through `createKernelComputerUse` compat so the legacy-import gate stays green. `COMPUTER_SERVICE_WIRED` flipped true.
- Full suite: 214 files / 1720 passed / 10 skipped / 0 failed.
- Remaining computer: browser wiring (Playwright via service), observe/uia modern migration.


## Wave 3 progress (Browser facade done) — 2026-08-14

- `src/application/computer/browserWiring.ts`: production browser assembly — `UrlPolicy` with real dns resolution (loopback/private/link-local/multicast/userinfo/scheme all denied), `PlaywrightBrowserDriver` with per-session contexts and connectedAddress resolution-layer verification; launch failure honest (`BROWSER_LAUNCH_FAILED`).
- `/browser` modern branch: entry URL authorization first, then `BrowserSessionService` (owner-checked) open/navigate/close, evidence via `createComputerEvidenceStore`. `BROWSER_SERVICE_WIRED` flipped true.
- Tests 5/5: public URL authorized, loopback/private/unknown-host denied, owned session lifecycle, connectedAddress unavailable fail-closed.
- Full suite: 215 files / 1725 passed / 10 skipped / 0 failed.


## Wave 3 progress (Plugin step 1, production sandbox) — 2026-08-14

- `src/infrastructure/plugins/processIsolationSandbox.ts`: first concrete PluginSandbox implementation — real child-process isolation (cleared environment, piped stdio, no inherited handles, atomic stop), truthful probe evidence (`crash-isolation` with OS-enforcement items false), so untrusted plugins are quarantined by the sandbox gate (`PLUGIN_SANDBOX_UNAVAILABLE`) — never downgraded into a false safety claim. Trusted plugins pass through crash-isolation.
- Tests 4/4: truthful probe, untrusted quarantine, trusted allow, real child-process start/stop.
- Full suite: 216 files / 1729 passed / 10 skipped / 0 failed.
- Remaining plugin: `/plugin` modern branch wiring (broker pipeline injection + scope manager + evidence) then PLUGIN_WIRED flip.


## Wave 3 progress (Build facade done) — 2026-08-14

- `src/build/specAcceptance.ts`: spec → structured acceptance contract — rule-brain scaffolds map to deterministic artifact anchors (`file.exists` on server/index.js + healthcheck.js); unknown scaffolds fail closed (`BUILD_ACCEPTANCE_UNSPECIFIED`) — natural-language acceptance is never disguised as verifiable assertions.
- `/build` modern branch wired for real: staging → scaffold (legacy instantiate as a node) → static entry → verifier → evidence → Ed25519 reviewer (AES-persisted key service) → CompletionGate owned receipt. Snapshot sources: environment (platform/arch/node deterministic), capability (builtin verifier capability union), policy (hooks config canonical hash). `BUILD_SERVICE_WIRED` flipped true.
- Full suite: 217 files / 1732 passed / 10 skipped / 0 failed.


## Wave 3 progress (Plugin facade done) — 2026-08-14

- `/plugin` modern branch wired: `PluginLifecycleService` (manifest → checksum → probe → sandbox gate → owned-scope atomic swap) with the production crash-isolation sandbox, `ExtensionScopeManager`, lifecycle evidence on disk. Broker permission requests fail closed (`PLUGIN_BROKER_PIPELINE_UNAVAILABLE`) until the production `ToolExecutionPipeline` (W1-08 contract) is wired — never fake-executed. `PLUGIN_WIRED` flipped true.
- Full suite: 217 files / 1732 passed / 10 skipped / 0 failed.
- Remaining plugin: production ToolExecutionPipeline (11 ports) for broker capability requests.


## Wave 3 progress (Subagent facade done) — 2026-08-14

- `/delegate` modern branch: live process host — `WorktreeManager` (git add + realpath double check) → real `dist/cli` child process → `SubagentStartReceipt` (taskId/pid/startedAt) with narrowed budget/scope. Stop semantics via `SubagentHost` (fence → taskkill process tree → stop receipt; tree failure → `SUBAGENT_STOP_FAILED`). `SUBAGENT_WIRED` flipped true.
- Full suite: 217 files / 1732 passed / 10 skipped / 0 failed (one known heapdump flaky under parallel load — passes in isolation).


## Wave 3 progress (MCP facade done) — 2026-08-14

- `/mcp` modern branch wired for real: SDK auto-negotiation client host (`connectMcp`) + `McpTransportPolicy` SSRF precheck (real DNS `assertHttpTarget` before connect) + `InMemoryMcpTranscriptStore` redacted audit record. Per-command connect is a one-shot probe (connect → record → dispose) — no leaked resource.
- Incoming server production wiring (`src/application/mcp/mcpServerWiring.ts`): real `CapabilityPort` (Wave1CapabilityRegistry) + fail-closed pipeline — production `ToolExecutionPipeline` (W1-08, blocked on plugin broker) not wired, so every pipeline-reaching surface returns structured `NOT_DELIVERED` (never fake success) + redacted transcript.
- Incoming stdio: `--mcp-server` CLI mode — pre-bootstrap accepts the flag as non-interactive; missing `WXNODUS_MCP_REQUEST_STATE_KEY` fails closed (exit 2, clear message); with key the real `StdioServerTransport` answers initialize (process-level smoke verified, stdout clean of non-protocol bytes).
- Incoming Streamable HTTP: `/mcp` route in `--serve` (POST/GET/DELETE) mounted after CSRF + Bearer — no token → 401; with token the SDK handler answers structured JSON-RPC errors (no fake success).
- Shutdown 纳入: incoming server `close()` registered in the unified idempotent shutdown for both `--mcp-server` and `--serve` (disposer id `mcp-incoming`); outgoing legacy `connectAllMcp` stays under the existing `mcp` disposer.
- `MCP_WIRED` flipped true — modern MCP routing live; routing test updated (modern routes now; shadow/legacy unchanged).
- Tests: `tests/wave3/w3-mcp-wiring.test.ts` 3/3 (key-gate fail-closed, idempotent close, structured HTTP error) + updated `w3-extension-routing.test.ts`; wave2 duplex contract 5/5 unchanged.
- Full suite: 218 files / 1735 passed / 10 skipped / 0 failed.
- Remaining MCP: declared-delivered incoming surfaces (`session`/`memory`) stay honest `CAPABILITY_UNAVAILABLE` / structured `NOT_DELIVERED` until the production `ToolExecutionPipeline` is wired.


## Wave 3 progress (TUI facade done) — 2026-08-14

- `src/presentation/tui/tuiPresentationAdapter.ts`: presentation adapter 端口 + 组合根工厂——GatewayClient/React 不再持有 db/agent/memory 原始句柄；`WxGatewayKernel` 的 db/agent/mem 字段移除，替换为窄端口 `adapter`（sessions/messages/checkpoints/tasks/cron/usage 语义操作 + agent 端口），失败降级语义与迁移前逐点对齐（list→[]、get→零行等）。原始句柄留在组合根（CLI `createTuiPresentationAdapter({ db, agent, ensureSession })`）。
- 源门禁（RED）：`tests/wave3/w3-tui-adapter.test.ts` 断言 `src/wxnodus-ui/wxGateway.ts` 不再含 `this.kernel.db/agent/mem` 与 raw `db: any`/`agent:` 字段；adapter 行为以真实 SQLite round-trip 验证（9/9）。
- Resume 走真实 session：adapter `sessions.ensure` 接 `sessionStartService.ensure`（工件先行/read-back 重算）；`session.create/activate/resume` 工件闸门 fail-closed（无工件会话不产生行），UI 消费端（useConversationLifecycle）对 `ok:false` 形状 fail-closed 不再进入半初始化状态；GatewayClient 级测试证明失败时不落会话行。
- `TUI_ADAPTER_DONE` 翻转 true——modern TUI 路由 live；`w3-tui-routing.test.ts` 更新（modern 路由；shadow/legacy 不变）。
- 全量：219 文件 / 1744 通过 / 10 跳过 / 0 失败；build/typecheck×2/discovery 干净；dist 进程 smoke（--version / -p 确定性计算）通过。
- 剩余 W3：Memory 生产切换（数据模型决策阻塞）+ 生产 ToolExecutionPipeline（W1-08 11 ports，plugin broker 前置）。

## Wave 4 完成（DX-01/03/04/05 + W1-08 UoW 补全）— 2026-08-13

- DX-01 data-dir（`5783172`）：`--data-dir` 唯一 parser（优先级 CLI > env > cwd；CLI 胜出即写回 `WXNODUS_DATA_DIR` 全链路传播）；help/version 零副作用（不建目录不挂起）；`tests/wave4/w4-data-dir.test.ts` 6/6。
- DX-03 npm 边界（`0eaad1f`）：根包正向 `files` allowlist（仅 dist/ink dist/入口/README/LICENSE）+ `@wxnodus/ink` bundledDependencies（ink 自身 files 收紧，src/test 绝不入包）+ prepack 构建链；真实 `npm pack` 清单逐项校验。诚实记录：clean-install 运行时步骤（prebuild 下载）网络 blocked，未把清单当运行证据。
- DX-05 English/first-run（`40f9fd8`）：`cli.usage` 双语目录；`--lang en --help` 纯英文（en 目录无 CJK fallback）；help/version 携带解析后 locale；`tests/wave4/w4-english-first-run.test.ts` 4/4。
- DX-04 installer lifecycle（`65c221e`）：冻结 candidate 校验器（ID/commit/tgz sha256/cell/stagedTree/entry 在树内）+ 依赖闭包（collect/scanDistImport/verify fail-closed `INSTALLER_DEPENDENCY_CLOSURE_INCOMPLETE`）；`scripts/package-installer.ts --candidate` 消费冻结 candidate 不再猜 `dist/cli`；install.ps1 lifecycle（全量 sha256 前置校验 → staging → postcondition → atomic switch backup/rollback → `.wxnodus-journal.json` ownership journal → `-Uninstall` 只删 journal 内文件）；确定性 zip 读回自校验。
- 转义回归修复：JS 模板字面量 escape 层级错误曾使生成脚本 `-replace '/',''` 丢失反斜杠（真实 PowerShell exit 1）；修正为源码 `'\'`/`'\\'` → 脚本 `'\'`/`'\'`，`$env:LOCALAPPDATA\Programs` 同步修复。
- 契约：`tests/installer-packager.contract.test.ts` 真实 PowerShell 安装 exit 0 + 篡改 → `INSTALLER_SHA256_MISMATCH` exit 1；`w4-installer-lifecycle` 12/12；`p0-installer-path-security` 20/20。
- W1-08 UoW 补全（`28beefa`）：`activePolicySnapshotId()`（authorize 上下文以仓储为唯一可信源）+ `release()` 退款归零即清键（不留 `{"externalWrites":0}` 预算残渣）。
- 全量：227 文件 / 1796 通过 / 10 跳过 / 0 失败；known-failures 31/31；typecheck×2 + check:test-discovery 干净。
- 剩余：Wave 5（Market 信任根 + HAR 预存储脱敏）、Wave 6（evidence 索引 / Gate E blocked 保持 / Gate H/I / release:finalize）；agent 主路径 executeTool 切生产 pipeline（遗留接线）。

## Priority 1 完成（agent 主路径接入生产 pipeline + KF-010/023/024 修复）— 2026-08-15

- RED 先行（`a02bac5`）：3 个回归测试锁定缺陷（manual 默认审批旁路 / goal [GOAL_DONE] 无验证成功 / 文本「完成了」假成功）——修复前 3 红实证。
- 最小修复（`17fc675`）：
  - `src/kernel/completionClaim.ts`：确定性完成声明判定（保守模式「完成了/完成/done/[GOAL_DONE]」；「读完了」等叙事不误伤）。
  - `agent.ts`：默认 `onApproval` fail-closed（`?? (() => false)`）；`lastToolOutcome` 确定性结局 + `runState.verifiedEffects` 跨 goal 轮次累计；`ok` 绝不从文本长度推导——完成声明且零验证副作用 → `AgentResult.status='incomplete'`（CLI exit 3 走共享 completionTransport）；`agent.end`/sessionEnd/stop 事件同源。
  - KF-010/023/024 原子迁移：case 删除 + registry 改 `resolved-with-green-regression`（validator 形状锁定）+ 3 个绿色回归；1 个内核测试按诚实语义更新（agent.goal 事件测试零副作用声明 → incomplete）。
- pipeline 接线（`ff495dd`，分层复用）：
  - `src/application/tools/agentToolSurface.ts`：24 个 danger/写类工具映射 `agent:*` 描述符（effect kind 九维全覆盖）；executor 包装 legacy `tool.run`（toolCtx 经串行槽绑定）；postcondition 真实再探（fs_write/fs_edit 存在性）；`AgentApprovalBridge`（WeakMap<args, true>——legacy 前置链放行后由 runner 标记，CLI approver 读桥，不二次弹窗）。
  - `toolExecutionWiring.ts`：`registerAgentTools` 晚绑定注册（execute/verify/resource 端口调用时分派 agent:* 前缀）。
  - `defaultToolPolicy.ts`：补 memory.write/config.write/extension.manage/ui.external 四规则（PDP 无规则即 deny——不补则 agent 工具全被拒）。
  - `agent.ts` 接缝：runner 分支替换 `tool.run`（失败以「工具执行失败（code）」回填保住 5 连败终止语义）；CLI 组合根装配 surface + runner + 审批桥；MCP 热重载同步换表。
  - 诚实边界：只读工具维持 legacy（shadow）；直调 pipeline 无 runner 绑定 → `AGENT_TOOL_CONTEXT_UNBOUND` fail-closed；agent 主路径现在真实消耗预算（externalWrites/networkRequests/processSpawns），超限 fail-closed。
- 契约：`tests/wave3/w3-agent-pipeline-wiring.test.ts` 9/9（全链 grant/journal/evidence、桥语义、超预算、postcondition、agent 级 goal/chat 集成）。
- 全量：**231 文件 / 1809 通过 / 10 跳过 / 0 失败**；known-failures 31/31（27 open 稳定复现 + 3 migrated 绿回归 + 1 原有）；typecheck×2/build/discovery 干净；dist smoke（--version / 确定性计算）通过。
- 剩余：forge KF-016/017 修复（下轮）；Wave 5（Market 信任根 + HAR 脱敏）；Wave 6（evidence 索引接线/Gate E-H-I/finalizer）。

## Priority 2 完成（forge KF-016/017 原子修复）— 2026-08-15

- RED 先行（4 红实证）：`kf-016-forge-path-normalization.regression.test.ts`（幂等组合 + 父目录约定向后兼容）、`kf-017-forge-placeholder-verification.regression.test.ts`（无证据伪 verified 拒绝 / verify 证据门 + 持久化 / 状态机 installed 须先 verified + 撤销保留）。
- 修复：
  - `src/forge/forge.ts`：`componentDir(outDir, name)`——basename===name 时直接落位（消除 /forge 命令实际触发的双拼缺陷），父目录约定向后兼容；forgeMcpServer/forgeSkillDir 共用。
  - `src/forge/registry.ts`：状态机——`setStatus(id,'verified')` 一律忽略（verified 唯一通道是 `verify(id, evidence)` 非空证据门，证据落库 `verification` 字段）；`installed` 须先 `verified`（不跳过检疫）；→quarantine 撤销任意态允许。
- `tests/forge.test.ts` 锁定旧缺陷语义的断言更新为诚实状态机流。
- 全量：**233 文件 / 1814 通过 / 10 跳过 / 0 失败**；known-failures 31/31（18 open oracle + 12 migrated 绿回归）；typecheck×2/build/discovery 干净。
- KF 账本现状：30 条中 12 条 resolved-with-green-regression，18 条 open（环境/legacy 路径缺陷稳定复现）。
- 剩余：Wave 5（Market 信任根 + HAR 预存储脱敏）、Wave 6（evidence 索引接线 / Gate E-H-I / release:finalize）。

## W5-01 Market 信任加固完成 — 2026-08-15

- RED 先行（`b7653ff`）：12 用例契约（canonical 封套逐字段篡改/expiry/版本冲突/重启持久化/审计链/根轮换/攻击场景/权限四件套/完整发布流）。
- 实现（`efb458f`）：
  - `marketSigning.ts` 重写：`MarketEnvelope { id, kind, version, publisher, payloadDigest, expiry, scope }` 全字段入签（排序键 canonical JSON）；payload 摘要绑定；过期 → `MARKET_ITEM_EXPIRED`；`signRootAuthorization` 供根轮换。
  - `marketTrustRoot.ts`（新）：文件 pinned 根库（fsync+rename 原子写）；bootstrap 根 generation=1（操作员离线）；轮换 generation 严格递增 + 旧 active 根签名验证；retire/revoke。
  - `marketPolicy.ts`（新）：Bearer 仅存 sha256（明文绝不落盘）+ timingSafeEqual + 按 action 的 scope + nonce 一次性（TTL 集）+ maxBodyBytes。
  - `marketMigrations.ts`/`marketRepository.ts`（新）：schema 5→6（market_items PRIMARY KEY(id,version)/market_keys/market_audit 哈希链/market_nonces）；publish 事务（版本冲突 + nonce + 审计链任一失败整体回滚）；verifyAuditChain 全链重算。
  - `marketAuthority.ts`：SQLite 持久化（重启不丢）；bootstrap/授权轮换/退休/吊销；同 id/version → `MARKET_ITEM_VERSION_CONFLICT`。
  - `marketServer.ts`：三变更端点前置 policy（401/403/409/413 分层）；审计 journal 落库。
  - `marketClient.ts`：只信本地 pinned 根——绝不从 item server 取公钥（攻击者同时替换 server key+item → 客户端 `MARKET_SIGNATURE_INVALID` 实证）。
  - 契约更新：market-distribution 重写（5 用例含攻击场景）、forge-compliance 封套段、db-migrations/kf-030 对齐 schema 6。
- 全量：**234 文件 / 1826 通过 / 10 跳过 / 0 失败**；known-failures 31/31；typecheck×2/build/discovery 干净；dist smoke 通过。
- 诚实边界：Market 仍无生产消费入口（纯库 + 真实 HTTP 契约测试）；/market 命令接线留 Wave 6；W5-02 HAR 脱敏/配额/留存未开始。
