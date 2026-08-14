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


## Wave 3 Memory status — 2026-08-14 (authority layer done, wiring blocked on a product decision)

- Delivered: `memoryGatewayMethods.ts` — memory.append/update/delete/search as Gateway methods with scope from the trusted `request.sessionId` (committed `3bd9afc`, full suite 207 files / 1691 passed / 0 failed).
- Remaining wiring is NOT a mechanical step: legacy memory is the message history (messages + archival_vec + FTS), while the modern authority (`openMemoryRepository` + `memory_records` schema) is an explicit-memory model. Switching `/memory` / `memory_search` / agent recall to the modern authority requires a data-model decision (how message history becomes explicit memories) — no silent empty-result switching, no fake migration. This is the next atomic step, deliberately not started here.


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
