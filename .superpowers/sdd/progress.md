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
