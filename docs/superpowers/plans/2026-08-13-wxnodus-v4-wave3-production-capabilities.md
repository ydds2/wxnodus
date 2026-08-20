# WxNodus V4 Wave 3 生产能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 日期：2026-08-13  
> 前置：Wave 2 的 Gate A/B/C/D/F/G immutable evidence 已通过并可由 `priorRunIds` 引用；这些历史 receipt 不能替代当前候选 revision 的 C-W3 migration/recovery drill  
> Channel：canary  
> Wave 3 owned Gate slices：A（本 Wave 编译/类型）、B（本 Wave suites/discovery）、C（当前候选 artifact/commit 绑定的 migration/recovery drill）、D（Voice/Computer/Build/PTY headless）、E（Windows 11 production-real + Windows 10 legacy-compatibility 真实 receipts）、F（本 Wave policy/security）、G（本 Wave evidence/completion）  
> 非本 Wave owned：H/I 严格 N/A，Wave 3 runner 不执行也不宣称通过

**Goal:** 在可信内核、统一 Application services 和 CapabilityRegistry 之上交付可取消 Voice Runtime、全窗口 Computer Use 闭环、唯一 Concept Compiler/BuildService、PTY、可篡改检测且 attachment-closed 的 Verify/Evidence/Completion 全链，以及真正与业务分离的 TUI。

**Architecture:** Voice、Computer、Build、PTY、Quality 各自拥有 Domain contract、Application service 与 Infrastructure adapter。TUI 只包含 pure reducer/projector/selectors 和 view-local state；CLI、Wire、HTTP、既有 W2 MCP adapter、TUI 对其已声明 surface 全部调用同一 Application service。真实 Windows acceptance 由 OS-keyed immutable receipts 聚合：Windows 11 24H2 是 production-real Gate E cell，Windows 10 22H2 是 required legacy-compatibility cell，二者不能互相替代；物理能力或 required receipt 不足均判为 Gate E `blocked`。

**Tech Stack:** Node.js 22+（ESM/NodeNext）、TypeScript strict、ffmpeg、whisper.cpp、Windows SAPI、Playwright Core、PowerShell UIA、robotjs、node-screenshots、node-pty、Node.js ProcessSupervisor、继承自 W2 的 MCP current protocol `2026-07-28` 与 exact SDK locks、SQLite/File Evidence Store、Vitest、PowerShell 真实 Windows acceptance。

## Global Constraints

- Driver 只返回结构化 observation/action/result，禁止返回面向用户的成功文案。
- Voice、Computer、Build、PTY 的每个长操作接受 `AbortSignal`，并由 `ProcessSupervisor` 确认 Windows process tree 退出。
- Computer 每个动作执行 `Observe → Resolve → PDP → Act → Re-observe → Verify → Evidence`。
- UIA/坐标输入的**每个动作**（不只初始化）都必须重新证明：当前是 interactive 且 unlocked 的用户 session、input desktop 精确为 `Default`、目标进程 integrity level 不高于 runner 且目标不是 protected UI；Secure Desktop、UAC consent/credential UI、login、lockscreen 或受保护系统 UI 一律 fail-closed，禁止 UIA 后再走坐标 fallback。
- Evidence 使用 canonical manifest 和完整 SHA-256，并绑定 artifact、environment、capability、policy、verifier、correlation、lineage；每个 record/attachment ID 在 run 内唯一，record 的 stdout/stderr/其他 attachment 引用必须闭包到 manifest 中同 ID 的实际 bytes、实际 byte length 与完整 64-hex SHA-256。
- `CompletionGate` 只消费 integrity-verified 且 `closureStatus: 'closed'` 的 evidence；dangling attachment、重复 ID、path escape、size/hash mismatch 或未闭包 record 都只能令完成判定 `blocked`/`incomplete`，不得进入 required-criterion pass 集合。
- TUI 不能直接持有 DB、Agent、process 或 Infrastructure driver。
- Node.js 与 MCP 术语沿用 roadmap/W2：runtime 为 Node.js 22+ ESM/NodeNext；MCP 是 W2-06 的双向 current protocol `2026-07-28` client + WxNodus MCP Server adapter，不得把 Node frontend 当成新的 MCP 实现、不得另造 protocol/version 或绕过 Application service。
- 所有控制流只依赖本计划列出的稳定失败码；`message` 只用于展示。
- 每个 Gate runner 固定原子写 `artifacts/release-evidence/latest-run.json`，内容至少为 `{ "runId": string, "wave": 3, "manifestPath": string }`。
- PowerShell 获取当期 run 的唯一方式：

```powershell
$latest = Get-Content artifacts/release-evidence/latest-run.json -Raw | ConvertFrom-Json
npm.cmd run gate:completion -- --run $latest.runId
```

- 本计划所有红测代码块和最小实现代码块均是完整、可粘贴文件内容；执行计划时先粘贴红测并确认指定失败码，再粘贴最小实现。
- 本计划编写阶段不运行实现测试；各命令只供后续执行计划使用。

---

## Task W3-01：扩展 VerifierRegistry、FileEvidenceStore 与全入口失败传播

**Requirements/Subprojects:** R15、R19、R20；S9

**Files**
- Create: `src/domain/quality/verifier.ts`
- Modify: `src/domain/quality/verification.ts`（Wave 1 已创建）
- Modify: `src/domain/quality/evidence.ts`（Wave 1 已创建）
- Modify: `src/domain/quality/completionGate.ts`（Wave 1 已创建）
- Modify: `src/application/quality/verifierRegistry.ts`（Wave 1 已创建，禁止误列为 Create）
- Create: `src/application/quality/evidenceService.ts`
- Modify: `src/infrastructure/quality/fileEvidenceStore.ts`（Wave 1 已创建，禁止误列为 Create）
- Modify: `src/build/evidence.ts`
- Modify: `src/build/gate.ts`
- Modify: `src/app/CommandBus.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/serve.ts`
- Create: `tests/unit/quality/verifierRegistry.contract.test.ts`
- Create: `tests/unit/quality/completionGate.closed-evidence.test.ts`
- Create: `tests/integration/evidenceAuthorityConflict.test.ts`
- Create: `tests/integration/failurePropagation.test.ts`

**Interfaces and authoritative contracts**

```ts
export const BUILTIN_VERIFIER_IDS = [
  'command.exit-code',
  'typescript.typecheck',
  'npm.build',
  'npm.test',
  'file.exists',
  'file.content',
  'workspace.diff',
  'json.schema',
  'process.readiness',
  'http.contract',
  'database.query',
  'browser.dom',
  'browser.url',
  'uia.property',
  'screenshot.ocr',
  'human.approval',
] as const;

export type BuiltinVerifierId = typeof BUILTIN_VERIFIER_IDS[number];
export type VerificationStatus = 'passed' | 'failed' | 'inconclusive' | 'cancelled';

export interface EvidenceAttachmentRef {
  attachmentId: string;
  path: `attachments/${string}`;
  sha256: string; // lowercase, full 64-hex SHA-256 of the actual bytes
  bytes: number; // actual Buffer.byteLength, never caller-reported metadata
}

export interface EvidenceRecord {
  id: string;
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  objective: { id: string; description: string };
  criteria: Array<{
    id: string;
    description: string;
    required: boolean;
    expected: unknown;
    observed: unknown;
    status: VerificationStatus;
    failureCode?: string;
  }>;
  command: {
    executable: string;
    argv: string[];
    cwd: string;
    normalized: string;
    timeoutMs: number;
  };
  exit: { code: number | null; signal: string | null; timedOut: boolean; aborted: boolean };
  artifact: { id: string; sha256: string };
  stdout: EvidenceAttachmentRef;
  stderr: EvidenceAttachmentRef;
  attachments: EvidenceAttachmentRef[];
  closure: { status: 'closed'; attachmentIds: string[] };
  environment: { snapshotId: string; sha256: string; platform: NodeJS.Platform; arch: string };
  capability: { snapshotId: string; sha256: string; requiredIds: string[] };
  policy: { snapshotId: string; sha256: string; decisionId: string };
  verifier: { id: BuiltinVerifierId; version: string; inputSha256: string; status: VerificationStatus };
  correlation: { correlationId: string; causationId?: string; traceId: string };
  lineage: { sessionId: string; parentRunId?: string; taskId?: string; artifactIds: string[]; priorEvidenceIds: string[] };
  authority: {
    source: 'process-supervisor' | 'filesystem-reader' | 'workspace-reader' | 'http-client' |
      'database-client' | 'browser-driver' | 'uia-driver' | 'ocr-engine' | 'approval-repository';
    sourceRecordId: string;
    sourceStatus: VerificationStatus;
    trusted: true;
  };
}
```

**Stable failure codes**

- `VERIFIER_NOT_FOUND`
- `VERIFIER_DUPLICATE_ID`
- `VERIFIER_INPUT_INVALID`
- `VERIFIER_ASSERTION_FAILED`
- `VERIFIER_TIMEOUT`
- `VERIFIER_CRASH`
- `VERIFIER_CANCELLED`
- `VERIFIER_AUDIT_SOURCE_MISMATCH`
- `EVIDENCE_WRITE_FAILED`
- `EVIDENCE_INTEGRITY_FAILED`
- `EVIDENCE_AUDIT_SOURCE_CONFLICT`
- `EVIDENCE_ATTACHMENT_MISSING`
- `EVIDENCE_ATTACHMENT_METADATA_MISMATCH`
- `EVIDENCE_PATH_OUTSIDE_RUN`
- `EVIDENCE_DUPLICATE_ID`
- `EVIDENCE_RECORD_NOT_CLOSED`
- `COMPLETION_EVIDENCE_NOT_CLOSED`
- `COMPLETION_REQUIRED_CRITERION_MISSING`
- `COMPLETION_REQUIRED_CRITERION_FAILED`
- `FRONTEND_FAILURE_PROPAGATION_MISMATCH`

- [ ] **Step 1: paste the complete red contract test**

`tests/unit/quality/verifierRegistry.contract.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_VERIFIER_IDS,
  BUILTIN_VERIFIER_DESCRIPTORS,
  type BuiltinVerifierId,
  type ProbeOutcome,
  type VerificationRequest,
} from '../../../src/domain/quality/verifier.js';
import { createBuiltinVerifierRegistry } from '../../../src/application/quality/verifierRegistry.js';
import { EvidenceService } from '../../../src/application/quality/evidenceService.js';

const requestFor = (verifierId: BuiltinVerifierId, attempt: string): VerificationRequest => ({
  id: `verification-${verifierId}-${attempt}`,
  runId: 'run-w3-01',
  objective: { id: 'objective-1', description: 'close the verifier contract' },
  criterion: {
    id: `criterion-${verifierId}`,
    description: `verify ${verifierId}`,
    required: true,
    expected: true,
  },
  verifierId,
  input: Object.fromEntries(BUILTIN_VERIFIER_DESCRIPTORS[verifierId].requiredInputKeys.map(key => [key, true])),
  timeoutMs: 250,
  context: {
    sessionId: 'session-1',
    correlationId: `correlation-${verifierId}-${attempt}`,
    traceId: 'trace-1',
    environmentSnapshotId: 'env-1',
    environmentSha256: 'a'.repeat(64),
    capabilitySnapshotId: 'cap-1',
    capabilitySha256: 'b'.repeat(64),
    policySnapshotId: 'policy-1',
    policySha256: 'c'.repeat(64),
    policyDecisionId: 'decision-1',
    artifactId: 'artifact-1',
    artifactSha256: 'f'.repeat(64),
  },
  execution: {
    command: {
      executable: 'builtin-verifier',
      argv: [verifierId],
      cwd: 'C:/workspace',
      normalized: `builtin-verifier ${verifierId}`,
      timeoutMs: 250,
    },
    exit: { code: 0, signal: null, timedOut: false, aborted: false },
    stdout: { attachmentId: `stdout-${verifierId}`, bytes: Buffer.from(`stdout:${verifierId}`, 'utf8') },
    stderr: { attachmentId: `stderr-${verifierId}`, bytes: Buffer.alloc(0) },
  },
});

const makeStore = () => {
  const records: unknown[] = [];
  const attachments = new Map<string, Buffer>();
  return {
    records,
    attachments,
    async appendClosed(record: unknown, pending: Array<{ attachmentId: string; bytes: Buffer }>) {
      records.push(record);
      for (const item of pending) attachments.set(item.attachmentId, item.bytes);
      return { ok: true as const, value: { evidenceId: (record as { id: string }).id } };
    },
  };
};

describe.each(BUILTIN_VERIFIER_IDS)('%s verifier closure', verifierId => {
  it('has a stable descriptor and closes pass, fail, and crash through an EvidenceRecord', async () => {
    const descriptor = BUILTIN_VERIFIER_DESCRIPTORS[verifierId];
    expect(descriptor).toMatchObject({ id: verifierId, version: '1.0.0' });
    expect(descriptor.requiredInputKeys.length).toBeGreaterThan(0);
    expect(descriptor.requiredCapabilities.length).toBeGreaterThan(0);
    const outcomes: ProbeOutcome[] = [
      { kind: 'pass', observed: true, authoritySource: descriptor.authoritySource, sourceRecordId: 'source-pass' },
      { kind: 'fail', observed: false, authoritySource: descriptor.authoritySource, sourceRecordId: 'source-fail' },
      { kind: 'crash', error: new Error('probe exploded'), authoritySource: descriptor.authoritySource, sourceRecordId: 'source-crash' },
    ];
    const probe = { run: async () => outcomes.shift()! };
    const registry = createBuiltinVerifierRegistry(probe);
    const store = makeStore();
    const evidence = new EvidenceService(store);

    const passRequest = requestFor(verifierId, 'pass');
    const passed = await registry.verify(passRequest, AbortSignal.timeout(1_000));
    expect(passed.ok && passed.value.status).toBe('passed');
    const passClose = passed.ok ? await evidence.close(passRequest, passed.value) : passed;
    expect(passClose.ok).toBe(true);

    const failRequest = requestFor(verifierId, 'fail');
    const failed = await registry.verify(failRequest, AbortSignal.timeout(1_000));
    expect(failed.ok && failed.value.status).toBe('failed');
    expect(failed.ok && failed.value.failureCode).toBe('VERIFIER_ASSERTION_FAILED');
    const failClose = failed.ok ? await evidence.close(failRequest, failed.value) : failed;
    expect(failClose.ok).toBe(true);

    const crashRequest = requestFor(verifierId, 'crash');
    const crashed = await registry.verify(crashRequest, AbortSignal.timeout(1_000));
    expect(crashed.ok && crashed.value.status).toBe('inconclusive');
    expect(crashed.ok && crashed.value.failureCode).toBe('VERIFIER_CRASH');
    const crashClose = crashed.ok ? await evidence.close(crashRequest, crashed.value) : crashed;
    expect(crashClose.ok).toBe(true);

    expect(store.records).toHaveLength(3);
    for (const value of store.records) {
      const record = value as Record<string, unknown>;
      expect(record).toMatchObject({
        schemaVersion: 1,
        runId: 'run-w3-01',
        objective: { id: 'objective-1' },
        environment: { snapshotId: 'env-1' },
        capability: { snapshotId: 'cap-1' },
        policy: { snapshotId: 'policy-1' },
        correlation: { traceId: 'trace-1' },
        lineage: { sessionId: 'session-1' },
      });
      expect((record.verifier as { id: string }).id).toBe(verifierId);
      expect(Array.isArray(record.criteria)).toBe(true);
      expect(Object.hasOwn(record, 'command')).toBe(true);
      expect(Object.hasOwn(record, 'exit')).toBe(true);
      expect(Object.hasOwn(record, 'stdout')).toBe(true);
      expect(Object.hasOwn(record, 'stderr')).toBe(true);
      const stdout = record.stdout as { attachmentId: string; path: string; sha256: string; bytes: number };
      const stderr = record.stderr as { attachmentId: string; path: string; sha256: string; bytes: number };
      expect(stdout).toMatchObject({ path: `attachments/${stdout.attachmentId}` });
      expect(stderr).toMatchObject({ path: `attachments/${stderr.attachmentId}` });
      expect(stdout.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(stderr.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.closure).toMatchObject({ status: 'closed' });
      expect(new Set((record.closure as { attachmentIds: string[] }).attachmentIds).size).toBe(2);
    }
    const ids = store.records.map(value => (value as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

it('rejects a verifier result that conflicts with the authoritative audit source', async () => {
  const store = makeStore();
  const evidence = new EvidenceService(store);
  const request = requestFor('command.exit-code', 'authority-conflict');
  const result = await evidence.close(request, {
    verificationId: request.id,
    status: 'passed',
    observed: { exitCode: 0 },
    evidenceIds: [],
    authority: {
      source: 'process-supervisor',
      sourceRecordId: 'process-9',
      sourceStatus: 'failed',
      trusted: true,
    },
  });

  expect(result).toMatchObject({
    ok: false,
    error: { code: 'EVIDENCE_AUDIT_SOURCE_CONFLICT' },
  });
  expect(store.records).toHaveLength(0);
});
```

- [ ] **Step 2: run the red test and capture the exact failure**

```powershell
npm.cmd exec -- vitest run tests/unit/quality/verifierRegistry.contract.test.ts
```

Expected: FAIL because the built-in ID registry and evidence closure do not exist. After the imports exist but before the contract is fixed, authority disagreement must fail with `EVIDENCE_AUDIT_SOURCE_CONFLICT`, never produce `passed` evidence.

- [ ] **Step 3: paste the complete minimal domain contract**

`src/domain/quality/verifier.ts`

```ts
import type { GatewayError } from '../../protocol/errors.js';
import type { OperationResult } from '../../protocol/results.js';

export const BUILTIN_VERIFIER_IDS = [
  'command.exit-code', 'typescript.typecheck', 'npm.build', 'npm.test',
  'file.exists', 'file.content', 'workspace.diff', 'json.schema',
  'process.readiness', 'http.contract', 'database.query', 'browser.dom',
  'browser.url', 'uia.property', 'screenshot.ocr', 'human.approval',
] as const;

export type BuiltinVerifierId = typeof BUILTIN_VERIFIER_IDS[number];
export type VerificationStatus = 'passed' | 'failed' | 'inconclusive' | 'cancelled';
export type AuthoritySource = 'process-supervisor' | 'filesystem-reader' | 'workspace-reader' |
  'http-client' | 'database-client' | 'browser-driver' | 'uia-driver' | 'ocr-engine' |
  'approval-repository';

export interface VerifierDescriptor {
  id: BuiltinVerifierId;
  version: '1.0.0';
  requiredInputKeys: readonly string[];
  requiredCapabilities: readonly string[];
  authoritySource: AuthoritySource;
}

export const BUILTIN_VERIFIER_DESCRIPTORS: Record<BuiltinVerifierId, VerifierDescriptor> = {
  'command.exit-code': { id: 'command.exit-code', version: '1.0.0', requiredInputKeys: ['command', 'expectedExitCode'], requiredCapabilities: ['process.execute'], authoritySource: 'process-supervisor' },
  'typescript.typecheck': { id: 'typescript.typecheck', version: '1.0.0', requiredInputKeys: ['projectDir'], requiredCapabilities: ['process.execute', 'typescript'], authoritySource: 'process-supervisor' },
  'npm.build': { id: 'npm.build', version: '1.0.0', requiredInputKeys: ['projectDir'], requiredCapabilities: ['process.execute', 'npm'], authoritySource: 'process-supervisor' },
  'npm.test': { id: 'npm.test', version: '1.0.0', requiredInputKeys: ['projectDir'], requiredCapabilities: ['process.execute', 'npm'], authoritySource: 'process-supervisor' },
  'file.exists': { id: 'file.exists', version: '1.0.0', requiredInputKeys: ['path'], requiredCapabilities: ['filesystem.read'], authoritySource: 'filesystem-reader' },
  'file.content': { id: 'file.content', version: '1.0.0', requiredInputKeys: ['path', 'matcher'], requiredCapabilities: ['filesystem.read'], authoritySource: 'filesystem-reader' },
  'workspace.diff': { id: 'workspace.diff', version: '1.0.0', requiredInputKeys: ['workspace', 'expected'], requiredCapabilities: ['workspace.read'], authoritySource: 'workspace-reader' },
  'json.schema': { id: 'json.schema', version: '1.0.0', requiredInputKeys: ['value', 'schema'], requiredCapabilities: ['json.schema'], authoritySource: 'filesystem-reader' },
  'process.readiness': { id: 'process.readiness', version: '1.0.0', requiredInputKeys: ['processId', 'probe'], requiredCapabilities: ['process.inspect'], authoritySource: 'process-supervisor' },
  'http.contract': { id: 'http.contract', version: '1.0.0', requiredInputKeys: ['request', 'expected'], requiredCapabilities: ['network.http'], authoritySource: 'http-client' },
  'database.query': { id: 'database.query', version: '1.0.0', requiredInputKeys: ['connectionRef', 'query', 'expected'], requiredCapabilities: ['database.query'], authoritySource: 'database-client' },
  'browser.dom': { id: 'browser.dom', version: '1.0.0', requiredInputKeys: ['sessionId', 'selector', 'expected'], requiredCapabilities: ['browser.dom'], authoritySource: 'browser-driver' },
  'browser.url': { id: 'browser.url', version: '1.0.0', requiredInputKeys: ['sessionId', 'expectedUrl'], requiredCapabilities: ['browser.url'], authoritySource: 'browser-driver' },
  'uia.property': { id: 'uia.property', version: '1.0.0', requiredInputKeys: ['runtimeId', 'property', 'expected'], requiredCapabilities: ['windows.uia'], authoritySource: 'uia-driver' },
  'screenshot.ocr': { id: 'screenshot.ocr', version: '1.0.0', requiredInputKeys: ['imageRef', 'expectedText'], requiredCapabilities: ['screenshot.capture', 'ocr'], authoritySource: 'ocr-engine' },
  'human.approval': { id: 'human.approval', version: '1.0.0', requiredInputKeys: ['grantId', 'requestHash'], requiredCapabilities: ['approval.repository'], authoritySource: 'approval-repository' },
};

export interface VerificationRequest {
  id: string;
  runId: string;
  objective: { id: string; description: string };
  criterion: { id: string; description: string; required: boolean; expected: unknown };
  verifierId: BuiltinVerifierId;
  input: unknown;
  timeoutMs: number;
  context: {
    sessionId: string;
    correlationId: string;
    traceId: string;
    environmentSnapshotId: string;
    environmentSha256: string;
    capabilitySnapshotId: string;
    capabilitySha256: string;
    policySnapshotId: string;
    policySha256: string;
    policyDecisionId: string;
    artifactId: string;
    artifactSha256: string;
  };
  execution: {
    command: { executable: string; argv: string[]; cwd: string; normalized: string; timeoutMs: number };
    exit: { code: number | null; signal: string | null; timedOut: boolean; aborted: boolean };
    stdout: { attachmentId: string; bytes: Buffer };
    stderr: { attachmentId: string; bytes: Buffer };
    attachments?: Array<{ attachmentId: string; bytes: Buffer }>;
  };
}

export type ProbeOutcome =
  | { kind: 'pass'; observed: unknown; authoritySource: AuthoritySource; sourceRecordId: string }
  | { kind: 'fail'; observed: unknown; authoritySource: AuthoritySource; sourceRecordId: string }
  | { kind: 'crash'; error: Error; authoritySource: AuthoritySource; sourceRecordId: string };

export interface BuiltinProbePort {
  run(id: BuiltinVerifierId, input: unknown, signal: AbortSignal): Promise<ProbeOutcome>;
}

export interface VerificationResult {
  verificationId: string;
  status: VerificationStatus;
  observed: unknown;
  evidenceIds: string[];
  failureCode?: 'VERIFIER_ASSERTION_FAILED' | 'VERIFIER_TIMEOUT' | 'VERIFIER_CRASH' | 'VERIFIER_CANCELLED' | 'VERIFIER_AUDIT_SOURCE_MISMATCH';
  error?: GatewayError;
  authority: { source: AuthoritySource; sourceRecordId: string; sourceStatus: VerificationStatus; trusted: true };
}

export interface VerifierRegistry {
  verify(request: VerificationRequest, signal: AbortSignal): Promise<OperationResult<VerificationResult>>;
}
```

`src/application/quality/verifierRegistry.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';
import {
  BUILTIN_VERIFIER_DESCRIPTORS,
  type BuiltinProbePort,
  type VerificationRequest,
  type VerificationResult,
  type VerifierRegistry,
} from '../../domain/quality/verifier.js';

const failure = (code: string, message: string): OperationResult<never> => ({
  ok: false,
  error: { code, message, messageKey: code, retryable: false },
});

export function createBuiltinVerifierRegistry(probe: BuiltinProbePort): VerifierRegistry {
  return {
    async verify(request: VerificationRequest, signal: AbortSignal): Promise<OperationResult<VerificationResult>> {
      const descriptor = BUILTIN_VERIFIER_DESCRIPTORS[request.verifierId];
      if (!descriptor) return failure('VERIFIER_NOT_FOUND', request.verifierId);
      if (!request.input || typeof request.input !== 'object' ||
          descriptor.requiredInputKeys.some(key => !Object.hasOwn(request.input as object, key))) {
        return failure('VERIFIER_INPUT_INVALID', request.verifierId);
      }
      if (signal.aborted) {
        return { ok: true, value: {
          verificationId: request.id,
          status: 'cancelled',
          observed: null,
          evidenceIds: [],
          failureCode: 'VERIFIER_CANCELLED',
          authority: { source: 'process-supervisor', sourceRecordId: request.id, sourceStatus: 'cancelled', trusted: true },
        } };
      }

      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('VERIFIER_TIMEOUT')), request.timeoutMs);
        });
        const outcome = await Promise.race([probe.run(request.verifierId, request.input, signal), timeout]);
        if (outcome.authoritySource !== descriptor.authoritySource) {
          return { ok: true, value: {
            verificationId: request.id,
            status: 'inconclusive',
            observed: null,
            evidenceIds: [],
            failureCode: 'VERIFIER_AUDIT_SOURCE_MISMATCH',
            authority: { source: descriptor.authoritySource, sourceRecordId: outcome.sourceRecordId, sourceStatus: 'inconclusive', trusted: true },
          } };
        }
        if (outcome.kind === 'pass') {
          return { ok: true, value: {
            verificationId: request.id,
            status: 'passed',
            observed: outcome.observed,
            evidenceIds: [],
            authority: { source: outcome.authoritySource, sourceRecordId: outcome.sourceRecordId, sourceStatus: 'passed', trusted: true },
          } };
        }
        if (outcome.kind === 'fail') {
          return { ok: true, value: {
            verificationId: request.id,
            status: 'failed',
            observed: outcome.observed,
            evidenceIds: [],
            failureCode: 'VERIFIER_ASSERTION_FAILED',
            authority: { source: outcome.authoritySource, sourceRecordId: outcome.sourceRecordId, sourceStatus: 'failed', trusted: true },
          } };
        }
        return { ok: true, value: {
          verificationId: request.id,
          status: 'inconclusive',
          observed: { error: outcome.error.message },
          evidenceIds: [],
          failureCode: 'VERIFIER_CRASH',
          authority: { source: outcome.authoritySource, sourceRecordId: outcome.sourceRecordId, sourceStatus: 'inconclusive', trusted: true },
        } };
      } catch (error) {
        const timedOut = error instanceof Error && error.message === 'VERIFIER_TIMEOUT';
        return { ok: true, value: {
          verificationId: request.id,
          status: 'inconclusive',
          observed: null,
          evidenceIds: [],
          failureCode: timedOut ? 'VERIFIER_TIMEOUT' : 'VERIFIER_CRASH',
          authority: { source: 'process-supervisor', sourceRecordId: request.id, sourceStatus: 'inconclusive', trusted: true },
        } };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
```

`src/application/quality/evidenceService.ts`

```ts
import { createHash, randomUUID } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import type { EvidenceAttachmentRef, EvidenceRecord } from '../../domain/quality/evidence.js';
import { BUILTIN_VERIFIER_DESCRIPTORS } from '../../domain/quality/verifier.js';
import type { VerificationRequest, VerificationResult } from '../../domain/quality/verifier.js';

interface PendingAttachment { attachmentId: string; bytes: Buffer }
export interface EvidenceStorePort {
  appendClosed(record: EvidenceRecord, attachments: readonly PendingAttachment[]): Promise<OperationResult<{ evidenceId: string }>>;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const sha256 = (value: unknown): string => digest(canonical(value));
const failed = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

export class EvidenceService {
  constructor(private readonly store: EvidenceStorePort) {}

  async close(request: VerificationRequest, result: VerificationResult): Promise<OperationResult<{ evidenceId: string }>> {
    if (result.status !== result.authority.sourceStatus) return failed('EVIDENCE_AUDIT_SOURCE_CONFLICT');
    const pending = [request.execution.stdout, request.execution.stderr, ...(request.execution.attachments ?? [])];
    if (new Set(pending.map(value => value.attachmentId)).size !== pending.length) return failed('EVIDENCE_DUPLICATE_ID');
    if (pending.some(value => !/^[A-Za-z0-9._-]+$/.test(value.attachmentId))) return failed('EVIDENCE_PATH_OUTSIDE_RUN');
    const refs: EvidenceAttachmentRef[] = pending.map(value => ({
      attachmentId: value.attachmentId,
      path: `attachments/${value.attachmentId}`,
      sha256: digest(value.bytes),
      bytes: value.bytes.byteLength,
    }));
    const recordId = randomUUID();
    if (pending.some(value => value.attachmentId === recordId)) return failed('EVIDENCE_DUPLICATE_ID');
    const byId = new Map(refs.map(ref => [ref.attachmentId, ref]));
    const stdout = byId.get(request.execution.stdout.attachmentId);
    const stderr = byId.get(request.execution.stderr.attachmentId);
    if (!stdout || !stderr) return failed('EVIDENCE_ATTACHMENT_MISSING');

    const record: EvidenceRecord = {
      id: recordId,
      schemaVersion: 1,
      runId: request.runId,
      createdAt: new Date().toISOString(),
      objective: request.objective,
      criteria: [{
        id: request.criterion.id,
        description: request.criterion.description,
        required: request.criterion.required,
        expected: request.criterion.expected,
        observed: result.observed,
        status: result.status,
        failureCode: result.failureCode,
      }],
      command: request.execution.command,
      exit: request.execution.exit,
      artifact: { id: request.context.artifactId, sha256: request.context.artifactSha256 },
      stdout,
      stderr,
      attachments: refs,
      closure: { status: 'closed', attachmentIds: refs.map(ref => ref.attachmentId).sort() },
      environment: {
        snapshotId: request.context.environmentSnapshotId,
        sha256: request.context.environmentSha256,
        platform: process.platform,
        arch: process.arch,
      },
      capability: {
        snapshotId: request.context.capabilitySnapshotId,
        sha256: request.context.capabilitySha256,
        requiredIds: [...BUILTIN_VERIFIER_DESCRIPTORS[request.verifierId].requiredCapabilities],
      },
      policy: {
        snapshotId: request.context.policySnapshotId,
        sha256: request.context.policySha256,
        decisionId: request.context.policyDecisionId,
      },
      verifier: { id: request.verifierId, version: '1.0.0', inputSha256: sha256(request.input), status: result.status },
      correlation: { correlationId: request.context.correlationId, traceId: request.context.traceId },
      lineage: {
        sessionId: request.context.sessionId,
        artifactIds: [request.context.artifactId],
        priorEvidenceIds: result.evidenceIds,
      },
      authority: result.authority,
    };
    return this.store.appendClosed(record, pending);
  }
}
```

`src/infrastructure/quality/fileEvidenceStore.ts`

```ts
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { EvidenceRecord } from '../../domain/quality/evidence.js';
import type { OperationResult } from '../../protocol/results.js';

interface ManifestEntry { path: string; attachmentId?: string; bytes: number; sha256: string }
interface ArtifactManifest { algorithm: 'sha256'; rootDigest: string; entries: ManifestEntry[] }
interface EvidenceBundle { runId: string; records: EvidenceRecord[]; attachments: Record<string, Buffer> }

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const canonicalPath = (value: string): string => value.replace(/\\/g, '/');
const failed = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

async function durableWrite(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

export class FileEvidenceStore {
  constructor(private readonly root: string) {}

  async appendClosed(record: EvidenceRecord, pending: readonly { attachmentId: string; bytes: Buffer }[]): Promise<OperationResult<{ evidenceId: string }>> {
    const current = await this.readBundle(record.runId);
    if (!current.ok) return current;
    if (current.value.records.some(value => value.id === record.id) ||
        pending.some(value => Object.hasOwn(current.value.attachments, value.attachmentId)) ||
        new Set(pending.map(value => value.attachmentId)).size !== pending.length) return failed('EVIDENCE_DUPLICATE_ID');
    const attachments = { ...current.value.attachments };
    for (const value of pending) attachments[value.attachmentId] = Buffer.from(value.bytes);
    const written = await this.appendBundle({
      runId: record.runId,
      records: [...current.value.records, record],
      attachments,
    });
    return written.ok ? { ok: true, value: { evidenceId: record.id } } : written;
  }

  async appendBundle(bundle: EvidenceBundle): Promise<OperationResult<{ evidenceId: string }>> {
    if (!/^[A-Za-z0-9._-]+$/.test(bundle.runId)) return failed('EVIDENCE_WRITE_FAILED');
    if (new Set(bundle.records.map(record => record.id)).size !== bundle.records.length ||
        new Set(Object.keys(bundle.attachments)).size !== Object.keys(bundle.attachments).length) return failed('EVIDENCE_DUPLICATE_ID');
    const finalDir = join(this.root, bundle.runId);
    const tempDir = join(this.root, `.${bundle.runId}.${randomUUID()}.tmp`);
    const backupDir = join(this.root, `.${bundle.runId}.${randomUUID()}.bak`);
    let movedOld = false;
    try {
      await mkdir(tempDir, { recursive: true });
      const entries: ManifestEntry[] = [];
      for (const record of bundle.records) {
        const path = canonicalPath(`records/${record.id}.json`);
        const bytes = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
        await durableWrite(join(tempDir, path), bytes);
        entries.push({ path, bytes: bytes.byteLength, sha256: digest(bytes) });
      }
      for (const [name, bytes] of Object.entries(bundle.attachments)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('invalid attachment name');
        const path = canonicalPath(`attachments/${name}`);
        await durableWrite(join(tempDir, path), bytes);
        entries.push({ path, attachmentId: name, bytes: bytes.byteLength, sha256: digest(bytes) });
      }
      entries.sort((left, right) => left.path.localeCompare(right.path));
      const rootDigest = digest(entries.map(entry => `${entry.path}\0${entry.attachmentId ?? ''}\0${entry.bytes}\0${entry.sha256}`).join('\n'));
      const manifest: ArtifactManifest = { algorithm: 'sha256', rootDigest, entries };
      await durableWrite(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await mkdir(this.root, { recursive: true });
      try { await rename(finalDir, backupDir); movedOld = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(tempDir, finalDir);
      if (movedOld) await rm(backupDir, { recursive: true, force: true });
      return { ok: true, value: { evidenceId: bundle.records.at(-1)?.id ?? `bundle-${bundle.runId}` } };
    } catch {
      await rm(tempDir, { recursive: true, force: true });
      if (movedOld) {
        await rm(finalDir, { recursive: true, force: true });
        try { await rename(backupDir, finalDir); } catch { return failed('EVIDENCE_WRITE_FAILED'); }
      }
      return failed('EVIDENCE_WRITE_FAILED');
    }
  }

  async verifyIntegrity(runId: string): Promise<OperationResult<ArtifactManifest>> {
    try {
      const runDir = resolve(this.root, runId);
      const manifestPath = resolve(runDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ArtifactManifest;
      if (manifest.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(manifest.rootDigest) ||
          new Set(manifest.entries.map(entry => entry.path)).size !== manifest.entries.length) return failed('EVIDENCE_INTEGRITY_FAILED');
      const actual: ManifestEntry[] = [];
      const attachmentIds = new Set<string>();
      for (const entry of manifest.entries) {
        const path = resolve(runDir, entry.path);
        const relative = canonicalPath(entry.path);
        if (path === runDir || (!path.startsWith(`${runDir}\\`) && !path.startsWith(`${runDir}/`)) ||
            relative.startsWith('/') || relative.split('/').includes('..')) return failed('EVIDENCE_PATH_OUTSIDE_RUN');
        const bytes = await readFile(path);
        const measured: ManifestEntry = {
          path: relative,
          attachmentId: entry.attachmentId,
          bytes: bytes.byteLength,
          sha256: digest(bytes),
        };
        if (measured.bytes !== entry.bytes || measured.sha256 !== entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
          return failed('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
        }
        if (entry.attachmentId) {
          if (attachmentIds.has(entry.attachmentId) || relative !== `attachments/${entry.attachmentId}`) return failed('EVIDENCE_DUPLICATE_ID');
          attachmentIds.add(entry.attachmentId);
        }
        actual.push(measured);
      }
      const listedPaths = new Set(manifest.entries.map(entry => canonicalPath(entry.path)));
      for (const directory of ['records', 'attachments'] as const) {
        try {
          for (const name of await readdir(join(runDir, directory))) {
            if (!listedPaths.has(`${directory}/${name}`)) return failed('EVIDENCE_INTEGRITY_FAILED');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      for (const entry of actual.filter(value => value.path.startsWith('records/'))) {
        const record = JSON.parse(await readFile(resolve(runDir, entry.path), 'utf8')) as EvidenceRecord;
        if (record.closure.status !== 'closed') return failed('EVIDENCE_RECORD_NOT_CLOSED');
        const refs = [record.stdout, record.stderr, ...record.attachments];
        const uniqueRefs = new Map(refs.map(ref => [ref.attachmentId, ref]));
        if (uniqueRefs.size !== record.closure.attachmentIds.length ||
            record.closure.attachmentIds.some(id => !uniqueRefs.has(id))) return failed('EVIDENCE_RECORD_NOT_CLOSED');
        for (const ref of uniqueRefs.values()) {
          const manifestEntry = manifest.entries.find(value => value.attachmentId === ref.attachmentId);
          if (!manifestEntry) return failed('EVIDENCE_ATTACHMENT_MISSING');
          if (manifestEntry.path !== ref.path || manifestEntry.bytes !== ref.bytes || manifestEntry.sha256 !== ref.sha256) {
            return failed('EVIDENCE_ATTACHMENT_METADATA_MISMATCH');
          }
        }
      }
      actual.sort((left, right) => left.path.localeCompare(right.path));
      const rootDigest = digest(actual.map(entry => `${entry.path}\0${entry.attachmentId ?? ''}\0${entry.bytes}\0${entry.sha256}`).join('\n'));
      return rootDigest === manifest.rootDigest ? { ok: true, value: manifest } : failed('EVIDENCE_INTEGRITY_FAILED');
    } catch { return failed('EVIDENCE_INTEGRITY_FAILED'); }
  }

  private async readBundle(runId: string): Promise<OperationResult<EvidenceBundle>> {
    const runDir = join(this.root, runId);
    try {
      const records: EvidenceRecord[] = [];
      const attachments: Record<string, Buffer> = {};
      for (const name of await readdir(join(runDir, 'records'))) {
        records.push(JSON.parse(await readFile(join(runDir, 'records', name), 'utf8')) as EvidenceRecord);
      }
      try {
        for (const name of await readdir(join(runDir, 'attachments'))) {
          attachments[name] = await readFile(join(runDir, 'attachments', name));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return { ok: true, value: { runId, records, attachments } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: { runId, records: [], attachments: {} } };
      return failed('EVIDENCE_INTEGRITY_FAILED');
    }
  }
}
```

`src/domain/quality/evidence.ts` must export the complete `EvidenceRecord` interface shown in this task without shortening any field. `FileEvidenceStore.verifyIntegrity()` rereads bytes rather than trusting recorded hashes; the directory swap is rollback-safe and every file is synced before rename.

- [ ] **Step 4: add the complete authority-conflict integration test**

`tests/integration/evidenceAuthorityConflict.test.ts`

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';

it('detects any record or attachment byte change and never trusts self-reported pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wxnodus-evidence-'));
  const store = new FileEvidenceStore(root);
  const appended = await store.appendBundle({
    runId: 'run-tamper',
    records: [],
    attachments: { 'authoritative-stdout.log': Buffer.from('authoritative stdout') },
  });
  expect(appended.ok).toBe(true);
  const manifestPath = join(root, 'run-tamper', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    entries: Array<{ path: string }>;
  };
  const attachment = manifest.entries.find(entry => entry.path.startsWith('attachments/'))!;
  await writeFile(join(root, 'run-tamper', attachment.path), 'tampered');

  await expect(store.verifyIntegrity('run-tamper')).resolves.toMatchObject({
    ok: false,
    error: { code: 'EVIDENCE_INTEGRITY_FAILED' },
  });
});
```

- [ ] **Step 5: implement transport propagation and run green tests**

Transport mapping is exact and shared:

```ts
export const completionTransport = {
  succeeded: { processExit: 0, httpStatus: 200, wireFinal: 'succeeded' },
  failed: { processExit: 1, httpStatus: 422, wireFinal: 'failed' },
  blocked: { processExit: 2, httpStatus: 409, wireFinal: 'blocked' },
  incomplete: { processExit: 3, httpStatus: 424, wireFinal: 'incomplete' },
  inconclusive: { processExit: 4, httpStatus: 503, wireFinal: 'inconclusive' },
  cancelled: { processExit: 130, httpStatus: 499, wireFinal: 'cancelled' },
} as const;
```

```powershell
npm.cmd exec -- vitest run tests/unit/quality/verifierRegistry.contract.test.ts tests/integration/evidenceAuthorityConflict.test.ts tests/integration/failurePropagation.test.ts tests/build-spec.test.ts tests/kernel-serve.test.ts
npm.cmd run typecheck
```

Expected: PASS; each of the 16 IDs closes pass/fail/crash evidence; verifier crash is `inconclusive/VERIFIER_CRASH`; authority conflict and tamper cannot become success.

**Commit message when explicitly authorized:** `quality: bind completion to authoritative tamper-evident verification`

---

## Task W3-02：TUI Protocol 边界与 pure state projection

**Requirements/Subprojects:** R01、R11、R12；S11

**Files**
- Create: `src/presentation/tui/state/reducer.ts`
- Create: `src/presentation/tui/state/projector.ts`
- Create: `src/presentation/tui/state/selectors.ts`
- Create: `src/presentation/tui/effects/effectExecutor.ts`
- Create: `src/bootstrap/createCliFrontend.ts`
- Create: `src/bootstrap/createWireFrontend.ts`
- Create: `src/bootstrap/createHttpFrontend.ts`
- Create: `src/bootstrap/createTuiFrontend.ts`
- Modify: `src/wxnodus-ui/app.tsx`
- Modify: `src/wxnodus-ui/wxGateway.ts`
- Modify: `src/wxnodus-ui/gatewayClient.ts`
- Modify: `src/wxnodus-ui/bridge/eventAdapter.ts`
- Modify: `src/wxnodus-ui/runtime/flowController.ts`
- Modify: `src/wxnodus-ui/runtime/flowStore.ts`
- Modify: `src/wxnodus-ui/hooks/useSessionShell.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/unit/tui/reducer-projector.contract.test.ts`
- Create: `tests/contract/gatewayClient.contract.test.ts`
- Create: `tests/integration/frontendParity.test.ts`

**Stable failure codes**

- `TUI_EVENT_UNSUPPORTED`
- `TUI_EFFECT_UNSUPPORTED`
- `TUI_EFFECT_FAILED`
- `GATEWAY_CONTRACT_MISMATCH`
- `FRONTEND_COMPLETION_MISMATCH`
- `PRESENTATION_INFRASTRUCTURE_IMPORT_FORBIDDEN`

- [ ] **Step 1: paste the complete red test**

`tests/unit/tui/reducer-projector.contract.test.ts`

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { initialTuiState, reduceTui } from '../../../src/presentation/tui/state/reducer.js';
import { projectGatewayEvent } from '../../../src/presentation/tui/state/projector.js';

const events = [
  { schemaVersion: 1 as const, type: 'run.started', producer: 'gateway', timestamp: '2026-08-13T00:00:00.000Z', correlationId: 'c1', sensitivity: 'internal' as const, retention: 'session' as const, runId: 'r1', payload: {} },
  { schemaVersion: 1 as const, type: 'run.completed', producer: 'gateway', timestamp: '2026-08-13T00:00:01.000Z', correlationId: 'c1', sensitivity: 'internal' as const, retention: 'audit' as const, runId: 'r1', payload: { status: 'failed', reasons: ['criterion failed'] } },
];

describe('pure TUI projection', () => {
  it('produces the same state for the same event sequence without timers, RPC, fs, or mutation', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const apply = () => events.flatMap(projectGatewayEvent).reduce(reduceTui, initialTuiState());
    const first = apply();
    const second = apply();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ runs: { r1: { status: 'failed' } } });
    expect(timer).not.toHaveBeenCalled();
    expect(initialTuiState()).toEqual({ runs: {}, effects: [], lastError: null });
  });

  it('rejects unsupported events with a stable action instead of throwing or guessing', () => {
    expect(projectGatewayEvent({ ...events[0], type: 'unknown.event' })).toEqual([{
      type: 'projection.failed',
      code: 'TUI_EVENT_UNSUPPORTED',
      eventType: 'unknown.event',
    }]);
  });

  it('keeps headless bootstrap files free of React and Ink imports', async () => {
    for (const path of [
      'src/bootstrap/createCliFrontend.ts',
      'src/bootstrap/createWireFrontend.ts',
      'src/bootstrap/createHttpFrontend.ts',
    ]) {
      const source = await readFile(path, 'utf8');
      expect(source).not.toMatch(/from ['"](?:react|ink|@wxnodus\/ink)/);
    }
  });
});
```

- [ ] **Step 2: run the red test**

```powershell
npm.cmd exec -- vitest run tests/unit/tui/reducer-projector.contract.test.ts
```

Expected: FAIL because production reducer/projector files do not exist; no parallel simplified implementation is acceptable.

- [ ] **Step 3: paste the complete minimal implementation**

`src/presentation/tui/state/reducer.ts`

```ts
import type { GatewayMethod, GatewayParams } from '../../../protocol/gateway.js';

export type RunProjectionStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'incomplete' | 'inconclusive' | 'cancelled';
export interface TuiState {
  runs: Record<string, { status: RunProjectionStatus; reasons: string[] }>;
  effects: TuiEffect[];
  lastError: { code: string; detail: string } | null;
}
export type TuiEffect =
  | { type: 'gateway.request'; method: GatewayMethod; params: GatewayParams[GatewayMethod]; correlationId: string }
  | { type: 'unsupported'; effectType: string };
export type TuiAction =
  | { type: 'run.started'; runId: string }
  | { type: 'run.completed'; runId: string; status: Exclude<RunProjectionStatus, 'running'>; reasons: string[] }
  | { type: 'effect.queued'; effect: TuiEffect }
  | { type: 'effect.dequeued'; correlationId: string }
  | { type: 'projection.failed'; code: 'TUI_EVENT_UNSUPPORTED'; eventType: string };

export const initialTuiState = (): TuiState => ({ runs: {}, effects: [], lastError: null });

export function reduceTui(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'run.started':
      return { ...state, runs: { ...state.runs, [action.runId]: { status: 'running', reasons: [] } } };
    case 'run.completed':
      return { ...state, runs: { ...state.runs, [action.runId]: { status: action.status, reasons: [...action.reasons] } } };
    case 'effect.queued':
      return { ...state, effects: [...state.effects, action.effect] };
    case 'effect.dequeued':
      return { ...state, effects: state.effects.filter(effect => effect.type !== 'gateway.request' || effect.correlationId !== action.correlationId) };
    case 'projection.failed':
      return { ...state, lastError: { code: action.code, detail: action.eventType } };
  }
}
```

`src/presentation/tui/state/projector.ts`

```ts
import type { GatewayEvent } from '../../../protocol/events.js';
import type { TuiAction } from './reducer.js';

const terminal = new Set(['succeeded', 'failed', 'blocked', 'incomplete', 'inconclusive', 'cancelled']);

export function projectGatewayEvent(event: GatewayEvent): TuiAction[] {
  if (event.type === 'run.started' && event.runId) return [{ type: 'run.started', runId: event.runId }];
  if (event.type === 'run.completed' && event.runId) {
    const payload = event.payload as { status?: string; reasons?: string[] };
    if (payload.status && terminal.has(payload.status)) {
      return [{
        type: 'run.completed',
        runId: event.runId,
        status: payload.status as 'succeeded' | 'failed' | 'blocked' | 'incomplete' | 'inconclusive' | 'cancelled',
        reasons: Array.isArray(payload.reasons) ? payload.reasons : [],
      }];
    }
  }
  return [{ type: 'projection.failed', code: 'TUI_EVENT_UNSUPPORTED', eventType: event.type }];
}
```

`src/presentation/tui/effects/effectExecutor.ts`

```ts
import type { OperationResult } from '../../../protocol/results.js';
import type { GatewayPort } from '../../../protocol/gateway.js';
import type { TuiEffect } from '../state/reducer.js';

export class TuiEffectExecutor {
  constructor(private readonly gateway: GatewayPort) {}

  async execute(effect: TuiEffect, signal: AbortSignal): Promise<OperationResult<void>> {
    if (effect.type !== 'gateway.request') return {
      ok: false,
      error: { code: 'TUI_EFFECT_UNSUPPORTED', message: effect.effectType, messageKey: 'TUI_EFFECT_UNSUPPORTED', retryable: false },
    };
    const result = await this.gateway.request(effect.method, effect.params, { signal, correlationId: effect.correlationId });
    return result.ok ? { ok: true, value: undefined, evidenceIds: result.evidenceIds } : result;
  }
}
```

- [ ] **Step 4: run contract and parity tests**

```powershell
npm.cmd exec -- vitest run tests/unit/tui/reducer-projector.contract.test.ts tests/contract/gatewayClient.contract.test.ts tests/integration/frontendParity.test.ts tests/app-layer.test.ts tests/kernel-gateway.test.ts
npm.cmd run typecheck
```

Expected: PASS; CLI/Wire/HTTP/TUI return the same `CompletionDecision`; headless composition has no React/Ink import.

**Commit message when explicitly authorized:** `tui: project protocol events through pure state reducers`

---

## Task W3-03：Voice Domain 状态机、AudioDeviceService、WAV 与 retention

**Requirements/Subprojects:** R08、R14；S6

**Files**
- Create: `src/domain/voice/voiceState.ts`
- Create: `src/domain/voice/voiceSession.ts`
- Create: `src/domain/voice/audioDevice.ts`
- Create: `src/application/voice/voiceSessionService.ts`
- Create: `src/application/voice/audioDeviceService.ts`
- Create: `src/infrastructure/voice/windowsAudioDeviceProbe.ts`
- Create: `src/infrastructure/voice/audioDeviceSettingsRepository.ts`
- Create: `src/infrastructure/voice/wavWriter.ts`
- Modify: `src/kernel/voice.ts`
- Modify: `src/kernel/vad.ts`
- Modify: `src/kernel/wake.ts`
- Create: `tests/unit/voice/voice-domain.contract.test.ts`
- Create: `tests/unit/voice/audioDeviceService.test.ts`
- Create: `tests/unit/voice/wavWriter.test.ts`

**Stable failure codes**

- `VOICE_ILLEGAL_TRANSITION`
- `VOICE_DEVICE_NOT_FOUND`
- `VOICE_DEVICE_INVALID_SELECTION`
- `VOICE_DEVICE_DISCONNECTED`
- `VOICE_DEVICE_ENUMERATION_FAILED`
- `VOICE_DEVICE_PERSISTENCE_FAILED`
- `VOICE_WAV_INVALID_HEADER`
- `VOICE_RESOURCE_LEAK_DETECTED`
- `VOICE_RETENTION_POLICY_VIOLATION`
- `VOICE_SECRET_TRANSCRIPT_EXPOSED`

- [ ] **Step 1: paste the complete AudioDeviceService red test**

`tests/unit/voice/audioDeviceService.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { AudioDeviceService } from '../../../src/application/voice/audioDeviceService.js';
import type { AudioDeviceSnapshot } from '../../../src/domain/voice/audioDevice.js';

const microphone = (id: string, name: string): AudioDeviceSnapshot => ({
  id, name, kind: 'input', backend: 'windows-mmdevice', state: 'active', isDefault: id === 'mic-1',
});

class MemorySettings {
  value: string | null = null;
  async readSelectedInput(): Promise<string | null> { return this.value; }
  async writeSelectedInput(id: string): Promise<void> { this.value = id; }
}

class MutableProbe {
  devices = [microphone('mic-1', 'Desk Mic'), microphone('mic-2', 'USB Mic')];
  async enumerate(): Promise<AudioDeviceSnapshot[]> { return this.devices.map(device => ({ ...device })); }
}

describe('AudioDeviceService', () => {
  it('enumerates, selects, rejects invalid IDs, persists, and reads selection back', async () => {
    const probe = new MutableProbe();
    const settings = new MemorySettings();
    const first = new AudioDeviceService(probe, settings);

    await expect(first.listInputs()).resolves.toMatchObject({ ok: true, value: { devices: [{ id: 'mic-1' }, { id: 'mic-2' }] } });
    await expect(first.selectInput('missing')).resolves.toMatchObject({
      ok: false,
      error: { code: 'VOICE_DEVICE_INVALID_SELECTION' },
    });
    await expect(first.selectInput('mic-2')).resolves.toMatchObject({ ok: true, value: { selectedId: 'mic-2' } });

    const restarted = new AudioDeviceService(probe, settings);
    await expect(restarted.readSelection()).resolves.toMatchObject({ ok: true, value: { selectedId: 'mic-2' } });
  });

  it('turns hot unplug into a stable failure and does not silently pick another device', async () => {
    const probe = new MutableProbe();
    const settings = new MemorySettings();
    const service = new AudioDeviceService(probe, settings);
    await service.selectInput('mic-2');
    probe.devices = [microphone('mic-1', 'Desk Mic')];

    await expect(service.assertSelectedDevicePresent()).resolves.toMatchObject({
      ok: false,
      error: { code: 'VOICE_DEVICE_DISCONNECTED', details: { selectedId: 'mic-2' } },
    });
    expect(settings.value).toBe('mic-2');
  });
});
```

- [ ] **Step 2: run the red test**

```powershell
npm.cmd exec -- vitest run tests/unit/voice/audioDeviceService.test.ts tests/unit/voice/voice-domain.contract.test.ts tests/unit/voice/wavWriter.test.ts
```

Expected: FAIL because `AudioDeviceService`, the single state source, and independent WAV adapter do not exist.

- [ ] **Step 3: paste the complete minimal device implementation**

`src/domain/voice/audioDevice.ts`

```ts
export interface AudioDeviceSnapshot {
  id: string;
  name: string;
  kind: 'input';
  backend: 'windows-mmdevice' | 'ffmpeg-dshow' | 'coreaudio' | 'pulse';
  state: 'active' | 'disabled' | 'unplugged';
  isDefault: boolean;
}
export interface AudioDeviceProbePort { enumerate(): Promise<AudioDeviceSnapshot[]> }
export interface AudioDeviceSettingsPort {
  readSelectedInput(): Promise<string | null>;
  writeSelectedInput(id: string): Promise<void>;
}
```

`src/application/voice/audioDeviceService.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';
import type { AudioDeviceProbePort, AudioDeviceSettingsPort } from '../../domain/voice/audioDevice.js';

const failed = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export class AudioDeviceService {
  constructor(
    private readonly probe: AudioDeviceProbePort,
    private readonly settings: AudioDeviceSettingsPort,
  ) {}

  async listInputs(): Promise<OperationResult<{ devices: Awaited<ReturnType<AudioDeviceProbePort['enumerate']>> }>> {
    try {
      return { ok: true, value: { devices: (await this.probe.enumerate()).filter(device => device.kind === 'input') } };
    } catch {
      return failed('VOICE_DEVICE_ENUMERATION_FAILED');
    }
  }

  async selectInput(id: string): Promise<OperationResult<{ selectedId: string }>> {
    const listed = await this.listInputs();
    if (!listed.ok) return listed;
    const selected = listed.value.devices.find(device => device.id === id && device.state === 'active');
    if (!selected) return failed('VOICE_DEVICE_INVALID_SELECTION', { selectedId: id });
    try {
      await this.settings.writeSelectedInput(selected.id);
      const readBack = await this.settings.readSelectedInput();
      if (readBack !== selected.id) return failed('VOICE_DEVICE_PERSISTENCE_FAILED', { selectedId: id, readBack });
      return { ok: true, value: { selectedId: selected.id } };
    } catch {
      return failed('VOICE_DEVICE_PERSISTENCE_FAILED', { selectedId: id });
    }
  }

  async readSelection(): Promise<OperationResult<{ selectedId: string | null }>> {
    try { return { ok: true, value: { selectedId: await this.settings.readSelectedInput() } }; }
    catch { return failed('VOICE_DEVICE_PERSISTENCE_FAILED'); }
  }

  async assertSelectedDevicePresent(): Promise<OperationResult<{ selectedId: string | null }>> {
    const selected = await this.settings.readSelectedInput();
    if (!selected) return { ok: true, value: { selectedId: null } };
    const listed = await this.listInputs();
    if (!listed.ok) return listed;
    const present = listed.value.devices.some(device => device.id === selected && device.state === 'active');
    return present ? { ok: true, value: { selectedId: selected } } : failed('VOICE_DEVICE_DISCONNECTED', { selectedId: selected });
  }
}
```

`src/domain/voice/voiceState.ts`

```ts
import type { GatewayError } from '../../protocol/errors.js';
export type VoiceState = 'idle' | 'listening' | 'speech_detected' | 'transcribing' |
  'thinking' | 'speaking' | 'cancelling' | 'stopping' | 'error';
export interface VoiceSessionSnapshot {
  id: string;
  state: VoiceState;
  mode: 'push-to-talk' | 'continuous' | 'wake-word';
  selectedDeviceId: string | null;
  error?: GatewayError;
}
const allowed: Record<VoiceState, readonly VoiceState[]> = {
  idle: ['listening'],
  listening: ['speech_detected', 'cancelling', 'stopping', 'error'],
  speech_detected: ['transcribing', 'cancelling', 'error'],
  transcribing: ['thinking', 'cancelling', 'error'],
  thinking: ['speaking', 'idle', 'cancelling', 'error'],
  speaking: ['idle', 'cancelling', 'error'],
  cancelling: ['idle'],
  stopping: ['idle'],
  error: ['idle'],
};
export function transitionVoice(snapshot: VoiceSessionSnapshot, next: VoiceState): VoiceSessionSnapshot {
  if (!allowed[snapshot.state].includes(next)) throw Object.assign(new Error('VOICE_ILLEGAL_TRANSITION'), { code: 'VOICE_ILLEGAL_TRANSITION' });
  return { ...snapshot, state: next, error: undefined };
}
```

Windows implementation requirement: `windowsAudioDeviceProbe.ts` must enumerate stable MMDevice endpoint IDs through a non-interactive PowerShell/.NET probe, preserve the friendly name only as display data, and never use the friendly name as persistent identity. The real Win10/Win11 enumeration/selection/hot-unplug/read-back contract is executed in W3-10.

- [ ] **Step 4: run green tests**

```powershell
npm.cmd exec -- vitest run tests/unit/voice/audioDeviceService.test.ts tests/unit/voice/voice-domain.contract.test.ts tests/unit/voice/wavWriter.test.ts tests/kernel-voice.test.ts tests/kernel-vad.test.ts
npm.cmd run typecheck
```

Expected: PASS; invalid selection is `VOICE_DEVICE_INVALID_SELECTION`; unplug is `VOICE_DEVICE_DISCONNECTED`; raw audio defaults to ephemeral cleanup; secret transcripts expose only opaque refs.

**Commit message when explicitly authorized:** `voice: add durable audio device selection and recoverable session state`

---

## Task W3-04：异步 Voice workers、取消、SAPI 与 headless parity

**Requirements/Subprojects:** R08、R11、R17；S6

**Files**
- Create: `src/infrastructure/voice/ffmpegRecorder.ts`
- Create: `src/infrastructure/voice/whisperTranscriber.ts`
- Create: `src/infrastructure/voice/windowsSapiTts.ts`
- Create: `src/infrastructure/voice/voiceWorkerProtocol.ts`
- Modify: `src/application/voice/voiceSessionService.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/wxnodus-ui/wxGateway.ts`
- Modify: `src/wxnodus-ui/bridge/eventAdapter.ts`
- Create: `tests/integration/voiceSession.test.ts`
- Create: `tests/integration/voiceHeadlessParity.test.ts`
- Create: `tests/failure/voiceWorkerFailure.test.ts`

**Stable failure codes**

- `VOICE_STT_UNAVAILABLE`
- `VOICE_WORKER_SPAWN_FAILED`
- `VOICE_WORKER_TIMEOUT`
- `VOICE_WORKER_CRASHED`
- `VOICE_WORKER_ABORTED`
- `VOICE_PROCESS_TREE_STILL_RUNNING`
- `VOICE_TEMP_CLEANUP_FAILED`
- `VOICE_SAPI_UNAVAILABLE`
- `VOICE_FRONTEND_PARITY_MISMATCH`

- [ ] **Step 1: paste the complete red integration test**

`tests/failure/voiceWorkerFailure.test.ts`

```ts
import { expect, it, vi } from 'vitest';
import { VoiceSessionService } from '../../src/application/voice/voiceSessionService.js';

it('keeps the event loop responsive and confirms process-tree termination on abort', async () => {
  let heartbeat = 0;
  const interval = setInterval(() => { heartbeat += 1; }, 5);
  const terminateTree = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const supervisor = {
    spawn: vi.fn(async (_exe: string, _args: string[], _options: unknown, signal: AbortSignal) =>
      new Promise(resolve => signal.addEventListener('abort', () => resolve({
        processId: 41, exitCode: null, signal: 'ABORT', stdout: '', stderr: '', timedOut: false, aborted: true,
      }), { once: true }))),
    terminateTree,
  };
  const temp = { remove: vi.fn(async () => ({ ok: true as const, value: undefined })) };
  const service = new VoiceSessionService({ supervisor, temp, sttReady: () => true });
  const controller = new AbortController();
  const pending = service.transcribe({ id: 'audio-1', path: 'audio.wav', retention: 'ephemeral' }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort();
  const result = await pending;
  clearInterval(interval);

  expect(heartbeat).toBeGreaterThan(1);
  expect(result).toMatchObject({ ok: false, error: { code: 'VOICE_WORKER_ABORTED' } });
  expect(terminateTree).toHaveBeenCalledWith(41, 5_000);
  expect(temp.remove).toHaveBeenCalledWith('audio.wav');
  expect(service.snapshot().state).toBe('idle');
});

it('does not enter listening when STT capability is unavailable', async () => {
  const service = new VoiceSessionService({
    supervisor: { spawn: vi.fn(), terminateTree: vi.fn() },
    temp: { remove: vi.fn() },
    sttReady: () => false,
  });
  await expect(service.start('push-to-talk', AbortSignal.timeout(100))).resolves.toMatchObject({
    ok: false,
    error: { code: 'VOICE_STT_UNAVAILABLE' },
  });
  expect(service.snapshot().state).toBe('idle');
});
```

- [ ] **Step 2: run the red test**

```powershell
npm.cmd exec -- vitest run tests/failure/voiceWorkerFailure.test.ts tests/integration/voiceSession.test.ts tests/integration/voiceHeadlessParity.test.ts
```

Expected: FAIL; existing `spawnSync` path blocks and cannot prove process-tree termination.

- [ ] **Step 3: paste the complete minimal service implementation**

`src/application/voice/voiceSessionService.ts`

```ts
import { randomUUID } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';
import type { VoiceSessionSnapshot } from '../../domain/voice/voiceState.js';

interface ProcessResult { processId: number; exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }
interface SupervisorPort {
  spawn(executable: string, args: string[], options: { timeoutMs: number }, signal: AbortSignal): Promise<ProcessResult>;
  terminateTree(processId: number, deadlineMs: number): Promise<OperationResult<void>>;
}
interface TempPort { remove(path: string): Promise<OperationResult<void>> }
export interface AudioRef { id: string; path: string; retention: 'ephemeral' | 'session' | 'audit' }

const error = (code: string, details?: Record<string, unknown>): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export class VoiceSessionService {
  private current: VoiceSessionSnapshot = {
    id: randomUUID(), state: 'idle', mode: 'push-to-talk', selectedDeviceId: null,
  };

  constructor(private readonly deps: { supervisor: SupervisorPort; temp: TempPort; sttReady(): boolean }) {}
  snapshot(): VoiceSessionSnapshot { return structuredClone(this.current); }

  async start(mode: VoiceSessionSnapshot['mode'], _signal: AbortSignal): Promise<OperationResult<VoiceSessionSnapshot>> {
    if (!this.deps.sttReady()) return error('VOICE_STT_UNAVAILABLE');
    this.current = { ...this.current, mode, state: 'listening' };
    return { ok: true, value: this.snapshot() };
  }

  async transcribe(audio: AudioRef, signal: AbortSignal): Promise<OperationResult<{ transcriptRef: string }>> {
    this.current = { ...this.current, state: 'transcribing' };
    let processId: number | null = null;
    try {
      const result = await this.deps.supervisor.spawn('whisper-cli', ['-f', audio.path], { timeoutMs: 120_000 }, signal);
      processId = result.processId;
      if (result.aborted || signal.aborted) {
        const stopped = await this.deps.supervisor.terminateTree(result.processId, 5_000);
        if (!stopped.ok) return error('VOICE_PROCESS_TREE_STILL_RUNNING', { processId: result.processId });
        return error('VOICE_WORKER_ABORTED');
      }
      if (result.timedOut) return error('VOICE_WORKER_TIMEOUT', { processId: result.processId });
      if (result.exitCode !== 0) return error('VOICE_WORKER_CRASHED', { processId: result.processId, exitCode: result.exitCode });
      return { ok: true, value: { transcriptRef: `transcript://${audio.id}` } };
    } catch {
      return error('VOICE_WORKER_SPAWN_FAILED', processId === null ? undefined : { processId });
    } finally {
      if (audio.retention === 'ephemeral') await this.deps.temp.remove(audio.path);
      this.current = { ...this.current, state: 'idle' };
    }
  }
}
```

Adapters use executable plus argv only: ffmpeg dshow recording, whisper transcription, and PowerShell SAPI speech all call `ProcessSupervisor.spawn`; no shell command concatenation. CLI `/voice on|off|status`, Wire, HTTP, and TUI Gateway call this service and return the same stable code/status.

- [ ] **Step 4: run green tests**

```powershell
npm.cmd exec -- vitest run tests/failure/voiceWorkerFailure.test.ts tests/integration/voiceSession.test.ts tests/integration/voiceHeadlessParity.test.ts tests/kernel-wake.test.ts
npm.cmd run typecheck
```

Expected: PASS; abort returns `VOICE_WORKER_ABORTED`; timeout returns `VOICE_WORKER_TIMEOUT`; unavailable STT never exposes a false-ready listening state.

**Commit message when explicitly authorized:** `voice: make recording transcription and SAPI playback cancellable`

---

## Task W3-05：ComputerUseService、高影响审批 DTO、postcondition 与全局急停

**Requirements/Subprojects:** R07、R15、R16；S7

**Files**
- Create: `src/domain/computer/computerAction.ts`
- Create: `src/domain/computer/highImpactApproval.ts`
- Create: `src/domain/computer/postcondition.ts`
- Create: `src/application/computer/computerUseService.ts`
- Create: `src/application/computer/computerFrontendHandler.ts`
- Create: `src/application/computer/emergencyStopService.ts`
- Modify: `src/kernel/computer/guards.ts`
- Modify: `src/kernel/tools.ts`
- Modify: `src/commands/handlersExt.ts`
- Modify: `src/presentation/cli/cliGatewayAdapter.ts`
- Modify: `src/presentation/wire/wireGatewayAdapter.ts`
- Modify: `src/presentation/http/httpGatewayAdapter.ts`
- Modify: `src/presentation/tui/inProcessGatewayAdapter.ts`
- Create: `tests/unit/computer/highImpactApproval.test.ts`
- Create: `tests/unit/computer/postcondition.test.ts`
- Create: `tests/integration/computerUsePipeline.test.ts`
- Create: `tests/integration/computerFrontendParity.test.ts`
- Create: `tests/integration/emergencyStop.test.ts`

**Stable high-impact kinds and rule:** `external-send`、`delete`、`payment`、`publish`、`system-config` always require a fresh, scoped, single-use approval grant. No frontend may downgrade these kinds.

**Stable failure codes**

- `COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED`
- `APPROVAL_GRANT_SCOPE_MISMATCH`
- `APPROVAL_GRANT_REPLAYED`
- `COMPUTER_POSTCONDITION_FAILED`
- `COMPUTER_ACTION_BLOCKED`
- `COMPUTER_EMERGENCY_STOP_ACTIVE`
- `COMPUTER_DRIVER_NO_ACTION`
- `COMPUTER_FRONTEND_PARITY_MISMATCH`

- [ ] **Step 1: paste the complete red approval test**

`tests/unit/computer/highImpactApproval.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  createHighImpactApprovalRequest,
  validateHighImpactGrant,
  type HighImpactAction,
} from '../../../src/domain/computer/highImpactApproval.js';

const action = (amount: number): HighImpactAction => ({
  kind: 'payment',
  target: { type: 'account', id: 'vendor-7', display: 'Vendor Seven' },
  effect: { summary: 'Pay invoice INV-9', parameters: { amount, currency: 'USD', invoiceId: 'INV-9' } },
  reversibility: { reversible: false, method: null, deadline: null },
  verification: { verifierId: 'database.query', description: 'ledger contains one settled payment' },
});

describe('high-impact approval scope', () => {
  it('contains target, effect, reversibility, verification, and stable rule ID', () => {
    expect(createHighImpactApprovalRequest(action(125), { actorId: 'a1', sessionId: 's1', runId: 'r1' })).toMatchObject({
      ruleId: 'computer.high-impact.payment.v1',
      actionKind: 'payment',
      target: { id: 'vendor-7' },
      reversibility: { reversible: false },
      verification: { verifierId: 'database.query' },
    });
  });

  it('invalidates the grant when any parameter changes', () => {
    const approved = createHighImpactApprovalRequest(action(125), { actorId: 'a1', sessionId: 's1', runId: 'r1' });
    const grant = {
      id: 'grant-1', actorId: 'a1', sessionId: 's1', runId: 'r1',
      requestHash: approved.requestHash, status: 'issued' as const,
    };
    expect(validateHighImpactGrant(grant, approved)).toMatchObject({ ok: true });
    const changed = createHighImpactApprovalRequest(action(126), { actorId: 'a1', sessionId: 's1', runId: 'r1' });
    expect(validateHighImpactGrant(grant, changed)).toMatchObject({
      ok: false,
      error: { code: 'APPROVAL_GRANT_SCOPE_MISMATCH' },
    });
  });
});
```

`tests/integration/computerFrontendParity.test.ts`

```ts
import { expect, it, vi } from 'vitest';
import { createComputerFrontendHandler } from '../../src/application/computer/computerFrontendHandler.js';

it('keeps CLI, Wire, HTTP, and TUI decisions identical for high-impact actions', async () => {
  const execute = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', message: 'approval', messageKey: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', retryable: false },
  }));
  const service = { execute };
  const request = { kind: 'publish', target: { type: 'site', id: 'prod' }, effect: { summary: 'publish release', parameters: { version: '4.0.0' } } };
  const results = await Promise.all(['cli', 'wire', 'http', 'tui'].map(frontend =>
    createComputerFrontendHandler(frontend, service).handle(request, { sessionId: 's', runId: 'r', actorId: 'a' }, AbortSignal.timeout(100))));
  expect(results.map(result => result.ok ? 'ok' : result.error.code)).toEqual([
    'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED',
    'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED',
    'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED',
    'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED',
  ]);
  expect(execute).toHaveBeenCalledTimes(4);
});
```

- [ ] **Step 2: run the red tests**

```powershell
npm.cmd exec -- vitest run tests/unit/computer/highImpactApproval.test.ts tests/integration/computerFrontendParity.test.ts tests/unit/computer/postcondition.test.ts tests/integration/computerUsePipeline.test.ts tests/integration/emergencyStop.test.ts
```

Expected: FAIL; current direct driver paths have no stable high-impact DTO, no scoped grant hash, and no shared frontend handler.

- [ ] **Step 3: paste the complete minimal approval implementation**

`src/domain/computer/highImpactApproval.ts`

```ts
import { createHash } from 'node:crypto';
import type { OperationResult } from '../../protocol/results.js';

export type HighImpactKind = 'external-send' | 'delete' | 'payment' | 'publish' | 'system-config';
export interface HighImpactAction {
  kind: HighImpactKind;
  target: { type: string; id: string; display: string };
  effect: { summary: string; parameters: Record<string, string | number | boolean | null> };
  reversibility: { reversible: boolean; method: string | null; deadline: string | null };
  verification: { verifierId: string; description: string };
}
export interface HighImpactApprovalRequest extends HighImpactAction {
  ruleId: `computer.high-impact.${HighImpactKind}.v1`;
  actorId: string;
  sessionId: string;
  runId: string;
  requestHash: string;
}
export interface HighImpactGrant {
  id: string;
  actorId: string;
  sessionId: string;
  runId: string;
  requestHash: string;
  status: 'issued' | 'consumed' | 'revoked';
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
};

export function createHighImpactApprovalRequest(
  action: HighImpactAction,
  context: { actorId: string; sessionId: string; runId: string },
): HighImpactApprovalRequest {
  const body = { ...action, ...context, ruleId: `computer.high-impact.${action.kind}.v1` as const };
  return { ...body, requestHash: createHash('sha256').update(canonical(body)).digest('hex') };
}

export function validateHighImpactGrant(
  grant: HighImpactGrant,
  request: HighImpactApprovalRequest,
): OperationResult<void> {
  const matches = grant.status === 'issued' && grant.actorId === request.actorId &&
    grant.sessionId === request.sessionId && grant.runId === request.runId && grant.requestHash === request.requestHash;
  return matches ? { ok: true, value: undefined } : {
    ok: false,
    error: {
      code: grant.status === 'consumed' ? 'APPROVAL_GRANT_REPLAYED' : 'APPROVAL_GRANT_SCOPE_MISMATCH',
      message: 'High-impact approval grant does not match the canonical request',
      messageKey: 'APPROVAL_GRANT_SCOPE_MISMATCH',
      retryable: false,
    },
  };
}
```

`src/application/computer/computerFrontendHandler.ts`

```ts
export function createComputerFrontendHandler(
  frontend: string,
  service: { execute(request: unknown, context: unknown, signal: AbortSignal): Promise<unknown> },
) {
  return {
    async handle(request: unknown, context: unknown, signal: AbortSignal) {
      void frontend;
      return service.execute(request, context, signal);
    },
  };
}
```

`ComputerUseService.execute` must call one shared pipeline in this exact order and preserve one `runId/effectId/correlationId` across every stage:

```ts
const before = await observer.observe(request.target, context, signal);
const resolved = await resolver.resolve(request, before, context);
const policy = await pdp.decide(resolved.effect, context);
const authorized = await approvals.authorize(resolved, policy, context, signal);
const receipt = await driver.act(authorized.action, context, signal);
if (!receipt.acted) return fail('COMPUTER_DRIVER_NO_ACTION');
const after = await observer.observe(request.target, context, signal);
const verified = await postconditions.verify(resolved.verification, before, after, context, signal);
if (verified.status !== 'passed') return fail('COMPUTER_POSTCONDITION_FAILED');
return evidence.closeComputerAction({ before, resolved, policy, receipt, after, verified, context });
```

Emergency stop is process-wide Application state, cancels running and queued actions, rejects new actions with `COMPUTER_EMERGENCY_STOP_ACTIVE`, and requires a fresh scoped grant to reset.

- [ ] **Step 4: run green tests**

```powershell
npm.cmd exec -- vitest run tests/unit/computer/highImpactApproval.test.ts tests/unit/computer/postcondition.test.ts tests/integration/computerUsePipeline.test.ts tests/integration/computerFrontendParity.test.ts tests/integration/emergencyStop.test.ts tests/computer.test.ts
npm.cmd run typecheck
```

Expected: PASS; parameter changes invalidate grants; all frontends return the same decision; a driver receipt without verified effect cannot succeed.

**Commit message when explicitly authorized:** `computer: enforce scoped high-impact approvals and verified actions`

---

## Task W3-06：Browser/UIA/Coordinate drivers 安全与多屏 DPI

**Requirements/Subprojects:** R07、R17；S7；Gate E/F

**Files**
- Create: `src/infrastructure/computer/playwrightBrowserDriver.ts`
- Create: `src/infrastructure/computer/windowsUiaDriver.ts`
- Create: `src/infrastructure/computer/robotComputerDriver.ts`
- Create: `src/infrastructure/computer/virtualDesktop.ts`
- Create: `src/infrastructure/computer/urlPolicy.ts`
- Modify: `src/kernel/browser.ts`
- Modify: `src/kernel/computer/index.ts`
- Modify: `src/kernel/computer/actionLayer.ts`
- Modify: `src/kernel/computer/uia.ts`
- Create: `tests/unit/computer/driverContracts.test.ts`
- Create: `tests/integration/browserIsolation.test.ts`
- Create: `tests/failure/driverFallback.test.ts`

**Stable failure codes**

- `BROWSER_URL_POLICY_DENIED`
- `BROWSER_DNS_REBINDING_DETECTED`
- `BROWSER_CONTEXT_ISOLATION_FAILED`
- `UIA_PATTERN_UNAVAILABLE`
- `UIA_ACTION_NOT_PERFORMED`
- `UIA_SESSION_NOT_INTERACTIVE`
- `UIA_SESSION_LOCKED`
- `UIA_INPUT_DESKTOP_INVALID`
- `UIA_TARGET_INTEGRITY_BLOCKED`
- `UIA_PROTECTED_UI_BLOCKED`
- `SECURE_DESKTOP_BLOCKED`
- `UIA_COORDINATE_FALLBACK_FORBIDDEN`
- `COORDINATE_OUTSIDE_VIRTUAL_DESKTOP`
- `COORDINATE_PHYSICAL_BOUNDS_INVALID`
- `COORDINATE_TRANSFORM_INVALID`
- `DPI_AWARENESS_REQUIRED`
- `BROWSER_SERVICE_WORKER_POLICY_UNSUPPORTED`
- `BROWSER_NETWORK_ROUTE_REQUIRED`
- `BROWSER_NETWORK_SCOPE_VIOLATION`
- `DRIVER_FALLBACK_UNVERIFIED`

- [ ] **Step 1: paste the complete red driver test**

`tests/unit/computer/driverContracts.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { toPhysicalPoint } from '../../../src/infrastructure/computer/virtualDesktop.js';
import { UrlPolicy } from '../../../src/infrastructure/computer/urlPolicy.js';
import { WindowsUiaDriver } from '../../../src/infrastructure/computer/windowsUiaDriver.js';

it('maps PMv2 logical points through monitor physical origin on negative-origin mixed-DPI monitors', () => {
  const desktop = { dpiAwareness: 'per-monitor-v2' as const, monitors: [
    {
      id: 'left',
      logicalBounds: { x: -1280, y: 0, width: 1280, height: 1024 },
      physicalBounds: { x: -1280, y: 0, width: 1280, height: 1024 },
      physicalOrigin: { x: -1280, y: 0 },
      scale: 1,
    },
    {
      id: 'main',
      logicalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      physicalBounds: { x: 0, y: 0, width: 2880, height: 1620 },
      physicalOrigin: { x: 0, y: 0 },
      scale: 1.5,
    },
    {
      id: 'top',
      logicalBounds: { x: 0, y: -900, width: 1600, height: 900 },
      physicalBounds: { x: 0, y: -1125, width: 2000, height: 1125 },
      physicalOrigin: { x: 0, y: -1125 },
      scale: 1.25,
    },
  ] };
  expect(toPhysicalPoint(desktop, { x: -100, y: 100 })).toEqual({
    monitorId: 'left', physicalOrigin: { x: -1280, y: 0 }, scaledLocal: { x: 1180, y: 100 }, x: -100, y: 100,
  });
  expect(toPhysicalPoint(desktop, { x: 100, y: 100 })).toEqual({
    monitorId: 'main', physicalOrigin: { x: 0, y: 0 }, scaledLocal: { x: 150, y: 150 }, x: 150, y: 150,
  });
  expect(toPhysicalPoint(desktop, { x: 100, y: -100 })).toEqual({
    monitorId: 'top', physicalOrigin: { x: 0, y: -1125 }, scaledLocal: { x: 125, y: 1000 }, x: 125, y: -125,
  });
  expect(() => toPhysicalPoint(desktop, { x: 9000, y: 9000 })).toThrowError('COORDINATE_OUTSIDE_VIRTUAL_DESKTOP');
});

it('applies URL policy to public-to-private redirects and resolved addresses', async () => {
  const policy = new UrlPolicy({ resolve: async host => host === 'public.example' ? ['203.0.113.8'] : ['127.0.0.1'] });
  await expect(policy.authorize('https://public.example/start')).resolves.toMatchObject({ ok: true });
  await expect(policy.authorize('http://localhost/admin')).resolves.toMatchObject({
    ok: false,
    error: { code: 'BROWSER_URL_POLICY_DENIED' },
  });
});

it.each([
  ['service session', { interactive: false }, 'UIA_SESSION_NOT_INTERACTIVE'],
  ['locked session', { unlocked: false }, 'UIA_SESSION_LOCKED'],
  ['secure desktop', { inputDesktop: 'Winlogon' }, 'SECURE_DESKTOP_BLOCKED'],
  ['higher integrity target', { targetIntegrity: 'high' }, 'UIA_TARGET_INTEGRITY_BLOCKED'],
  ['protected system UI', { protectedUi: true }, 'UIA_PROTECTED_UI_BLOCKED'],
] as const)('fails closed before %s actions and never calls coordinate fallback', async (_name, patch, code) => {
  const coordinateFallback = vi.fn(async () => ({ acted: true, receiptId: 'coordinate-1' }));
  const driver = new WindowsUiaDriver({
    inspectBoundary: async () => ({
      interactive: true, unlocked: true, inputDesktop: 'Default', runnerIntegrity: 'medium', targetIntegrity: 'medium', protectedUi: false,
      ...patch,
    }),
    invoke: async () => false,
    select: async () => false,
    coordinateFallback,
  });
  await expect(driver.act({ runtimeId: '42', action: 'activate' }, {}, AbortSignal.timeout(100))).resolves.toMatchObject({
    ok: false,
    error: { code },
  });
  expect(coordinateFallback).not.toHaveBeenCalled();
});

it('does not report success when Invoke and Selection fail and a coordinate fallback is not explicitly safe', async () => {
  const driver = new WindowsUiaDriver({
    inspectBoundary: async () => ({
      interactive: true, unlocked: true, inputDesktop: 'Default', runnerIntegrity: 'medium', targetIntegrity: 'medium', protectedUi: false,
    }),
    invoke: async () => false,
    select: async () => false,
    coordinateFallback: async () => ({ acted: false, receiptId: null }),
  });
  await expect(driver.act({ runtimeId: '42', action: 'activate' }, {}, AbortSignal.timeout(100))).resolves.toMatchObject({
    ok: false,
    error: { code: 'UIA_ACTION_NOT_PERFORMED' },
  });
});
```

- [ ] **Step 2: run the red tests**

```powershell
npm.cmd exec -- vitest run tests/unit/computer/driverContracts.test.ts tests/integration/browserIsolation.test.ts tests/failure/driverFallback.test.ts
```

Expected: FAIL; current implementation assumes the first monitor, has initial-URL-only policy, and can turn focus into false success.

- [ ] **Step 3: paste the complete minimal coordinate and UIA implementation**

`src/infrastructure/computer/virtualDesktop.ts`

```ts
export interface Rect { x: number; y: number; width: number; height: number }
export interface MonitorSnapshot {
  id: string;
  logicalBounds: Rect;
  physicalBounds: Rect;
  physicalOrigin: { x: number; y: number };
  scale: number;
}
export interface VirtualDesktopSnapshot {
  dpiAwareness: 'per-monitor-v2';
  monitors: MonitorSnapshot[];
}

const contains = (bounds: Rect, point: { x: number; y: number }): boolean =>
  point.x >= bounds.x && point.x < bounds.x + bounds.width &&
  point.y >= bounds.y && point.y < bounds.y + bounds.height;

export function toPhysicalPoint(desktop: VirtualDesktopSnapshot, point: { x: number; y: number }) {
  if (desktop.dpiAwareness !== 'per-monitor-v2') throw new Error('DPI_AWARENESS_REQUIRED');
  const monitor = desktop.monitors.find(candidate => contains(candidate.logicalBounds, point));
  if (!monitor) throw new Error('COORDINATE_OUTSIDE_VIRTUAL_DESKTOP');
  if (monitor.physicalOrigin.x !== monitor.physicalBounds.x || monitor.physicalOrigin.y !== monitor.physicalBounds.y ||
      monitor.scale <= 0 || monitor.physicalBounds.width <= 0 || monitor.physicalBounds.height <= 0) {
    throw new Error('COORDINATE_PHYSICAL_BOUNDS_INVALID');
  }
  const scaledLocal = {
    x: Math.round((point.x - monitor.logicalBounds.x) * monitor.scale),
    y: Math.round((point.y - monitor.logicalBounds.y) * monitor.scale),
  };
  const physical = {
    x: monitor.physicalOrigin.x + scaledLocal.x,
    y: monitor.physicalOrigin.y + scaledLocal.y,
  };
  if (!contains(monitor.physicalBounds, physical)) throw new Error('COORDINATE_TRANSFORM_INVALID');
  return { monitorId: monitor.id, physicalOrigin: monitor.physicalOrigin, scaledLocal, ...physical };
}
```

The Windows adapter declares process DPI awareness context `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` before any monitor or cursor API call, obtains virtual physical bounds/origins from Windows APIs rather than deriving one global scale, and preserves negative physical coordinates. The only accepted transform is `physical = physicalOrigin + scaledLocal`, where `scaledLocal = round((logicalPoint - logicalBounds.origin) * monitorScale)` and the result must lie inside that monitor's physical bounds.
`src/infrastructure/computer/windowsUiaDriver.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';

type IntegrityLevel = 'low' | 'medium' | 'high' | 'system';
interface ActionBoundary {
  interactive: boolean;
  unlocked: boolean;
  inputDesktop: string;
  runnerIntegrity: IntegrityLevel;
  targetIntegrity: IntegrityLevel;
  protectedUi: boolean;
}
interface UiaPorts {
  inspectBoundary(runtimeId: string): Promise<ActionBoundary>;
  invoke(runtimeId: string): Promise<boolean>;
  select(runtimeId: string): Promise<boolean>;
  coordinateFallback(runtimeId: string): Promise<{ acted: boolean; receiptId: string | null }>;
}
const rank: Record<IntegrityLevel, number> = { low: 0, medium: 1, high: 2, system: 3 };
const blocked = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

export class WindowsUiaDriver {
  constructor(private readonly ports: UiaPorts) {}
  async act(action: { runtimeId: string; action: 'activate' }, _context: unknown, _signal: AbortSignal): Promise<OperationResult<{ acted: true; receiptId: string }>> {
    // Re-run this preflight before every UIA pattern or coordinate action; never cache it for a session.
    const boundary = await this.ports.inspectBoundary(action.runtimeId);
    if (!boundary.interactive) return blocked('UIA_SESSION_NOT_INTERACTIVE');
    if (!boundary.unlocked) return blocked('UIA_SESSION_LOCKED');
    if (boundary.inputDesktop !== 'Default') return blocked('SECURE_DESKTOP_BLOCKED');
    if (boundary.protectedUi) return blocked('UIA_PROTECTED_UI_BLOCKED');
    if (rank[boundary.targetIntegrity] > rank[boundary.runnerIntegrity]) return blocked('UIA_TARGET_INTEGRITY_BLOCKED');
    if (await this.ports.invoke(action.runtimeId)) return { ok: true, value: { acted: true, receiptId: `uia-invoke-${action.runtimeId}` } };

    const beforeSelect = await this.ports.inspectBoundary(action.runtimeId);
    if (!beforeSelect.interactive || !beforeSelect.unlocked || beforeSelect.inputDesktop !== 'Default' ||
        beforeSelect.protectedUi || rank[beforeSelect.targetIntegrity] > rank[beforeSelect.runnerIntegrity]) {
      return blocked(beforeSelect.inputDesktop !== 'Default' ? 'SECURE_DESKTOP_BLOCKED' : 'UIA_COORDINATE_FALLBACK_FORBIDDEN');
    }
    if (await this.ports.select(action.runtimeId)) return { ok: true, value: { acted: true, receiptId: `uia-select-${action.runtimeId}` } };

    // Coordinate fallback is only eligible for ordinary Default-desktop app UI. SecureDesktop/UAC/login/lock/protected/high-integrity failures never reach it.
    const beforeCoordinate = await this.ports.inspectBoundary(action.runtimeId);
    if (!beforeCoordinate.interactive || !beforeCoordinate.unlocked || beforeCoordinate.inputDesktop !== 'Default' ||
        beforeCoordinate.protectedUi || rank[beforeCoordinate.targetIntegrity] > rank[beforeCoordinate.runnerIntegrity]) {
      return blocked('UIA_COORDINATE_FALLBACK_FORBIDDEN');
    }
    const fallback = await this.ports.coordinateFallback(action.runtimeId);
    if (fallback.acted && fallback.receiptId) return { ok: true, value: { acted: true, receiptId: fallback.receiptId } };
    return blocked('UIA_ACTION_NOT_PERFORMED');
  }
}
```

`inspectBoundary()` must obtain the active console/user session and unlock state, open the current input desktop and compare its name exactly to `Default`, inspect target token integrity, and classify protected system UI. Any inability to inspect these values is itself fail-closed. `Winlogon`, `Screen-saver`, credential/UAC secure desktop, login, lock, higher-integrity and protected UI never call `coordinateFallback`.

`src/infrastructure/computer/urlPolicy.ts`

```ts
import { isIP } from 'node:net';
import type { OperationResult } from '../../protocol/results.js';

interface ResolverPort { resolve(hostname: string): Promise<string[]> }
const denyReason = (reason: string): OperationResult<never> => ({
  ok: false,
  error: {
    code: 'BROWSER_URL_POLICY_DENIED',
    message: 'URL is denied by network policy',
    messageKey: 'BROWSER_URL_POLICY_DENIED',
    retryable: false,
    details: { reason },
  },
});
const deniedAddress = (address: string): string | null => {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized.startsWith('::ffff:127.')) return 'loopback';
  if (normalized === '::' || normalized === '0.0.0.0') return 'unspecified';
  if (normalized.startsWith('fe80:') || normalized.startsWith('169.254.')) return 'link-local';
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private';
  if (normalized.startsWith('ff')) return 'multicast';
  if (isIP(normalized) !== 4) return null;
  const [a, b] = normalized.split('.').map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  return null;
};

export class UrlPolicy {
  constructor(private readonly resolver: ResolverPort) {}
  async authorize(value: string): Promise<OperationResult<{ url: string; addresses: string[] }>> {
    let url: URL;
    try { url = new URL(value); } catch { return denyReason('invalid-url'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return denyReason('scheme');
    if (url.username || url.password) return denyReason('userinfo');
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) return denyReason('localhost');
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.resolver.resolve(url.hostname);
    const reason = addresses.length === 0 ? 'dns-empty' : addresses.map(deniedAddress).find(value => value !== null);
    if (reason) return denyReason(reason);
    return { ok: true, value: { url: url.toString(), addresses: [...addresses].sort() } };
  }

  verifyConnectedAddress(authorized: { addresses: string[] }, connectedAddress: string): OperationResult<void> {
    return authorized.addresses.includes(connectedAddress) ? { ok: true, value: undefined } : {
      ok: false,
      error: {
        code: 'BROWSER_DNS_REBINDING_DETECTED',
        message: 'Connected address differs from the authorized DNS result',
        messageKey: 'BROWSER_DNS_REBINDING_DETECTED',
        retryable: false,
        details: { authorized: authorized.addresses, connectedAddress },
      },
    };
  }
}
```

`UrlPolicy.authorize` is called for initial navigation, redirects, every request, form submission, popup, worker script/import, and download. It resolves all A/AAAA answers before connect, rejects loopback/private/link-local/multicast/unspecified addresses, and compares the connected address with the authorized resolution to detect `BROWSER_DNS_REBINDING_DETECTED`.

`playwrightBrowserDriver.ts` creates one `BrowserContext` per logical session with `serviceWorkers: 'block'` and installs `browserContext.route('**/*', ...)` **before** creating or navigating a page. Route authorization covers page, iframe, popup, fetch/XHR, script/module, stylesheet, image, font, media, EventSource, WebSocket handshake, worker/shared-worker and download-producing requests; every redirect hop and popup gets a fresh `UrlPolicy.authorize`, and the route compares the actual connected peer address with the authorized DNS set. Context/page-level routes may only narrow this policy, never bypass it. If the installed Playwright/browser combination cannot block service workers or expose a request class/connected address needed to enforce the boundary, startup returns `BROWSER_SERVICE_WORKER_POLICY_UNSUPPORTED` or `BROWSER_NETWORK_ROUTE_REQUIRED`; it must not run best-effort. No `page.setContent`/`addInitScript`, cached service worker, `route.continue()` branch, data/blob indirection, browser extension or persistent profile may escape the per-session route boundary. The context and all child pages/workers are disposed with that session.

- [ ] **Step 4: run green tests**

```powershell
npm.cmd exec -- vitest run tests/unit/computer/driverContracts.test.ts tests/integration/browserIsolation.test.ts tests/failure/driverFallback.test.ts tests/computer.test.ts
npm.cmd run typecheck
```

Expected: PASS; UIA revalidates interactive/unlocked session, `Default` input desktop, target integrity and protected-UI status before every action; Secure Desktop/UAC/login/lock/high-integrity/protected UI are blocked without coordinate fallback; PMv2 transforms use `physicalOrigin + scaledLocal` within physical bounds; Playwright blocks service workers and routes every network surface; ordinary app fallback still requires both an action receipt and a passed postcondition.

**Commit message when explicitly authorized:** `computer: harden browser UIA and mixed-DPI coordinate drivers`

---

## Task W3-07：Acceptance-driven BuildService 与 staging Plan DAG

**Requirements/Subprojects:** R10、R15、R19；S8

**Files**
- Create: `src/domain/build/acceptance.ts`
- Create: `src/domain/build/planDag.ts`
- Create: `src/domain/build/buildRun.ts`
- Create: `src/application/build/buildService.ts`
- Create: `src/infrastructure/build/workspaceTransaction.ts`
- Create: `src/infrastructure/build/buildProcessAdapter.ts`
- Modify: `src/build/spec.ts`
- Modify: `src/build/plan.ts`
- Modify: `src/build/scaffold.ts`
- Modify: `src/build/verify.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/kernel/tools.ts`
- Modify: `src/commands/intent.ts`
- Create: `tests/unit/build/buildContracts.test.ts`
- Create: `tests/integration/buildService.test.ts`

**Stable failure codes**

- `BUILD_SPEC_INVALID`
- `BUILD_REQUIRED_CRITERION_MISSING`
- `BUILD_VERIFIER_MAPPING_MISSING`
- `BUILD_DAG_CYCLE`
- `BUILD_NODE_FAILED`
- `BUILD_DEPENDENCY_BLOCKED`
- `BUILD_ABORTED`
- `BUILD_PATH_OUTSIDE_WORKSPACE`
- `BUILD_PREVIEW_APPROVAL_REQUIRED`
- `BUILD_STAGING_COMMIT_FAILED`
- `BUILD_STATIC_ENTRY_MISSING`
- `BUILD_OPEN_DOMAIN_UNSUPPORTED`

- [ ] **Step 1: paste the complete red contract test**

`tests/unit/build/buildContracts.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { validateAcceptance } from '../../../src/domain/build/acceptance.js';
import { executePlanDag } from '../../../src/domain/build/planDag.js';

it('rejects required criteria without verifier/evidence fields', () => {
  expect(validateAcceptance([{ id: 'starts', required: true, description: 'server starts' }])).toMatchObject({
    ok: false,
    error: { code: 'BUILD_SPEC_INVALID' },
  });
});

it('executes DAG nodes, blocks dependents, and preserves independent diagnostics', async () => {
  const calls: string[] = [];
  const result = await executePlanDag([
    { id: 'install', dependsOn: [], run: async () => { calls.push('install'); return { ok: true as const, value: undefined }; } },
    { id: 'build', dependsOn: ['install'], run: async () => { calls.push('build'); return { ok: false as const, error: { code: 'BUILD_NODE_FAILED', message: 'build', messageKey: 'BUILD_NODE_FAILED', retryable: false } }; } },
    { id: 'start', dependsOn: ['build'], run: async () => { calls.push('start'); return { ok: true as const, value: undefined }; } },
    { id: 'diagnose', dependsOn: ['install'], run: async () => { calls.push('diagnose'); return { ok: true as const, value: undefined }; } },
  ], AbortSignal.timeout(1_000));

  expect(calls).toEqual(['install', 'build', 'diagnose']);
  expect(result.nodes).toMatchObject({
    build: { status: 'failed', code: 'BUILD_NODE_FAILED' },
    start: { status: 'blocked', code: 'BUILD_DEPENDENCY_BLOCKED' },
    diagnose: { status: 'passed' },
  });
});
```

- [ ] **Step 2: run the red tests**

```powershell
npm.cmd exec -- vitest run tests/unit/build/buildContracts.test.ts tests/integration/buildService.test.ts
```

Expected: FAIL; current acceptance is not a strict structured contract and plan metadata does not drive an executable DAG.

- [ ] **Step 3: paste the complete minimal acceptance and DAG implementation**

`src/domain/build/acceptance.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';
export interface AcceptanceCriterion {
  id: string;
  required: boolean;
  description: string;
  verifierId: string;
  expected: unknown;
  evidenceRequirements: string[];
}
export function validateAcceptance(input: unknown): OperationResult<AcceptanceCriterion[]> {
  if (!Array.isArray(input) || input.length === 0) return invalid();
  const valid = input.every(value => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<AcceptanceCriterion>;
    return typeof item.id === 'string' && item.id.length > 0 &&
      typeof item.required === 'boolean' && typeof item.description === 'string' && item.description.length > 0 &&
      typeof item.verifierId === 'string' && item.verifierId.length > 0 &&
      Object.hasOwn(item, 'expected') && Array.isArray(item.evidenceRequirements);
  });
  return valid ? { ok: true, value: input as AcceptanceCriterion[] } : invalid();
}
const invalid = (): OperationResult<never> => ({
  ok: false,
  error: { code: 'BUILD_SPEC_INVALID', message: 'Acceptance criteria are incomplete', messageKey: 'BUILD_SPEC_INVALID', retryable: false },
});
```

`src/domain/build/planDag.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';
export interface PlanNode { id: string; dependsOn: string[]; run(signal: AbortSignal): Promise<OperationResult<void>> }
export interface NodeResult { status: 'passed' | 'failed' | 'blocked' | 'cancelled'; code?: string }

export async function executePlanDag(nodes: PlanNode[], signal: AbortSignal): Promise<{ nodes: Record<string, NodeResult> }> {
  const pending = new Map(nodes.map(node => [node.id, node]));
  const results: Record<string, NodeResult> = {};
  while (pending.size > 0) {
    let progressed = false;
    for (const [id, node] of [...pending]) {
      if (node.dependsOn.some(dependency => !(dependency in results))) continue;
      progressed = true;
      pending.delete(id);
      if (signal.aborted) { results[id] = { status: 'cancelled', code: 'BUILD_ABORTED' }; continue; }
      if (node.dependsOn.some(dependency => results[dependency]?.status !== 'passed')) {
        results[id] = { status: 'blocked', code: 'BUILD_DEPENDENCY_BLOCKED' };
        continue;
      }
      const result = await node.run(signal);
      results[id] = result.ok ? { status: 'passed' } : { status: 'failed', code: result.error.code };
    }
    if (!progressed) {
      for (const id of pending.keys()) results[id] = { status: 'failed', code: 'BUILD_DAG_CYCLE' };
      break;
    }
  }
  return { nodes: results };
}
```

`BuildService.compileAndRun` creates a safe child staging directory, validates every criterion, maps every criterion to a W3-01 verifier, executes install/build/start/readiness/business-write/stop-and-port-release/restart/business-read/test/evidence/decision nodes, and atomically commits only after all required criteria pass. Existing-project mutations first produce `workspace.diff` and require approval. Unsupported open-domain requests return `BUILD_OPEN_DOMAIN_UNSUPPORTED`; they never fabricate completion. Generated server must serve its static frontend at `/`, otherwise `BUILD_STATIC_ENTRY_MISSING`.

- [ ] **Step 4: run green tests**

```powershell
npm.cmd exec -- vitest run tests/unit/build/buildContracts.test.ts tests/integration/buildService.test.ts tests/build-spec.test.ts tests/commands-intent.test.ts
npm.cmd run typecheck
```

Expected: PASS; dependent nodes block after failure; staging protects the target; every entrypoint delegates to one `BuildService`.

**Commit message when explicitly authorized:** `build: execute strict acceptance plans in staging`

---

## Task W3-08：Build verifiers、重启读回与 Completion integration

**Requirements/Subprojects:** R15、R19；S8/S9

**Files**
- Create: `src/application/quality/buildVerifiers.ts`
- Create: `src/application/build/buildVerificationCoordinator.ts`
- Create: `src/infrastructure/build/httpProbe.ts`
- Create: `src/infrastructure/build/persistenceProbe.ts`
- Modify: `src/application/build/buildService.ts`
- Modify: `src/build/verify.ts`
- Modify: `src/build/evidence.ts`
- Modify: `src/build/gate.ts`
- Create: `tests/integration/buildRestartReadback.test.ts`
- Create: `tests/integration/buildEvidenceDecision.test.ts`
- Create: `tests/failure/buildVerifierFailure.test.ts`

**Stable failure codes**

- `BUILD_PROCESS_NOT_READY`
- `BUILD_PROCESS_DID_NOT_STOP`
- `BUILD_PORT_NOT_RELEASED`
- `BUILD_RESTART_REUSED_OLD_PROCESS`
- `BUILD_READBACK_MISMATCH`
- `BUILD_TEST_SCRIPT_MISSING`
- `BUILD_VERIFIER_FAILED`
- `BUILD_VERIFIER_INCONCLUSIVE`
- `BUILD_VERIFICATION_SNAPSHOT_MISMATCH`
- `BUILD_EVIDENCE_TAMPERED`

- [ ] **Step 1: paste the complete red restart/read-back test**

`tests/integration/buildRestartReadback.test.ts`

```ts
import { expect, it, vi } from 'vitest';
import { BuildVerificationCoordinator } from '../../src/application/build/buildVerificationCoordinator.js';

it('writes data, proves stop and port release, starts a new process, and reads the same data back', async () => {
  const events: string[] = [];
  let pid = 100;
  const runtime = {
    start: vi.fn(async () => ({ processId: ++pid, port: 43123, stdoutRef: `stdout-${pid}`, stderrRef: `stderr-${pid}` })),
    ready: vi.fn(async (processId: number) => { events.push(`ready:${processId}`); return true; }),
    stopTree: vi.fn(async (processId: number) => { events.push(`stop:${processId}`); return true; }),
    portReleased: vi.fn(async () => { events.push('port-released'); return true; }),
  };
  const persistence = {
    seed: vi.fn(async () => ({ token: 'row-7', expected: { name: 'persisted' } })),
    readBack: vi.fn(async () => ({ name: 'persisted' })),
  };
  const coordinator = new BuildVerificationCoordinator(runtime, persistence);
  const result = await coordinator.verifyRestart({ runId: 'run-build', artifactHash: 'a'.repeat(64), verificationId: 'verification-1' }, AbortSignal.timeout(1_000));

  expect(result).toMatchObject({ ok: true, value: { firstProcessId: 101, secondProcessId: 102 } });
  expect(events).toEqual(['ready:101', 'stop:101', 'port-released', 'ready:102']);
  expect(persistence.readBack).toHaveBeenCalledWith(102, { token: 'row-7', expected: { name: 'persisted' } }, expect.any(AbortSignal));
});

it('rejects an old process reused by the second probe', async () => {
  const runtime = {
    start: vi.fn(async () => ({ processId: 100, port: 43123, stdoutRef: 'o', stderrRef: 'e' })),
    ready: vi.fn(async () => true),
    stopTree: vi.fn(async () => true),
    portReleased: vi.fn(async () => true),
  };
  const persistence = { seed: vi.fn(async () => ({ token: 't', expected: 1 })), readBack: vi.fn(async () => 1) };
  await expect(new BuildVerificationCoordinator(runtime, persistence).verifyRestart({
    runId: 'r', artifactHash: 'b'.repeat(64), verificationId: 'v',
  }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    ok: false,
    error: { code: 'BUILD_RESTART_REUSED_OLD_PROCESS' },
  });
});
```

- [ ] **Step 2: run the red tests**

```powershell
npm.cmd exec -- vitest run tests/integration/buildRestartReadback.test.ts tests/integration/buildEvidenceDecision.test.ts tests/failure/buildVerifierFailure.test.ts
```

Expected: FAIL; current verification cannot prove process replacement, port release, immutable verification identity, or real business read-back.

- [ ] **Step 3: paste the complete minimal coordinator**

`src/application/build/buildVerificationCoordinator.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';
interface RuntimePort {
  start(signal: AbortSignal): Promise<{ processId: number; port: number; stdoutRef: string; stderrRef: string }>;
  ready(processId: number, signal: AbortSignal): Promise<boolean>;
  stopTree(processId: number, signal: AbortSignal): Promise<boolean>;
  portReleased(port: number, signal: AbortSignal): Promise<boolean>;
}
interface PersistencePort {
  seed(processId: number, signal: AbortSignal): Promise<{ token: string; expected: unknown }>;
  readBack(processId: number, token: { token: string; expected: unknown }, signal: AbortSignal): Promise<unknown>;
}
const fail = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

export class BuildVerificationCoordinator {
  constructor(private readonly runtime: RuntimePort, private readonly persistence: PersistencePort) {}
  async verifyRestart(snapshot: { runId: string; artifactHash: string; verificationId: string }, signal: AbortSignal): Promise<OperationResult<{
    firstProcessId: number; secondProcessId: number; attachmentRefs: string[]; snapshot: typeof snapshot;
  }>> {
    const first = await this.runtime.start(signal);
    if (!await this.runtime.ready(first.processId, signal)) return fail('BUILD_PROCESS_NOT_READY');
    const token = await this.persistence.seed(first.processId, signal);
    if (!await this.runtime.stopTree(first.processId, signal)) return fail('BUILD_PROCESS_DID_NOT_STOP');
    if (!await this.runtime.portReleased(first.port, signal)) return fail('BUILD_PORT_NOT_RELEASED');
    const second = await this.runtime.start(signal);
    if (second.processId === first.processId) return fail('BUILD_RESTART_REUSED_OLD_PROCESS');
    if (!await this.runtime.ready(second.processId, signal)) return fail('BUILD_PROCESS_NOT_READY');
    const observed = await this.persistence.readBack(second.processId, token, signal);
    if (JSON.stringify(observed) !== JSON.stringify(token.expected)) return fail('BUILD_READBACK_MISMATCH');
    return { ok: true, value: {
      firstProcessId: first.processId,
      secondProcessId: second.processId,
      attachmentRefs: [first.stdoutRef, first.stderrRef, second.stdoutRef, second.stderrRef],
      snapshot,
    } };
  }
}
```

A single immutable `{ runId, artifactHash, verificationId, environmentSnapshotId, capabilitySnapshotId, policySnapshotId }` is created before the first verifier and supplied to every W3-01 verifier, evidence record, and `CompletionGate`. Missing required test script maps to `incomplete/BUILD_TEST_SCRIPT_MISSING`; build/test assertion failure maps to `failed/BUILD_VERIFIER_FAILED`; crash maps to `inconclusive/BUILD_VERIFIER_INCONCLUSIVE`; any snapshot mismatch maps to `BUILD_VERIFICATION_SNAPSHOT_MISMATCH`.

- [ ] **Step 4: run green tests**

```powershell
npm.cmd exec -- vitest run tests/integration/buildRestartReadback.test.ts tests/integration/buildEvidenceDecision.test.ts tests/failure/buildVerifierFailure.test.ts tests/integration/evidenceAuthorityConflict.test.ts
npm.cmd run typecheck
```

Expected: PASS; the second probe has a different process ID; stdout/stderr/port/process metadata are evidence attachments; tamper blocks Gate G.

**Commit message when explicitly authorized:** `quality: verify build persistence across real process restarts`

---

## Task W3-09：跨平台 PTY Domain、Application port 与 node-pty adapter

**Requirements/Subprojects:** R10、R11、R15、R17；Terminal runtime

**Files**
- Create: `src/domain/pty/pty.ts`
- Create: `src/application/pty/ptyService.ts`
- Create: `src/infrastructure/pty/nodePtyAdapter.ts`
- Create: `src/infrastructure/pty/platformShell.ts`
- Modify: `src/application/applicationServices.ts`
- Modify: `src/bootstrap/createApplication.ts`
- Modify: `src/presentation/cli/cliGatewayAdapter.ts`
- Modify: `src/presentation/wire/wireGatewayAdapter.ts`
- Modify: `src/presentation/http/httpGatewayAdapter.ts`
- Modify: `src/presentation/tui/inProcessGatewayAdapter.ts`
- Modify: `package.json`
- Create: `tests/contract/pty.contract.test.ts`
- Create: `tests/failure/ptyLifecycle.test.ts`

**Stable failure codes**

- `PTY_UNSUPPORTED_PLATFORM`
- `PTY_SPAWN_FAILED`
- `PTY_INVALID_SIZE`
- `PTY_STDIN_AFTER_EXIT`
- `PTY_TIMEOUT`
- `PTY_ABORTED`
- `PTY_PROCESS_TREE_STILL_RUNNING`
- `PTY_EXIT_MISSING`

- [ ] **Step 1: paste the complete PTY red contract test**

`tests/contract/pty.contract.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { NodePtyAdapter } from '../../src/infrastructure/pty/nodePtyAdapter.js';
import { defaultShellFor } from '../../src/infrastructure/pty/platformShell.js';

class FakePty {
  pid = 77;
  writes: string[] = [];
  sizes: Array<[number, number]> = [];
  dataHandler: (data: string) => void = () => undefined;
  exitHandler: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.exitHandler({ exitCode: 130 }); }
  onData(handler: (data: string) => void) { this.dataHandler = handler; return { dispose() {} }; }
  onExit(handler: (event: { exitCode: number; signal?: number }) => void) { this.exitHandler = handler; return { dispose() {} }; }
}

describe.each([
  ['win32', 'powershell.exe'],
  ['linux', '/bin/bash'],
  ['darwin', '/bin/zsh'],
] as const)('%s node-pty contract', (platform, expectedShell) => {
  it('supports stdin, output, resize, exit, timeout/abort tree termination, and platform shell selection', async () => {
    expect(defaultShellFor(platform, {})).toBe(expectedShell);
    const fake = new FakePty();
    const spawn = vi.fn(() => fake);
    const terminateTree = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const adapter = new NodePtyAdapter({ spawn, terminateTree, platform });
    const controller = new AbortController();
    const opened = await adapter.open({ executable: expectedShell, argv: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, timeoutMs: 10_000 }, controller.signal);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const output: string[] = [];
    opened.value.onData(data => output.push(data));
    opened.value.write('dir\r');
    opened.value.resize(120, 40);
    fake.dataHandler('ready');
    fake.exitHandler({ exitCode: 0 });
    await expect(opened.value.wait()).resolves.toEqual({ exitCode: 0, signal: null, reason: 'exit' });
    expect(fake.writes).toEqual(['dir\r']);
    expect(fake.sizes).toEqual([[120, 40]]);
    expect(output).toEqual(['ready']);

    const second = await adapter.open({ executable: expectedShell, argv: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, timeoutMs: 10_000 }, controller.signal);
    expect(second.ok).toBe(true);
    controller.abort();
    await Promise.resolve();
    expect(terminateTree).toHaveBeenCalledWith(77, 5_000);
  });
});

it('rejects invalid resize values', async () => {
  const fake = new FakePty();
  const adapter = new NodePtyAdapter({ spawn: () => fake, terminateTree: vi.fn(), platform: 'win32' });
  const opened = await adapter.open({ executable: 'powershell.exe', argv: [], cwd: process.cwd(), env: {}, cols: 80, rows: 24, timeoutMs: 100 }, AbortSignal.timeout(1_000));
  expect(opened.ok).toBe(true);
  if (opened.ok) expect(() => opened.value.resize(0, 24)).toThrowError('PTY_INVALID_SIZE');
});
```

- [ ] **Step 2: run the red tests**

```powershell
npm.cmd exec -- vitest run tests/contract/pty.contract.test.ts tests/failure/ptyLifecycle.test.ts
```

Expected: FAIL because no Domain/Application PTY port or node-pty lifecycle adapter exists.

- [ ] **Step 3: paste the complete minimal PTY contract and adapter**

`src/domain/pty/pty.ts`

```ts
import type { OperationResult } from '../../protocol/results.js';
export interface PtyOpenRequest {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  timeoutMs: number;
}
export interface PtyExit { exitCode: number | null; signal: number | null; reason: 'exit' | 'timeout' | 'abort' }
export interface PtySessionPort {
  readonly processId: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): () => void;
  wait(): Promise<PtyExit>;
  close(): Promise<OperationResult<void>>;
}
export interface PtyPort { open(request: PtyOpenRequest, signal: AbortSignal): Promise<OperationResult<PtySessionPort>> }
```

`src/infrastructure/pty/platformShell.ts`

```ts
export function defaultShellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return env.COMSPEC?.toLowerCase().endsWith('cmd.exe') ? 'powershell.exe' : 'powershell.exe';
  if (platform === 'linux') return env.SHELL || '/bin/bash';
  if (platform === 'darwin') return env.SHELL || '/bin/zsh';
  throw new Error('PTY_UNSUPPORTED_PLATFORM');
}
```

`src/infrastructure/pty/nodePtyAdapter.ts`

```ts
import type { IPty } from 'node-pty';
import type { OperationResult } from '../../protocol/results.js';
import type { PtyOpenRequest, PtyPort, PtySessionPort, PtyExit } from '../../domain/pty/pty.js';

interface Factory {
  spawn(file: string, args: string[], options: Record<string, unknown>): IPty;
  terminateTree(processId: number, deadlineMs: number): Promise<OperationResult<void>>;
  platform: NodeJS.Platform;
}
const failure = (code: string): OperationResult<never> => ({
  ok: false, error: { code, message: code, messageKey: code, retryable: false },
});

export class NodePtyAdapter implements PtyPort {
  constructor(private readonly factory: Factory) {}
  async open(request: PtyOpenRequest, signal: AbortSignal): Promise<OperationResult<PtySessionPort>> {
    if (request.cols < 1 || request.rows < 1) return failure('PTY_INVALID_SIZE');
    let pty: IPty;
    try {
      pty = this.factory.spawn(request.executable, request.argv, {
        cwd: request.cwd, env: request.env, cols: request.cols, rows: request.rows,
        name: 'xterm-256color', useConpty: this.factory.platform === 'win32',
      });
    } catch { return failure('PTY_SPAWN_FAILED'); }

    let exited = false;
    let resolveExit!: (value: PtyExit) => void;
    const exitPromise = new Promise<PtyExit>(resolve => { resolveExit = resolve; });
    const exitDisposable = pty.onExit(event => {
      if (exited) return;
      exited = true;
      resolveExit({ exitCode: event.exitCode, signal: event.signal ?? null, reason: 'exit' });
    });
    const finish = async (reason: 'timeout' | 'abort') => {
      if (exited) return;
      const stopped = await this.factory.terminateTree(pty.pid, 5_000);
      if (!stopped.ok) { resolveExit({ exitCode: null, signal: null, reason }); return; }
      exited = true;
      resolveExit({ exitCode: reason === 'abort' ? 130 : null, signal: null, reason });
    };
    const timer = setTimeout(() => void finish('timeout'), request.timeoutMs);
    signal.addEventListener('abort', () => void finish('abort'), { once: true });

    const session: PtySessionPort = {
      processId: pty.pid,
      write(data) { if (exited) throw new Error('PTY_STDIN_AFTER_EXIT'); pty.write(data); },
      resize(cols, rows) { if (cols < 1 || rows < 1) throw new Error('PTY_INVALID_SIZE'); pty.resize(cols, rows); },
      onData(handler) { const disposable = pty.onData(handler); return () => disposable.dispose(); },
      async wait() { const value = await exitPromise; clearTimeout(timer); exitDisposable.dispose(); return value; },
      async close() { await finish('abort'); return { ok: true, value: undefined }; },
    };
    return { ok: true, value: session };
  }
}
```

`package.json` must retain dependency `"node-pty": "^1.1.0"` and add the exact script:

```json
{
  "scripts": {
    "test:pty-contract": "vitest run tests/contract/pty.contract.test.ts tests/failure/ptyLifecycle.test.ts"
  }
}
```

- [ ] **Step 4: run green tests**

```powershell
npm.cmd run test:pty-contract
npm.cmd run typecheck
```

Expected: PASS on mocked Win/Linux/mac contracts; real timeout/Abort always invokes process-tree termination; resize and stdin after exit use stable failures.

**Commit message when explicitly authorized:** `terminal: add cancellable cross-platform node-pty service`

---

## Task W3-10：受控 self-hosted interactive Windows 真实验收

**Requirements/Subprojects:** R07、R08、R15、R17；S6-S9；Gate E/F/G

**Files**
- Create: `src/release/windowsAcceptanceContract.ts`
- Create: `tests/contract/windowsRunnerProvisioning.contract.test.ts`
- Create: `tests/acceptance/windows/preflight.ps1`
- Create: `tests/acceptance/windows/voice.ps1`
- Create: `tests/acceptance/windows/browser.ps1`
- Create: `tests/acceptance/windows/uia.ps1`
- Create: `tests/acceptance/windows/computer-multimonitor.ps1`
- Create: `tests/acceptance/windows/emergency-stop.ps1`
- Create: `tests/acceptance/windows/build-restart-readback.ps1`
- Create: `tests/fixtures/windows/uia/fixtures.generator.lock.json`
- Create: `tests/fixtures/windows/uia/generate-fixtures.mjs`
- Create: `tests/fixtures/windows/uia/fixtures.lock.json`
- Create: `tests/fixtures/windows/uia/build-fixtures.ps1`
- Generate: `tests/fixtures/windows/uia/win32/WxNodus.Win32Fixture.csproj`
- Generate: `tests/fixtures/windows/uia/win32/Program.cs`
- Generate: `tests/fixtures/windows/uia/wpf/WxNodus.WpfFixture.csproj`
- Generate: `tests/fixtures/windows/uia/wpf/App.xaml`
- Generate: `tests/fixtures/windows/uia/wpf/App.xaml.cs`
- Generate: `tests/fixtures/windows/uia/wpf/MainWindow.xaml`
- Generate: `tests/fixtures/windows/uia/wpf/MainWindow.xaml.cs`
- Generate: `tests/fixtures/windows/uia/winui/WxNodus.WinUiFixture.csproj`
- Generate: `tests/fixtures/windows/uia/winui/Package.appxmanifest`
- Generate: `tests/fixtures/windows/uia/winui/App.xaml`
- Generate: `tests/fixtures/windows/uia/winui/App.xaml.cs`
- Generate: `tests/fixtures/windows/uia/winui/MainWindow.xaml`
- Generate: `tests/fixtures/windows/uia/winui/MainWindow.xaml.cs`
- Generate: `tests/fixtures/windows/uia/electron/package.json`
- Generate: `tests/fixtures/windows/uia/electron/package-lock.json`
- Generate: `tests/fixtures/windows/uia/electron/main.cjs`
- Generate: `tests/fixtures/windows/uia/electron/preload.cjs`
- Generate: `tests/fixtures/windows/uia/electron/index.html`
- Create: `scripts/windows-runner.contract.json`
- Create: `scripts/provision-windows-runner.ps1`
- Create: `scripts/run-windows-acceptance.mjs`
- Modify: `package.json`

**Runner provisioning and Gate E receipt contract**

- Runner labels: `self-hosted`, `windows`, `x64`, `interactive`, and exactly one of `win10-22h2` or `win11-24h2`.
- Gate E has two required OS-keyed cells and immutable receipt keys: `windows-11-24h2-production-real` is the production-real cell; `windows-10-22h2-legacy-compatibility` is the legacy-compatibility receipt. Windows 10 is never labeled production-real, and Windows 11 cannot stand in for its compatibility receipt.
- Win10 baseline: version `10.0.19045`; Win11 baseline: version `10.0.26100` or newer within the Win11 24H2 servicing line.
- Session must be interactive and unlocked, with input desktop exactly `Default`; service/session-0, login, lock, UAC/Secure Desktop, or an uninspectable desktop is blocked.
- Each receipt binds `receiptId`, `receiptKey`, `runId`, `candidateCommit`, `artifactId`, `artifactSha256`, exact runner labels/id/image, OS family/version/build, Node.js version, architecture, environment snapshot/hash, capability snapshot/hash, selected physical MMDevice endpoint, SAPI voices/playback result, monitor physical bounds/origins/scales, fixture lock hash, per-fixture source/artifact hashes, scenario IDs/results/attachment IDs, timestamp and manifest SHA-256. Receipt and all attachments are immutable/closed W3-01 evidence.
- A real input endpoint from Windows MMDevice must be active; loopback-only or synthetic-only audio does not satisfy the microphone prerequisite.
- `System.Speech` must enumerate at least one installed SAPI voice and must complete an audible-device playback probe.
- At least two physical displays are required; the virtual desktop must include a negative physical origin; at least two displays must have different DPI scale factors and PMv2 must be active.
- Both OS cells run the same locked fixture generator contract and verify Win32/WPF/WinUI/Electron source and built artifact hashes before UIA scenarios.
- `GateE.aggregate()` receives both receipts at once, keys them by `receiptKey`, rejects duplicates/cross-OS substitutions, verifies their candidate commit/artifact equality, full evidence closure and environment/runner/mic/SAPI/multimonitor/fixtures fields, and returns `blocked/WINDOWS_REQUIRED_RECEIPT_MISSING` when either required key is absent.
- Missing microphone, SAPI, interactive `Default` desktop, second display, negative origin, mixed DPI, PMv2, fixture verification, or required receipt returns `blocked/WINDOWS_PHYSICAL_PRECONDITION_BLOCKED` or `blocked/WINDOWS_REQUIRED_RECEIPT_MISSING`; Gate E must not convert it to passed or ordinary failed.

**Stable failure codes**

- `WINDOWS_RUNNER_NOT_SELF_HOSTED`
- `WINDOWS_INTERACTIVE_SESSION_REQUIRED`
- `WINDOWS_OS_BASELINE_UNSUPPORTED`
- `WINDOWS_MICROPHONE_REQUIRED`
- `WINDOWS_SAPI_REQUIRED`
- `WINDOWS_MULTIMONITOR_REQUIRED`
- `WINDOWS_NEGATIVE_ORIGIN_REQUIRED`
- `WINDOWS_MIXED_DPI_REQUIRED`
- `WINDOWS_PHYSICAL_PRECONDITION_BLOCKED`
- `WINDOWS_FIXTURE_LOCK_INVALID`
- `WINDOWS_FIXTURE_SOURCE_HASH_MISMATCH`
- `WINDOWS_FIXTURE_ARTIFACT_HASH_MISMATCH`
- `WINDOWS_REQUIRED_RECEIPT_MISSING`
- `WINDOWS_RECEIPT_KEY_MISMATCH`
- `WINDOWS_RECEIPT_CANDIDATE_MISMATCH`
- `WINDOWS_RECEIPT_NOT_CLOSED`
- `WINDOWS_ACCEPTANCE_SCENARIO_FAILED`

- [ ] **Step 1: paste the complete red provisioning contract test**

`tests/contract/windowsRunnerProvisioning.contract.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { aggregateGateEReceipts, evaluateWindowsRunner } from '../../src/release/windowsAcceptanceContract.js';

const healthy = {
  selfHosted: true,
  labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win11-24h2'],
  interactive: true,
  unlocked: true,
  inputDesktop: 'Default',
  sessionId: 2,
  os: { family: 'win11' as const, version: '10.0.26100' },
  node: { version: '22.14.0', arch: 'x64' },
  candidateCommit: 'commit-w3-candidate',
  artifact: { id: 'artifact-w3', sha256: 'a'.repeat(64) },
  environment: { snapshotId: 'env-win11', sha256: 'b'.repeat(64) },
  capability: { snapshotId: 'cap-win11', sha256: 'c'.repeat(64) },
  microphones: [{ id: 'mmdevice-1', active: true, physical: true }],
  sapiVoices: ['Microsoft Huihui Desktop'],
  sapiPlaybackPassed: true,
  fixtures: { lockSha256: 'd'.repeat(64), sourceHashesValid: true, artifactHashesValid: true },
  monitors: [
    { id: 'left', x: -1920, y: 0, width: 1920, height: 1080, scale: 1, physical: true },
    { id: 'main', x: 0, y: 0, width: 2560, height: 1440, scale: 1.5, physical: true },
  ],
};

const receipt = (receiptKey: 'windows-11-24h2-production-real' | 'windows-10-22h2-legacy-compatibility', patch = {}) => ({
  receiptId: `receipt-${receiptKey}`,
  receiptKey,
  runId: 'run-w3-e',
  candidateCommit: healthy.candidateCommit,
  artifact: healthy.artifact,
  environment: healthy.environment,
  capability: healthy.capability,
  runner: healthy,
  fixtures: healthy.fixtures,
  scenarios: [{ id: 'preflight', status: 'passed', attachmentIds: ['scenario-preflight'] }],
  closure: { status: 'closed' as const },
  manifestSha256: 'e'.repeat(64),
  ...patch,
});

describe('controlled Windows runner', () => {
  it('accepts the required physical Win11 shape', () => {
    expect(evaluateWindowsRunner(healthy)).toEqual({ status: 'passed' });
  });

  it.each([
    ['microphone', { microphones: [] }],
    ['SAPI', { sapiVoices: [] }],
    ['second monitor', { monitors: healthy.monitors.slice(1) }],
    ['negative origin', { monitors: healthy.monitors.map(monitor => ({ ...monitor, x: Math.max(0, monitor.x) })) }],
    ['mixed DPI', { monitors: healthy.monitors.map(monitor => ({ ...monitor, scale: 1 })) }],
  ])('blocks Gate E when %s is missing', (_name, patch) => {
    expect(evaluateWindowsRunner({ ...healthy, ...patch })).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED',
    });
  });

  it('accepts controlled Win10 22H2 only as legacy compatibility', () => {
    expect(evaluateWindowsRunner({
      ...healthy,
      labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win10-22h2'],
      os: { family: 'win10', version: '10.0.19045' },
    })).toEqual({ status: 'passed' });
  });

  it('requires OS-keyed immutable receipts for production-real Win11 and legacy-compatible Win10', () => {
    const win11 = receipt('windows-11-24h2-production-real');
    const win10Runner = {
      ...healthy,
      labels: ['self-hosted', 'windows', 'x64', 'interactive', 'win10-22h2'],
      os: { family: 'win10' as const, version: '10.0.19045' },
      environment: { snapshotId: 'env-win10', sha256: 'f'.repeat(64) },
    };
    const win10 = receipt('windows-10-22h2-legacy-compatibility', {
      runner: win10Runner,
      environment: win10Runner.environment,
    });
    expect(aggregateGateEReceipts([win11, win10])).toMatchObject({
      status: 'passed',
      receiptIds: [win11.receiptId, win10.receiptId],
    });
    expect(aggregateGateEReceipts([win11])).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_REQUIRED_RECEIPT_MISSING',
      missing: ['windows-10-22h2-legacy-compatibility'],
    });
    expect(aggregateGateEReceipts([win10])).toMatchObject({
      status: 'blocked',
      code: 'WINDOWS_REQUIRED_RECEIPT_MISSING',
      missing: ['windows-11-24h2-production-real'],
    });
  });
});
```

- [ ] **Step 2: run the red contract test**

```powershell
npm.cmd exec -- vitest run tests/contract/windowsRunnerProvisioning.contract.test.ts
```

Expected: FAIL because the controlled runner contract and blocked semantics do not exist.

- [ ] **Step 3: paste the complete minimal runner evaluator**

`src/release/windowsAcceptanceContract.ts`

```ts
export interface WindowsRunnerSnapshot {
  selfHosted: boolean;
  labels: string[];
  interactive: boolean;
  unlocked: boolean;
  inputDesktop: string;
  sessionId: number;
  os: { family: 'win10' | 'win11'; version: string };
  node: { version: string; arch: 'x64' };
  candidateCommit: string;
  artifact: { id: string; sha256: string };
  environment: { snapshotId: string; sha256: string };
  capability: { snapshotId: string; sha256: string };
  microphones: Array<{ id: string; active: boolean; physical: boolean }>;
  sapiVoices: string[];
  sapiPlaybackPassed: boolean;
  fixtures: { lockSha256: string; sourceHashesValid: boolean; artifactHashesValid: boolean };
  monitors: Array<{ id: string; x: number; y: number; width: number; height: number; scale: number; physical: boolean }>;
}
export type WindowsRunnerDecision = { status: 'passed' } | {
  status: 'blocked';
  code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED';
  missing: string[];
};

export type WindowsReceiptKey =
  | 'windows-11-24h2-production-real'
  | 'windows-10-22h2-legacy-compatibility';
export interface WindowsAcceptanceReceipt {
  receiptId: string;
  receiptKey: WindowsReceiptKey;
  runId: string;
  candidateCommit: string;
  artifact: { id: string; sha256: string };
  environment: { snapshotId: string; sha256: string };
  capability: { snapshotId: string; sha256: string };
  runner: WindowsRunnerSnapshot;
  fixtures: { lockSha256: string; sourceHashesValid: boolean; artifactHashesValid: boolean };
  scenarios: Array<{ id: string; status: 'passed' | 'failed' | 'blocked'; attachmentIds: string[] }>;
  closure: { status: 'closed' };
  manifestSha256: string;
}

const receiptKeyMatchesRunner = (receipt: WindowsAcceptanceReceipt): boolean =>
  receipt.receiptKey === 'windows-11-24h2-production-real'
    ? receipt.runner.os.family === 'win11' && receipt.runner.labels.includes('win11-24h2')
    : receipt.runner.os.family === 'win10' && receipt.runner.labels.includes('win10-22h2');

export function aggregateGateEReceipts(receipts: readonly WindowsAcceptanceReceipt[]) {
  const required: WindowsReceiptKey[] = [
    'windows-11-24h2-production-real',
    'windows-10-22h2-legacy-compatibility',
  ];
  const byKey = new Map(receipts.map(receipt => [receipt.receiptKey, receipt]));
  const missing = required.filter(key => !byKey.has(key));
  if (missing.length > 0 || byKey.size !== receipts.length) return {
    status: 'blocked' as const, code: 'WINDOWS_REQUIRED_RECEIPT_MISSING', missing,
  };
  const values = required.map(key => byKey.get(key)!);
  if (values.some(receipt => receipt.closure.status !== 'closed' || !/^[a-f0-9]{64}$/.test(receipt.manifestSha256))) {
    return { status: 'blocked' as const, code: 'WINDOWS_RECEIPT_NOT_CLOSED' };
  }
  if (values.some(receipt => !receiptKeyMatchesRunner(receipt) || evaluateWindowsRunner(receipt.runner).status !== 'passed')) {
    return { status: 'blocked' as const, code: 'WINDOWS_RECEIPT_KEY_MISMATCH' };
  }
  const [first, ...rest] = values;
  if (rest.some(receipt => receipt.runId !== first.runId || receipt.candidateCommit !== first.candidateCommit ||
      receipt.artifact.id !== first.artifact.id || receipt.artifact.sha256 !== first.artifact.sha256)) {
    return { status: 'blocked' as const, code: 'WINDOWS_RECEIPT_CANDIDATE_MISMATCH' };
  }
  if (values.some(receipt => !receipt.fixtures.sourceHashesValid || !receipt.fixtures.artifactHashesValid ||
      receipt.scenarios.some(scenario => scenario.status !== 'passed' || scenario.attachmentIds.length === 0))) {
    return { status: 'blocked' as const, code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED' };
  }
  return { status: 'passed' as const, receiptIds: values.map(receipt => receipt.receiptId) };
}

export function evaluateWindowsRunner(snapshot: WindowsRunnerSnapshot): WindowsRunnerDecision {
  const missing: string[] = [];
  if (!snapshot.selfHosted || !snapshot.labels.includes('self-hosted') || !snapshot.labels.includes('windows') ||
      !snapshot.labels.includes('x64') || !snapshot.labels.includes('interactive')) missing.push('WINDOWS_RUNNER_NOT_SELF_HOSTED');
  const osLabels = snapshot.labels.filter(label => label === 'win10-22h2' || label === 'win11-24h2');
  if (osLabels.length !== 1) missing.push('WINDOWS_OS_BASELINE_UNSUPPORTED');
  if (!snapshot.interactive || !snapshot.unlocked || snapshot.sessionId <= 0 || snapshot.inputDesktop !== 'Default') missing.push('WINDOWS_INTERACTIVE_SESSION_REQUIRED');
  if (!snapshot.node.version.startsWith('22.') || snapshot.node.arch !== 'x64' ||
      !/^[a-f0-9]{64}$/.test(snapshot.artifact.sha256) ||
      !/^[a-f0-9]{64}$/.test(snapshot.environment.sha256) ||
      !/^[a-f0-9]{64}$/.test(snapshot.capability.sha256)) missing.push('WINDOWS_RUNNER_NOT_SELF_HOSTED');
  const build = Number(snapshot.os.version.split('.')[2]);
  const baseline = snapshot.os.family === 'win10'
    ? build === 19045 && osLabels[0] === 'win10-22h2'
    : build === 26100 && osLabels[0] === 'win11-24h2';
  if (!baseline) missing.push('WINDOWS_OS_BASELINE_UNSUPPORTED');
  if (!snapshot.microphones.some(device => device.active && device.physical)) missing.push('WINDOWS_MICROPHONE_REQUIRED');
  if (snapshot.sapiVoices.length === 0 || !snapshot.sapiPlaybackPassed) missing.push('WINDOWS_SAPI_REQUIRED');
  if (!snapshot.fixtures.sourceHashesValid || !snapshot.fixtures.artifactHashesValid || !/^[a-f0-9]{64}$/.test(snapshot.fixtures.lockSha256)) missing.push('WINDOWS_FIXTURE_LOCK_INVALID');
  const physicalMonitors = snapshot.monitors.filter(monitor => monitor.physical);
  if (physicalMonitors.length < 2) missing.push('WINDOWS_MULTIMONITOR_REQUIRED');
  if (physicalMonitors.length === 0 || Math.min(...physicalMonitors.map(monitor => monitor.x)) >= 0) missing.push('WINDOWS_NEGATIVE_ORIGIN_REQUIRED');
  if (new Set(physicalMonitors.map(monitor => monitor.scale)).size < 2) missing.push('WINDOWS_MIXED_DPI_REQUIRED');
  return missing.length === 0 ? { status: 'passed' } : {
    status: 'blocked', code: 'WINDOWS_PHYSICAL_PRECONDITION_BLOCKED', missing,
  };
}
```

- [ ] **Step 4: implement the locked fixture generator, lock generated outputs, and implement the acceptance runner**

The fixture source tree is **generated, not falsely claimed to be hand-authored line by line**. `tests/fixtures/windows/uia/generate-fixtures.mjs` is the only source of the Win32/WPF/WinUI/Electron isomorphic fixtures, and `tests/fixtures/windows/uia/fixtures.generator.lock.json` locks its generator version and SHA-256. Generator contract:

```json
{
  "schemaVersion": 1,
  "generator": {
    "id": "wxnodus-uia-isomorphic-fixture-generator",
    "version": "1.0.0",
    "entrypoint": "tests/fixtures/windows/uia/generate-fixtures.mjs",
    "sha256": "<full lowercase 64-hex hash written only after the generator is reviewed>"
  },
  "targets": ["win32", "wpf", "winui", "electron"],
  "model": {
    "windowTitle": "WxNodus UIA Fixture",
    "controls": [
      { "automationId": "invoke", "type": "button", "patterns": ["Invoke"] },
      { "automationId": "selection", "type": "list", "patterns": ["Selection"] },
      { "automationId": "value", "type": "textbox", "patterns": ["Value"] },
      { "automationId": "status", "type": "text", "patterns": [] }
    ],
    "transitions": ["invoke->invoked", "selection:item-2->selected:item-2", "value:text->value:text"]
  }
}
```

The generator must be deterministic under Node.js 22+: canonical UTF-8/LF, sorted path order, no timestamps/absolute paths/random values, exact target file allowlist, and byte-identical output on a second clean generation. It renders the same automation IDs, labels, state transitions and expected UIA patterns for all four frameworks while allowing framework-specific bootstrap files. `build-fixtures.ps1 -VerifyLock` first verifies the generator hash, generates into a clean temp directory, compares every generated byte/path against the checked-in generated tree (no missing or extra paths), then builds and verifies the output lock. `-WriteLock` is a deliberate maintainer-only refresh of both generator/output hashes; CI never passes it. This contract is the complete source specification required by the plan; the implementation task need not pretend the generated project files were all manually pasted here.

`tests/fixtures/windows/uia/fixtures.lock.json` is the committed generated-output/build lock. The following shows its required shape and exact IDs/build commands; hash fields are deliberately `<computed-by-locked-generator>` in the **plan** and must be replaced by real 64-hex values produced after implementing/reviewing the locked generator, never copied as invented hashes:

```json
{
  "schemaVersion": 1,
  "fixtures": [
    { "id": "win32", "version": "1.0.0", "source": "tests/fixtures/windows/uia/win32", "build": "dotnet publish tests/fixtures/windows/uia/win32/WxNodus.Win32Fixture.csproj -c Release --no-restore", "sourceSha256": "<computed-by-locked-generator>", "artifact": "tests/fixtures/windows/uia/win32/bin/Release/net8.0-windows/publish/WxNodus.Win32Fixture.exe", "artifactSha256": "<computed-after-build>" },
    { "id": "wpf", "version": "1.0.0", "source": "tests/fixtures/windows/uia/wpf", "build": "dotnet publish tests/fixtures/windows/uia/wpf/WxNodus.WpfFixture.csproj -c Release --no-restore", "sourceSha256": "<computed-by-locked-generator>", "artifact": "tests/fixtures/windows/uia/wpf/bin/Release/net8.0-windows/publish/WxNodus.WpfFixture.exe", "artifactSha256": "<computed-after-build>" },
    { "id": "winui", "version": "1.0.0", "source": "tests/fixtures/windows/uia/winui", "build": "dotnet publish tests/fixtures/windows/uia/winui/WxNodus.WinUiFixture.csproj -c Release --no-restore", "sourceSha256": "<computed-by-locked-generator>", "artifact": "tests/fixtures/windows/uia/winui/bin/Release/net8.0-windows10.0.19041.0/publish/WxNodus.WinUiFixture.exe", "artifactSha256": "<computed-after-build>" },
    { "id": "electron", "version": "31.7.7", "source": "tests/fixtures/windows/uia/electron", "build": "npm.cmd --prefix tests/fixtures/windows/uia/electron ci && npm.cmd --prefix tests/fixtures/windows/uia/electron run build", "sourceSha256": "<computed-by-locked-generator>", "artifact": "tests/fixtures/windows/uia/electron/dist/WxNodus Electron Fixture.exe", "artifactSha256": "<computed-after-build>" }
  ]
}
```

The implementation task must first implement/review the exact generator contract, run it twice into clean directories and prove byte/path equality, then deliberately refresh the generator and output locks once with `build-fixtures.ps1 -WriteLock`, review the real hash diff, and ensure CI uses only `-VerifyLock`. Committed locks may not contain the angle-bracket markers shown in this plan, all-zero/missing hashes, mutable version ranges, unpinned Electron dependencies/lockfile, or an unreviewed generator hash; any such state is `WINDOWS_FIXTURE_LOCK_INVALID`. Normal verification recomputes canonical source-tree and artifact hashes and maps mismatches to `WINDOWS_FIXTURE_SOURCE_HASH_MISMATCH` or `WINDOWS_FIXTURE_ARTIFACT_HASH_MISMATCH`.

`tests/acceptance/windows/voice.ps1` must use the real selected MMDevice endpoint, record a WAV, parse RIFF/fmt/data, run whisper, exercise SAPI, cancel a second run, simulate device loss by disabling the selected endpoint under the controlled fixture account, re-enable it in `finally`, and prove persisted selection read-back. `computer-multimonitor.ps1` must assert PMv2, click/verify the `physicalOrigin + scaledLocal` transform on the negative-origin display and on a different-DPI display. `uia.ps1` must launch all four verified generated fixtures and verify Invoke/Selection/Value plus no-action/high-integrity/protected-UI/SecureDesktop-UAC-login-lock fail-closed boundaries, with an assertion that coordinate fallback was never attempted for any blocked boundary. `browser.ps1` must prove Playwright service workers are blocked and every required network request category is observed by the pre-navigation BrowserContext route.

`scripts/run-windows-acceptance.mjs` has two explicit modes. `--produce-receipt --os-key win11-24h2|win10-22h2 --run <uuid>` is the per-cell producer: it rejects runner/OS-label mismatch and always writes that cell's immutable OS-keyed receipt before returning; it never self-declares the aggregate Gate E passed. `--aggregate-receipts --run <uuid> --receipt <path> --receipt <path>` requires exactly the two OS-keyed imported receipts, calls `aggregateGateEReceipts`, writes the atomic latest pointer plus the only Gate E aggregate decision, and rejects extra/duplicate receipts. On a cell's physical precondition failure the producer writes its closed receipt with `status: "blocked"` and reason `WINDOWS_PHYSICAL_PRECONDITION_BLOCKED`, then exits `2`. The aggregate validates both receipts against one candidate commit/artifact; required receipt missing, malformed, unclosed, cross-keyed, candidate-mismatched, or fixture/mic/SAPI/multimonitor/env/runner-invalid is `blocked`, never a pass. Thus `npm run test:windows-real` is the multi-receipt aggregate, while OS-specific scripts only produce receipts.

`package.json` must add exact script mappings for every newly added runner script:

```json
{
  "scripts": {
    "provision:windows-runner": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/provision-windows-runner.ps1",
    "verify:windows-fixtures": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/fixtures/windows/uia/build-fixtures.ps1 -VerifyLock",
    "test:windows-real": "node scripts/run-windows-acceptance.mjs --aggregate-receipts",
    "test:windows-real:win11-production": "node scripts/run-windows-acceptance.mjs --produce-receipt --os-key win11-24h2",
    "test:windows-real:win10-legacy": "node scripts/run-windows-acceptance.mjs --produce-receipt --os-key win10-22h2"
  }
}
```

- [ ] **Step 5: execute the required OS-keyed real receipts and aggregate them only during implementation**

Windows 11 24H2 production-real self-hosted interactive runner:

```powershell
npm.cmd run provision:windows-runner
npm.cmd run test:windows-real:win11-production -- --run $env:WXNODUS_W3_RUN_ID
# Upload immutable windows-11-24h2-production-real receipt directory; do not run Gate E aggregate here.
```

Windows 10 22H2 legacy-compatibility self-hosted interactive runner:

```powershell
npm.cmd run provision:windows-runner
npm.cmd run test:windows-real:win10-legacy -- --run $env:WXNODUS_W3_RUN_ID
# Upload immutable windows-10-22h2-legacy-compatibility receipt directory; do not label it production-real.
```

On the Wave 3 aggregate runner, after downloading both receipts for the same run/candidate commit/artifact:

```powershell
npm.cmd run test:windows-real -- --run $env:WXNODUS_W3_RUN_ID --receipt $env:WIN11_RECEIPT --receipt $env:WIN10_RECEIPT
$latest = Get-Content artifacts/release-evidence/latest-run.json -Raw | ConvertFrom-Json
npm.cmd run gate:completion -- --run $latest.runId
```

Expected: Gate E passes only with both valid closed receipts; missing either receipt is `blocked/WINDOWS_REQUIRED_RECEIPT_MISSING`. A hosted VM without physical mic/multimonitor prerequisites remains `blocked/WINDOWS_PHYSICAL_PRECONDITION_BLOCKED`; Win11 is the production-real cell and Win10 only the required legacy-compatibility receipt.

**Commit message when explicitly authorized:** `test: add Win11 production-real and Win10 compatibility acceptance receipts`

---

## Task W3-11：Wave 3 scoped Gate 与遗留入口禁用

**Requirements/Subprojects:** R01、R07-R12、R15-R16、R19；S6-S9/S11

**Files**
- Create: `tests/integration/wave3-current-migration-recovery.test.ts`
- Create: `tests/integration/wave3-headless-e2e.test.ts`
- Create: `tests/integration/wave3-legacy-bypass.test.ts`
- Create: `tests/integration/wave3-gate-scope.test.ts`
- Create: `scripts/drill-wave3-recovery.mjs`
- Create: `scripts/run-completion-gate.mjs`
- Create: `scripts/run-wave3-gates.mjs`
- Modify: `src/release/gateDefinitions.ts`
- Modify: `package.json`
- Modify: `src/kernel/voice.ts`（只保留 compatibility delegation）
- Modify: `src/kernel/browser.ts`（只保留 compatibility delegation）
- Modify: `src/kernel/computer/index.ts`（只保留 compatibility delegation）
- Modify: `src/kernel/computer/actionLayer.ts`（只保留 pure normalization/validation）
- Modify: `src/build/scaffold.ts`（只保留 `BuildService` delegation）
- Modify: `src/build/verify.ts`（只保留 verifier adapter）
- Modify: `src/build/gate.ts`（只保留 `CompletionGate` delegation）
- Modify: `src/wxnodus-ui/wxGateway.ts`（只保留 Gateway adapter）
- Modify: `src/commands/handlers.ts`（禁止 direct Voice/Build driver）
- Modify: `src/commands/handlersExt.ts`（禁止 direct Computer driver）
- Modify: `src/kernel/tools.ts`（禁止 direct driver/scaffold/process bypass）

**Wave-scoped Gate definition**

- Gate A/W3: only Wave 3 source compile and repository typecheck result for the candidate revision.
- Gate B/W3: only the exact Wave 3 tests enumerated in `WAVE3_TEST_FILES`; discovery proves every enumerated file ran.
- Gate C/W3: execute a **current** migration/recovery drill against the candidate commit and immutable artifact hash. It may reuse the W0-W2 migration descriptors/backups as inputs, but its receipt is newly created for this `runId`, proves config rollbackable and DB forward-only recovery/read-back under the current binary, and exact-binds `{ candidateCommit, artifactId, artifactSha256, environmentSnapshotId, migrationDescriptorHashes, backupHashes }`. Prior Gate C receipts remain lineage only and never satisfy C-W3 by themselves.
- Gate D/W3: Voice、Computer、Build、PTY headless paths and frontend parity.
- Gate E/W3: W3-10 OS-keyed immutable receipts: required `windows-11-24h2-production-real` plus required `windows-10-22h2-legacy-compatibility`; physical precondition or required-receipt absence remains blocked.
- Gate F/W3: URL policy、high-impact approval、secret retention、legacy bypass、fixture lock integrity.
- Gate G/W3: W3-01/W3-08 evidence integrity and Wave 3 CompletionDecision; only integrity-verified, attachment-closed evidence enters criteria aggregation.
- Gate H/I are absent from `WAVE3_GATE_DEFINITIONS`; capability and release report continue to state strict N/A.

**Stable failure codes**

- `LEGACY_PATH_DISABLED`
- `LEGACY_BYPASS_DETECTED`
- `WAVE3_GATE_SCOPE_VIOLATION`
- `WAVE3_TEST_DISCOVERY_INCOMPLETE`
- `WAVE3_GATE_FAILED`
- `WAVE3_GATE_BLOCKED`
- `WAVE3_PRIOR_EVIDENCE_MISSING`
- `WAVE3_CURRENT_MIGRATION_RECEIPT_MISSING`
- `WAVE3_MIGRATION_ARTIFACT_BINDING_MISMATCH`
- `WAVE3_RECOVERY_DRILL_FAILED`
- `WAVE3_WINDOWS_RECEIPT_MISSING`
- `WAVE3_LATEST_RUN_WRITE_FAILED`
- `WAVE3_NA_CAPABILITY_REACHABLE`

- [ ] **Step 1: paste the complete Gate-scope red test**

`tests/integration/wave3-gate-scope.test.ts`

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WAVE3_GATE_DEFINITIONS, WAVE3_TEST_FILES } from '../../src/release/gateDefinitions.js';

it('contains only Wave 3-owned A/B/C/D/E/F/G slices', () => {
  expect(WAVE3_GATE_DEFINITIONS.map(gate => gate.id)).toEqual(['A-W3', 'B-W3', 'C-W3', 'D-W3', 'E-W3', 'F-W3', 'G-W3']);
  expect(WAVE3_GATE_DEFINITIONS.some(gate => gate.id.startsWith('H-') || gate.id.startsWith('I-'))).toBe(false);
  expect(WAVE3_GATE_DEFINITIONS.every(gate => gate.wave === 3)).toBe(true);
  expect(WAVE3_GATE_DEFINITIONS.find(gate => gate.id === 'C-W3')?.command).toEqual([
    'npm.cmd', ['run', 'drill:wave3-recovery'],
  ]);
});

it('uses an exact test manifest rather than a directory-wide shorthand', () => {
  expect(WAVE3_TEST_FILES.length).toBeGreaterThanOrEqual(20);
  expect(WAVE3_TEST_FILES.every(path => path.startsWith('tests/') && path.endsWith('.test.ts'))).toBe(true);
  expect(new Set(WAVE3_TEST_FILES).size).toBe(WAVE3_TEST_FILES.length);
});

it('forbids known direct legacy imports and direct executions', async () => {
  const targets = [
    'src/commands/handlers.ts',
    'src/commands/handlersExt.ts',
    'src/kernel/tools.ts',
    'src/wxnodus-ui/wxGateway.ts',
  ];
  for (const target of targets) {
    const source = await readFile(target, 'utf8');
    expect(source).not.toMatch(/new ComputerUse\(|startRecording\(|stopAndTranscribe\(|scaffoldProject\(|spawnSync\(/);
  }
});
```

- [ ] **Step 2: run the red Gate tests**

```powershell
npm.cmd exec -- vitest run tests/integration/wave3-gate-scope.test.ts tests/integration/wave3-headless-e2e.test.ts tests/integration/wave3-legacy-bypass.test.ts
```

Expected: FAIL with direct legacy reachability or missing `WAVE3_GATE_DEFINITIONS`; no failure may be hidden behind HTTP 200 or process exit 0.

- [ ] **Step 3: paste the complete minimal Gate definition**

`src/release/gateDefinitions.ts`

```ts
export const WAVE3_TEST_FILES = [
  'tests/unit/quality/verifierRegistry.contract.test.ts',
  'tests/integration/evidenceAuthorityConflict.test.ts',
  'tests/integration/failurePropagation.test.ts',
  'tests/unit/tui/reducer-projector.contract.test.ts',
  'tests/contract/gatewayClient.contract.test.ts',
  'tests/integration/frontendParity.test.ts',
  'tests/unit/voice/audioDeviceService.test.ts',
  'tests/unit/voice/voice-domain.contract.test.ts',
  'tests/unit/voice/wavWriter.test.ts',
  'tests/integration/voiceSession.test.ts',
  'tests/integration/voiceHeadlessParity.test.ts',
  'tests/failure/voiceWorkerFailure.test.ts',
  'tests/unit/computer/highImpactApproval.test.ts',
  'tests/unit/computer/postcondition.test.ts',
  'tests/unit/computer/driverContracts.test.ts',
  'tests/integration/computerUsePipeline.test.ts',
  'tests/integration/computerFrontendParity.test.ts',
  'tests/integration/emergencyStop.test.ts',
  'tests/integration/browserIsolation.test.ts',
  'tests/failure/driverFallback.test.ts',
  'tests/unit/build/buildContracts.test.ts',
  'tests/integration/buildService.test.ts',
  'tests/integration/buildRestartReadback.test.ts',
  'tests/integration/buildEvidenceDecision.test.ts',
  'tests/failure/buildVerifierFailure.test.ts',
  'tests/contract/pty.contract.test.ts',
  'tests/failure/ptyLifecycle.test.ts',
  'tests/contract/windowsRunnerProvisioning.contract.test.ts',
  'tests/integration/wave3-current-migration-recovery.test.ts',
  'tests/integration/wave3-headless-e2e.test.ts',
  'tests/integration/wave3-legacy-bypass.test.ts',
  'tests/integration/wave3-gate-scope.test.ts',
] as const;

export const WAVE3_GATE_DEFINITIONS = [
  { id: 'A-W3', wave: 3, command: ['npm.cmd', ['run', 'gate:wave3-a']], owner: 'wave3' },
  { id: 'B-W3', wave: 3, command: ['npm.cmd', ['exec', '--', 'vitest', 'run', ...WAVE3_TEST_FILES]], owner: 'wave3' },
  { id: 'C-W3', wave: 3, command: ['npm.cmd', ['run', 'drill:wave3-recovery']], owner: 'wave3' },
  { id: 'D-W3', wave: 3, command: ['npm.cmd', ['run', 'test:wave3-headless']], owner: 'wave3' },
  { id: 'E-W3', wave: 3, command: ['npm.cmd', ['run', 'test:windows-real']], owner: 'wave3' },
  { id: 'F-W3', wave: 3, command: ['npm.cmd', ['run', 'test:wave3-security']], owner: 'wave3' },
  { id: 'G-W3', wave: 3, command: ['npm.cmd', ['run', 'gate:completion']], owner: 'wave3' },
] as const;
```

- [ ] **Step 4: implement exact runner scripts and package mappings**

`scripts/drill-wave3-recovery.mjs` must be a current-candidate drill, not a pointer-only wrapper. It receives `--run`, `--candidate-commit`, `--artifact-id`, `--artifact-sha256`, and `--environment-snapshot`; rereads the candidate artifact and rejects hash drift; loads the W0-W2 config rollbackable and DB forward-only descriptors by locked descriptor hash; creates fresh backups; executes config upgrade → confirmed write → downgrade → read-back/reconcile → re-upgrade and DB backup → expand → N-1 old/new writes → reconcile → contract → injected failure → declared recovery/forward-fix or verified restore → read-back; enforces each descriptor `maxRtoMs`; and atomically writes `migrations/c-w3-receipt.json` plus attachments. The receipt is immutable/closed evidence binding the current `runId/candidateCommit/artifact/environment`, descriptor hashes, backup hashes, injected failure, all read-back assertions and timings. A prior C receipt may appear only in `priorEvidenceIds`; absent current receipt is `WAVE3_CURRENT_MIGRATION_RECEIPT_MISSING`, any binding drift is `WAVE3_MIGRATION_ARTIFACT_BINDING_MISMATCH`, and a failed drill is `WAVE3_RECOVERY_DRILL_FAILED`.

`scripts/run-wave3-gates.mjs` must:

1. create the directory returned by `join('artifacts/release-evidence', runId)`;
2. atomically write `artifacts/release-evidence/latest-run.json` before executing gates;
3. load and verify immutable Wave 1/Wave 2 `priorRunIds` for lineage, without allowing their Gate C receipts to satisfy current C-W3;
4. execute only `A-W3/B-W3/C-W3/D-W3/E-W3/F-W3`; pass the same current candidate commit/artifact/environment binding to C-W3, both Gate E receipt producers/imports, and G-W3;
5. require the current closed `migrations/c-w3-receipt.json` and both OS-keyed Gate E receipts before invoking completion;
6. pass the current UUID directly as `['--run', runId]` to `scripts/run-completion-gate.mjs`;
7. return exit `0` only for `succeeded`, exit `1` for failed, exit `2` for blocked, exit `3` for incomplete, exit `4` for inconclusive, and exit `130` for cancelled.

The literal angle-bracket run token is prohibited in command examples and source. The actual PowerShell invocation is always:

```powershell
$latest = Get-Content artifacts/release-evidence/latest-run.json -Raw | ConvertFrom-Json
npm.cmd run gate:completion -- --run $latest.runId
```

`package.json` must include every newly added script explicitly:

```json
{
  "scripts": {
    "gate:wave3-a": "npm run build && npm run typecheck",
    "drill:wave3-recovery": "node scripts/drill-wave3-recovery.mjs",
    "test:wave3-headless": "vitest run tests/integration/wave3-headless-e2e.test.ts tests/integration/frontendParity.test.ts tests/integration/voiceHeadlessParity.test.ts tests/contract/pty.contract.test.ts",
    "test:wave3-security": "vitest run tests/integration/evidenceAuthorityConflict.test.ts tests/unit/computer/highImpactApproval.test.ts tests/failure/driverFallback.test.ts tests/integration/wave3-legacy-bypass.test.ts tests/contract/windowsRunnerProvisioning.contract.test.ts",
    "gate:completion": "node scripts/run-completion-gate.mjs",
    "gate:wave3": "node scripts/run-wave3-gates.mjs"
  }
}
```

Every legacy compatibility function returns the Application service result unchanged. A compatibility path that cannot delegate returns exactly:

```ts
return {
  ok: false,
  error: {
    code: 'LEGACY_PATH_DISABLED',
    message: 'This legacy path is disabled; call the Application service',
    messageKey: 'LEGACY_PATH_DISABLED',
    retryable: false,
  },
};
```

- [ ] **Step 5: run the Wave 3 scoped Gate during implementation**

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd exec -- vitest run tests/integration/wave3-gate-scope.test.ts tests/integration/wave3-headless-e2e.test.ts tests/integration/wave3-legacy-bypass.test.ts
npm.cmd run test:windows-real
npm.cmd run gate:wave3
$latest = Get-Content artifacts/release-evidence/latest-run.json -Raw | ConvertFrom-Json
npm.cmd run gate:completion -- --run $latest.runId
```

Expected: Wave 3 runner evaluates only A-W3/B-W3/D-W3/E-W3/F-W3/G-W3; prior Gate C evidence remains referenced but not relabeled; H/I remain N/A and unreachable.

**Commit message when explicitly authorized:** `release: enforce Wave 3 scoped production-capability gates`

---

## Wave 3 Exit Audit

Wave 3 is complete only when all statements below have immutable Evidence IDs and full SHA-256 references:

- Voice has one state source; WAV is independently parsed; AudioDeviceService enumerates stable endpoint IDs, rejects invalid selection, detects hot unplug, persists selection, and reads it back after restart; real Win10/Win11 mic and SAPI scenarios satisfy W3-10.
- Computer entrypoints share PDP/approval/budget; `external-send/delete/payment/publish/system-config` use the same stable approval DTO in CLI/Wire/HTTP/TUI; target/effect/reversibility/verification are present; any parameter change invalidates the grant.
- Browser applies URL policy to every navigation surface; UIA never reports focus/no-action as success; negative-origin mixed-DPI coordinates are verified on physical displays.
- Build entrypoints use one `BuildService`; strict criteria drive an executable DAG and staging transaction; a real business value survives process stop, port release, restart, and read-back.
- All 16 minimum verifier IDs execute pass/fail/crash contracts and close EvidenceRecord entries; verifier/audit-source conflict is `EVIDENCE_AUDIT_SOURCE_CONFLICT`; attachment or manifest tamper is `EVIDENCE_INTEGRITY_FAILED`.
- Every EvidenceRecord contains objective、criteria、normalized command、exit、stdout、stderr、environment、capability、policy、verifier、correlation、lineage and authoritative source metadata.
- PTY has Domain/Application ports and a node-pty adapter covering stdin、output、resize、exit、timeout、Abort and process-tree termination on Win/Linux/mac contracts.
- Win10 22H2 and Win11 24H2 controlled self-hosted interactive runners use the same locked Win32/WPF/WinUI/Electron fixtures. Missing physical prerequisites leave Gate E blocked; they never become synthetic pass.
- TUI depends only on Protocol/Application; production reducer/projector are pure; headless composition imports no React/Ink.
- `artifacts/release-evidence/latest-run.json` points to the current immutable Wave 3 run, and PowerShell reads it with `ConvertFrom-Json` before completion evaluation.
- Gate runner is Wave scoped: A-W3/B-W3/D-W3/E-W3/F-W3/G-W3 only. Gate C is inherited evidence; H/I are strict N/A. The only permitted release statement is “Wave 3 canary complete”; GA distribution remains out of scope.
