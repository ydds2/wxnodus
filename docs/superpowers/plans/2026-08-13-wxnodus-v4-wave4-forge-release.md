# WxNodus V4 Wave 4 Forge 与 GA 发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付九类组件从生成到卸载的真实 ComponentForge 生命周期，并建立 Core、Standard、Full Local AI 三档可复验分发、供应链、升级恢复、air-gapped bundle、Windows 10/11 与 Linux/macOS 发布矩阵；只有 Gate A-I 的 Required 项全部通过，才生成并签名中文 GA 完成报告。

**Architecture:** ComponentForge 使用五个正交状态轴、原子 Registry/CAS、owned RegistrationScope 与独立 protocol/behavior verifier。Distribution 由签名 Profile/Release Manifest 驱动，安装、升级、恢复和 airgap 只接受运行时重新验证过的 `VerifiedReleaseManifest`/`VerifiedReleaseReceipt`；CapabilityReport、SBOM、签名、资产锁、矩阵与 Gate 都从同一签名 manifest 派生。

**Tech Stack:** TypeScript/Node.js、Vitest、MCP stdio、Agent Skills、Plugin broker/sandbox、PowerShell/POSIX installer、npm pack、GitHub Actions/self-hosted Windows runners、`@cyclonedx/cyclonedx-npm@6.0.1`、`sigstore@5.0.0`、SHA-256、clean temporary homes/data dirs。

## Global Constraints

- `generated`、`protocol_verified`、`behavior_verified`、`approved`、`installed`、`enabled` 是独立状态轴，禁止跳跃。
- 带占位业务 handler 或未实现 handler 的 candidate 必须 `quarantined`；任何示例失败文本都不能作为行为验证。
- Registry parse/checksum/CAS/installer failure 必须保留上一健康 revision。
- `src/domain/distribution/types.ts` 是 `TargetPlatform`、`LockedPackage`、`LockedAsset`、`SupportLevel`、`AssetIdentity` 的唯一声明位置；该文件不得 import profile、asset、release 或 infrastructure 模块。
- 签名 Profile manifest 是 Required/Optional/Unavailable 的唯一来源；CapabilityReport、release matrix 和 Gate I 不得根据包存在、workflow input 或硬编码能力列表推断 Required。Core 的 Memory、Plugin、PTY、Browser DOM、完整 Verify/Evidence 必须遵循设计合同为 Optional，不能为了 Gate I 覆盖率改成 Required。
- Gate I 只能消费 `SignedProfileEnvelope[]`，每次求 release cells 都必须重新 canonicalize profile、重算 SHA-256，并离线验证 Sigstore artifact subject、OIDC issuer、certificate workflow identity 与签名；禁止 module-global profile cache、`setVerifiedProfiles` 或任何 mutable setter。
- `DistributionLifecycleService.install/upgrade/recover/airgap/uninstall` 只接受当次调用中由 verifier 产生的 `VerifiedReleaseManifest`/`VerifiedReleaseReceipt`；进入任何真实写入前必须重新验证 signer identity、issuer、signature、freshness、profile digest、asset lock digest、全部 artifact digest，以及 receipt signature/MAC。
- 每张 release receipt 必须 canonical 绑定 release/manifest digest、canonical destination、installed tree digest、release nonce、operation nonce 与 ownership-journal digest，并由发行签名或本机受保护密钥的 HMAC-SHA-256 鉴别；只凭 TypeScript brand、可变 JSON 或字段相等不得视为 verified。
- install/upgrade/recover/uninstall 必须使用同卷 sibling staging、durable hash-chained ownership journal、fsync、atomic rename/swap、可恢复 backup 和真实进程 postcondition；未发生预期文件系统状态转换、目标已处于期望状态、空 ownership 集或 postcondition 未执行时必须非零，禁止 no-op success。
- 安装后 canonical tree digest 必须等于签名 release manifest 中对应 artifact digest；manifest swap、tamper、unsigned、wrong issuer、wrong identity、stale/future envelope、nonce replay、receipt MAC 错误都必须 fail-closed。
- clean install/upgrade/recovery/uninstall 测试必须使用发行包和 clean temporary home/data/destination，不得依赖 workspace、全局 link 或源码路径。
- 每个由签名 profiles 派生出的 Required release matrix cell 都必须生成并验证 package、SBOM、license report、Sigstore release bundle、GitHub build attestation、GitHub SBOM attestation、provenance decision 和 airgap bundle；不得只覆盖 Windows Core/Full。
- supply-chain verifier 必须分别判定三条信任事实：Sigstore release bundle、GitHub build/SBOM attestations、npm publish provenance；candidate workflow 明确不 publish，因此 npm provenance 必须是结构化 `not-applicable/candidate-not-published`，不得伪造 digest，也不得把它当 missing failure。
- Windows 10 22H2 x64 build `19045` 与 Windows 11 24H2 x64 build `26100` 都是 Required self-hosted cells；环境证据必须直接读取注册表 `DisplayVersion`、`CurrentBuild`/`CurrentBuildNumber`、`UBR`、`ProductName`、`InstallationType`，缺任一或不匹配时 Gate E/H 为 blocked。
- Gate I 必须使用真实 Linux/macOS runner evidence；每个 profile/target 的 Required/Optional/Unavailable 集合必须逐项从签名 Profile manifest 精确派生。总体矩阵必须覆盖 CLI、noninteractive、JSONL、Wire、Session、Agent、Memory、MCP、Skill、Plugin、PTY、Browser DOM、Build、Verify、Evidence，但 Core Optional 项不得被错误提升。
- 最终发布顺序固定为：导入全部 tests/CI evidence → legacy reachability 与 requirement coverage audit → 生成不含成功自述的候选报告 → 重算并冻结 candidate hashes → 最后依次运行 `gate:release` 与 `gate:completion` → 从最终 decision 派生并签名中文报告。hash 冻结后 Gate 只能新增 decision，不能改 candidate manifest/evidence。
- 最终流程只读取 `artifacts/release-evidence/latest-run.json` 与 `artifacts/release-evidence/latest-release.json`；PowerShell 必须用 `ConvertFrom-Json` 读取，不接收手写 run/release ID。
- 依赖唯一选型：SBOM 使用 exact `@cyclonedx/cyclonedx-npm@6.0.1`；签名使用 exact `sigstore@5.0.0`；Node engine、installer preflight 与所有 CI job 同时固定为 `^22.22.2 || ^24.15.0 || >=26.0.0`。unsupported Node 必须在依赖安装、artifact 下载、staging 或 destination 写入之前非零退出。
- 所有新增 `scripts/*.mjs` 必须由 `package.json` 中唯一命名的 npm script 映射；PowerShell/POSIX 脚本只能由对应 Node runner 调度。
- `check:requirement-coverage` 是唯一 requirement audit 命令；不得并存 `check:requirements`、`audit:requirements` 或第二个 coverage runner。
- `src/release/gateDefinitions.ts` 只能有一个 Wave 4 权威常量 `WAVE4_GATE_DEFINITIONS`；A-I 逐 Gate 固定 argv、required suite IDs、required cell IDs 与 evidence predicates。missing、empty、failed、blocked、incomplete、inconclusive、cancelled 或不认识的状态均必须令对应 gate 和进程非零。
- 所有 release workflow 只上传 candidate artifacts；不得执行 `npm publish`、创建 GitHub Release、推送 tag 或向外发布。
- 本计划中的命令是实施期验证步骤；修订本计划时不运行这些实现测试。

**实施期提交消息统一规则（本次计划修订不提交）：** 每项任务只有在用户另行授权实施提交时，才在该任务全部绿测后使用下表唯一消息；各任务不再重复一个可能遗漏的 Commit step。

| Task | Exact commit message |
|---|---|
| W4-01 | `feat(forge): define Wave 4 component lifecycle` |
| W4-02 | `feat(forge): add atomic registry and installer` |
| W4-03 | `feat(forge): generate production component templates` |
| W4-04 | `feat(forge): verify complete component lifecycles` |
| W4-05 | `feat(distribution): add signed profile contracts` |
| W4-06 | `build(distribution): package reproducible Node releases` |
| W4-07 | `feat(distribution): add trusted atomic lifecycle` |
| W4-08 | `feat(distribution): build verified airgap bundles` |
| W4-09 | `build(release): verify supply chain evidence` |
| W4-10 | `ci(release): enforce Wave 4 release gates` |
| W4-11 | `chore(release): finalize Wave 4 GA evidence` |

## Stable Error Codes

| 范围 | 稳定错误码 |
|---|---|
| Forge domain | `FORGE_KIND_INVALID`, `FORGE_TRANSITION_INVALID`, `FORGE_ENABLE_PRECONDITION`, `FORGE_REVISION_CONFLICT`, `FORGE_REQUEST_REPLAY_CONFLICT`, `FORGE_COMPONENT_REVOKED` |
| Forge registry/install | `FORGE_REGISTRY_CORRUPT`, `FORGE_REGISTRY_CHECKSUM_MISMATCH`, `FORGE_PATH_ESCAPE`, `FORGE_INSTALL_STAGE_FAILED`, `FORGE_INSTALL_COMMIT_FAILED`, `FORGE_UNINSTALL_OWNERSHIP_MISMATCH` |
| Forge generation/verify | `GENERATION_UNSUPPORTED`, `GENERATED_COMPONENT_PLACEHOLDER`, `COMPONENT_MANIFEST_INVALID`, `FORGE_PROTOCOL_VERIFY_FAILED`, `FORGE_BEHAVIOR_VERIFY_FAILED`, `FORGE_VERIFIER_INCONCLUSIVE`, `FORGE_APPROVAL_STALE`, `FORGE_PERMISSION_ESCALATION` |
| Generated handlers | `SESSION_ID_REQUIRED`, `COMMAND_ARGS_INVALID`, `MCP_TOOL_UNKNOWN`, `TASK_ACCEPTANCE_REQUIRED`, `CORRELATION_ID_REQUIRED`, `POSTCONDITION_REQUIRED`, `POSTCONDITION_FAILED` |
| Profiles/assets | `PROFILE_SCHEMA_INVALID`, `PROFILE_CAPABILITY_DERIVATION_MISMATCH`, `CAPABILITY_REQUIRED_MISSING`, `CAPABILITY_UNAVAILABLE`, `ASSET_LOCK_INVALID`, `ASSET_SOURCE_DENIED`, `ASSET_SIZE_MISMATCH`, `ASSET_DIGEST_MISMATCH`, `AIRGAP_BUNDLE_INCOMPLETE` |
| Package release | `PACKAGE_BOUNDARY_INVALID`, `PACKAGE_CLEAN_INSTALL_FAILED`, `PACKAGE_ARCHIVE_NONDETERMINISTIC` |
| Release trust/lifecycle | `RELEASE_UNSIGNED`, `RELEASE_IDENTITY_MISMATCH`, `RELEASE_ISSUER_MISMATCH`, `RELEASE_SIGNATURE_INVALID`, `RELEASE_PROFILE_DIGEST_MISMATCH`, `RELEASE_LOCK_DIGEST_MISMATCH`, `RELEASE_ARTIFACT_DIGEST_MISMATCH`, `RELEASE_MANIFEST_SWAPPED`, `RELEASE_REPLAYED`, `RELEASE_FRESHNESS_INVALID`, `RELEASE_INSTALL_DIGEST_MISMATCH`, `RELEASE_RECEIPT_INVALID`, `RELEASE_RECEIPT_AUTH_INVALID`, `RELEASE_INTERRUPTED`, `DISTRIBUTION_NO_EFFECT`, `DISTRIBUTION_POSTCONDITION_FAILED`, `DISTRIBUTION_OWNERSHIP_MISMATCH` |
| Supply chain/gates | `SBOM_INCOMPLETE`, `LICENSE_POLICY_DENIED`, `SIGNING_IDENTITY_UNAVAILABLE`, `ATTESTATION_IDENTITY_MISMATCH`, `ATTESTATION_REPLAYED`, `ATTESTATION_FRESHNESS_INVALID`, `PROVENANCE_MISMATCH`, `MATRIX_CELL_MISSING`, `MATRIX_ENVIRONMENT_MISMATCH`, `GATE_EVIDENCE_INVALID`, `FINALIZATION_ORDER_INVALID`, `COMPLETION_REPORT_NOT_DERIVED` |

---

## Task W4-01：ComponentForge Domain、五轴状态与转换

**Requirements/Subprojects:** R02-R06、R19；S10

**Files**
- Create: `src/domain/forge/componentKind.ts`
- Create: `src/domain/forge/componentState.ts`
- Create: `src/domain/forge/componentRevision.ts`
- Create: `src/domain/forge/lifecyclePolicy.ts`
- Create: `src/application/forge/componentForgeService.ts`
- Modify: `src/forge/forge.ts`
- Modify: `src/forge/registry.ts`
- Create: `tests/unit/forge/componentState.test.ts`
- Create: `tests/unit/forge/lifecyclePolicy.test.ts`
- Create: `tests/property/forgeStateTransitions.test.ts`

**Interfaces**

```ts
export type ComponentKind =
  | 'session-start' | 'command' | 'mcp' | 'sub-agent' | 'plugin'
  | 'skill' | 'hook' | 'verifier' | 'automation';

export interface ComponentState {
  generation: 'draft' | 'generated' | 'generation_failed';
  verification: 'unverified' | 'protocol_verified' | 'behavior_verified' | 'verification_failed' | 'quarantined';
  approval: 'unreviewed' | 'approved' | 'rejected' | 'revoked';
  installation: 'not_installed' | 'installed' | 'install_failed' | 'uninstalled';
  runtime: 'disabled' | 'enabled' | 'runtime_failed';
}
```

- [ ] **Step 1: 粘贴完整红测 `tests/unit/forge/lifecyclePolicy.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createDraftRevision, transitionComponent } from '../../../src/domain/forge/lifecyclePolicy.js';

const apply = (revision: ReturnType<typeof createDraftRevision>, action: Parameters<typeof transitionComponent>[1]['action'], requestId: string) => {
  const result = transitionComponent(revision, {
    requestId,
    expectedRevision: revision.revision,
    action,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

describe('ComponentForge lifecycle policy', () => {
  it('accepts exactly nine component kinds', () => {
    const kinds = ['session-start', 'command', 'mcp', 'sub-agent', 'plugin', 'skill', 'hook', 'verifier', 'automation'] as const;
    expect(kinds.map(kind => createDraftRevision('cmp', kind).kind)).toEqual(kinds);
    expect(() => createDraftRevision('cmp', 'driver' as never)).toThrowError('FORGE_KIND_INVALID');
  });

  it('rejects generated to enabled and reports a stable code', () => {
    const generated = apply(createDraftRevision('cmp', 'command'), 'generate', 'r1');
    const result = transitionComponent(generated, {
      requestId: 'r2', expectedRevision: generated.revision, action: 'enable',
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORGE_ENABLE_PRECONDITION' } });
  });

  it('enables only behavior-verified, approved and installed revisions', () => {
    let revision = createDraftRevision('cmp', 'mcp');
    revision = apply(revision, 'generate', 'r1');
    revision = apply(revision, 'verify_protocol', 'r2');
    revision = apply(revision, 'verify_behavior', 'r3');
    revision = apply(revision, 'approve', 'r4');
    revision = apply(revision, 'install', 'r5');
    revision = apply(revision, 'enable', 'r6');
    expect(revision.state).toEqual({
      generation: 'generated', verification: 'behavior_verified', approval: 'approved',
      installation: 'installed', runtime: 'enabled',
    });
  });

  it('rejects stale CAS, revoked enable and conflicting request replay', () => {
    const draft = createDraftRevision('cmp', 'plugin');
    const stale = transitionComponent(draft, { requestId: 'r1', expectedRevision: 9, action: 'generate' });
    expect(stale).toMatchObject({ ok: false, error: { code: 'FORGE_REVISION_CONFLICT' } });

    const generated = apply(draft, 'generate', 'r1');
    const replay = transitionComponent(generated, {
      requestId: 'r1', expectedRevision: generated.revision, action: 'reject',
    });
    expect(replay).toMatchObject({ ok: false, error: { code: 'FORGE_REQUEST_REPLAY_CONFLICT' } });

    let ready = apply(generated, 'verify_protocol', 'r2');
    ready = apply(ready, 'verify_behavior', 'r3');
    ready = apply(ready, 'approve', 'r4');
    ready = apply(ready, 'install', 'r5');
    ready = apply(ready, 'revoke', 'r6');
    const enable = transitionComponent(ready, {
      requestId: 'r7', expectedRevision: ready.revision, action: 'enable',
    });
    expect(enable).toMatchObject({ ok: false, error: { code: 'FORGE_COMPONENT_REVOKED' } });
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/unit/forge/lifecyclePolicy.test.ts
```

Expected: FAIL；`src/domain/forge/lifecyclePolicy.ts` 尚不存在。

- [ ] **Step 3: 粘贴最小实现 `src/domain/forge/lifecyclePolicy.ts`**

```ts
import type { OperationResult } from '../../protocol/results.js';
import type { ComponentKind } from './componentKind.js';
import type { ComponentState } from './componentState.js';

export type ForgeAction =
  | 'generate' | 'generation_fail' | 'verify_protocol' | 'verify_behavior'
  | 'verification_fail' | 'quarantine' | 'approve' | 'reject' | 'revoke'
  | 'install' | 'install_fail' | 'enable' | 'runtime_fail' | 'disable' | 'uninstall';

export interface ComponentRevision {
  id: string;
  kind: ComponentKind;
  revision: number;
  state: ComponentState;
  requests: Record<string, ForgeAction>;
}

export interface TransitionRequest {
  requestId: string;
  expectedRevision: number;
  action: ForgeAction;
}

const KINDS = new Set<ComponentKind>([
  'session-start', 'command', 'mcp', 'sub-agent', 'plugin',
  'skill', 'hook', 'verifier', 'automation',
]);

const failure = (code: string, message: string): OperationResult<never> => ({
  ok: false,
  error: { code, message, messageKey: code, retryable: false },
});

export function createDraftRevision(id: string, kind: ComponentKind): ComponentRevision {
  if (!KINDS.has(kind)) throw new Error('FORGE_KIND_INVALID');
  return {
    id, kind, revision: 0,
    state: {
      generation: 'draft', verification: 'unverified', approval: 'unreviewed',
      installation: 'not_installed', runtime: 'disabled',
    },
    requests: {},
  };
}

export function transitionComponent(
  current: ComponentRevision,
  request: TransitionRequest,
): OperationResult<ComponentRevision> {
  if (request.expectedRevision !== current.revision) {
    return failure('FORGE_REVISION_CONFLICT', 'Expected revision does not match current revision');
  }
  const replay = current.requests[request.requestId];
  if (replay && replay !== request.action) {
    return failure('FORGE_REQUEST_REPLAY_CONFLICT', 'Request id was already used for a different action');
  }
  if (replay === request.action) return { ok: true, value: current };

  const state = { ...current.state };
  const invalid = () => failure('FORGE_TRANSITION_INVALID', `Action ${request.action} is invalid for current state`);

  switch (request.action) {
    case 'generate':
      if (state.generation !== 'draft') return invalid();
      state.generation = 'generated';
      break;
    case 'generation_fail':
      if (state.generation !== 'draft') return invalid();
      state.generation = 'generation_failed';
      state.verification = 'quarantined';
      break;
    case 'verify_protocol':
      if (state.generation !== 'generated' || state.verification !== 'unverified') return invalid();
      state.verification = 'protocol_verified';
      break;
    case 'verify_behavior':
      if (state.verification !== 'protocol_verified') return invalid();
      state.verification = 'behavior_verified';
      break;
    case 'verification_fail':
      state.verification = 'verification_failed';
      state.runtime = 'disabled';
      break;
    case 'quarantine':
      state.verification = 'quarantined';
      state.runtime = 'disabled';
      break;
    case 'approve':
      if (state.verification !== 'behavior_verified' || state.approval !== 'unreviewed') return invalid();
      state.approval = 'approved';
      break;
    case 'reject':
      if (state.approval !== 'unreviewed') return invalid();
      state.approval = 'rejected';
      break;
    case 'revoke':
      if (state.approval !== 'approved') return invalid();
      state.approval = 'revoked';
      state.runtime = 'disabled';
      break;
    case 'install':
      if (state.verification !== 'behavior_verified' || state.approval !== 'approved') return invalid();
      if (state.installation !== 'not_installed' && state.installation !== 'uninstalled') return invalid();
      state.installation = 'installed';
      break;
    case 'install_fail':
      state.installation = 'install_failed';
      state.runtime = 'disabled';
      break;
    case 'enable':
      if (state.approval === 'revoked') return failure('FORGE_COMPONENT_REVOKED', 'Revoked component cannot be enabled');
      if (state.verification !== 'behavior_verified' || state.approval !== 'approved' || state.installation !== 'installed') {
        return failure('FORGE_ENABLE_PRECONDITION', 'Behavior verification, approval and installation are required');
      }
      state.runtime = 'enabled';
      break;
    case 'runtime_fail':
      if (state.runtime !== 'enabled') return invalid();
      state.runtime = 'runtime_failed';
      break;
    case 'disable':
      if (state.runtime !== 'enabled' && state.runtime !== 'runtime_failed') return invalid();
      state.runtime = 'disabled';
      break;
    case 'uninstall':
      if (state.runtime === 'enabled' || state.installation !== 'installed') return invalid();
      state.installation = 'uninstalled';
      break;
  }

  return {
    ok: true,
    value: {
      ...current,
      revision: current.revision + 1,
      state,
      requests: { ...current.requests, [request.requestId]: request.action },
    },
  };
}
```

`componentKind.ts`、`componentState.ts`、`componentRevision.ts` 只导出上面使用的精确类型；`componentForgeService.ts` 负责 generator/verifier/installer 编排，不复制 transition table。Property test 随机生成 action 序列，断言 `enabled` 必然同时满足 behavior verified、approved、installed。

- [ ] **Step 4: 运行完整 W4-01 验证**

```powershell
npm.cmd exec -- vitest run tests/unit/forge/componentState.test.ts tests/unit/forge/lifecyclePolicy.test.ts tests/property/forgeStateTransitions.test.ts tests/forge.test.ts
npm.cmd run typecheck
```

---

## Task W4-02：原子 Forge Registry、CAS、staging installer 与恢复

**Requirements/Subprojects:** R02-R06、R18；S10/S12

**Files**
- Create: `src/application/forge/componentRegistry.ts`
- Create: `src/application/forge/componentInstaller.ts`
- Create: `src/infrastructure/forge/jsonComponentRegistry.ts`
- Create: `src/infrastructure/forge/stagingComponentInstaller.ts`
- Create: `src/infrastructure/forge/componentBackupStore.ts`
- Create: `src/migrations/config/forgeRegistryV3ToV4.ts`
- Modify: `src/forge/registry.ts`
- Modify: `src/forge/forge.ts`
- Create: `tests/unit/forge/registryCas.test.ts`
- Create: `tests/unit/forge/pathContainment.test.ts`
- Create: `tests/integration/forgeRegistryRecovery.test.ts`
- Create: `tests/migration/forgeRegistryV3.test.ts`
- Create: `tests/failure/forgeInstallFailure.test.ts`

- [ ] **Step 1: 粘贴完整红测 `tests/unit/forge/registryCas.test.ts`**

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonComponentRegistry } from '../../../src/infrastructure/forge/jsonComponentRegistry.js';
import { createDraftRevision } from '../../../src/domain/forge/lifecyclePolicy.js';

const tempRegistry = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxn-forge-registry-'));
  return { dir, path: join(dir, 'registry.json'), checksumPath: join(dir, 'registry.json.sha256') };
};

describe('JsonComponentRegistry', () => {
  it('does not turn malformed data into an empty registry', async () => {
    const files = await tempRegistry();
    await writeFile(files.path, '{broken', 'utf8');
    await writeFile(files.checksumPath, '0'.repeat(64), 'utf8');
    const result = await new JsonComponentRegistry(files.path).read('cmp');
    expect(result).toMatchObject({ ok: false, error: { code: 'FORGE_REGISTRY_CORRUPT' } });
  });

  it('allows exactly one compare-and-swap winner', async () => {
    const files = await tempRegistry();
    const registry = new JsonComponentRegistry(files.path);
    const initial = createDraftRevision('cmp', 'command');
    expect((await registry.initialize(initial)).ok).toBe(true);
    const a = { ...initial, revision: 1 };
    const b = { ...initial, revision: 1, kind: 'hook' as const };
    const [left, right] = await Promise.all([
      registry.compareAndSwap('cmp', 0, a),
      registry.compareAndSwap('cmp', 0, b),
    ]);
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    expect([left, right].find(result => !result.ok)).toMatchObject({
      ok: false, error: { code: 'FORGE_REVISION_CONFLICT' },
    });
  });

  it('retains the previous bytes when a checksum sidecar is wrong', async () => {
    const files = await tempRegistry();
    const registry = new JsonComponentRegistry(files.path);
    const initial = createDraftRevision('cmp', 'skill');
    await registry.initialize(initial);
    const before = await readFile(files.path);
    await writeFile(files.checksumPath, 'f'.repeat(64), 'utf8');
    const result = await registry.compareAndSwap('cmp', 0, { ...initial, revision: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORGE_REGISTRY_CHECKSUM_MISMATCH' } });
    expect(await readFile(files.path)).toEqual(before);
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/unit/forge/registryCas.test.ts
```

Expected: FAIL；原子 JSON Registry 尚不存在。

- [ ] **Step 3: 粘贴最小实现 `src/infrastructure/forge/jsonComponentRegistry.ts`**

```ts
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';
import type { ComponentRevision } from '../../domain/forge/lifecyclePolicy.js';

interface RegistryDocument {
  schemaVersion: 4;
  entries: Record<string, ComponentRevision>;
}

const fail = (code: string, message: string): OperationResult<never> => ({
  ok: false, error: { code, message, messageKey: code, retryable: false },
});
const sortRecursively = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortRecursively(child)]));
  }
  return value;
};
const canonical = (value: RegistryDocument) => `${JSON.stringify(sortRecursively(value), null, 2)}\n`;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export class JsonComponentRegistry {
  readonly checksumPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {
    this.checksumPath = `${path}.sha256`;
  }

  async initialize(revision: ComponentRevision): Promise<OperationResult<ComponentRevision>> {
    return this.serial(async () => {
      const document: RegistryDocument = { schemaVersion: 4, entries: { [revision.id]: revision } };
      try {
        await this.atomicWrite(document);
        return { ok: true, value: revision };
      } catch (error) {
        return fail('FORGE_INSTALL_COMMIT_FAILED', error instanceof Error ? error.message : String(error));
      }
    });
  }

  async read(id: string): Promise<OperationResult<ComponentRevision>> {
    const loaded = await this.load();
    if (!loaded.ok) return loaded;
    const value = loaded.value.entries[id];
    return value ? { ok: true, value } : fail('FORGE_REGISTRY_CORRUPT', `Missing registry entry ${id}`);
  }

  async compareAndSwap(id: string, expectedRevision: number, next: ComponentRevision): Promise<OperationResult<ComponentRevision>> {
    return this.serial(async () => {
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
      const current = loaded.value.entries[id];
      if (!current || current.revision !== expectedRevision) {
        return fail('FORGE_REVISION_CONFLICT', `Expected ${expectedRevision}, found ${current?.revision ?? 'missing'}`);
      }
      const document: RegistryDocument = {
        ...loaded.value,
        entries: { ...loaded.value.entries, [id]: next },
      };
      try {
        await this.atomicWrite(document);
        return { ok: true, value: next };
      } catch (error) {
        return fail('FORGE_INSTALL_COMMIT_FAILED', error instanceof Error ? error.message : String(error));
      }
    });
  }

  private async load(): Promise<OperationResult<RegistryDocument>> {
    try {
      const [bytes, expected] = await Promise.all([
        readFile(this.path), readFile(this.checksumPath, 'utf8'),
      ]);
      if (digest(bytes) !== expected.trim()) {
        return fail('FORGE_REGISTRY_CHECKSUM_MISMATCH', 'Registry checksum does not match sidecar');
      }
      const parsed = JSON.parse(bytes.toString('utf8')) as RegistryDocument;
      if (parsed.schemaVersion !== 4 || !parsed.entries || typeof parsed.entries !== 'object') {
        return fail('FORGE_REGISTRY_CORRUPT', 'Registry schema is invalid');
      }
      return { ok: true, value: parsed };
    } catch (error) {
      return fail('FORGE_REGISTRY_CORRUPT', error instanceof Error ? error.message : String(error));
    }
  }

  private async atomicWrite(document: RegistryDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const bytes = canonical(document);
    const suffix = randomUUID();
    const temp = `${this.path}.${suffix}.tmp`;
    const checksumTemp = `${this.checksumPath}.${suffix}.tmp`;
    await writeFile(temp, bytes, { encoding: 'utf8', flag: 'wx' });
    const handle = await open(temp, 'r');
    await handle.sync();
    await handle.close();
    await writeFile(checksumTemp, `${digest(bytes)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, this.path);
    await rename(checksumTemp, this.checksumPath);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
```

`pathContainment.test.ts` 必须覆盖 absolute、drive、UNC、`..`、symlink/junction realpath escape，并期待 `FORGE_PATH_ESCAPE`。`stagingComponentInstaller.ts` 必须先写唯一 staging 目录、执行 smoke，再 atomic swap；`InstallReceipt` 记录 owned files、scope ID、disposers、migration IDs 和 installed digest。V3 migration 先备份并校验 checksum，任何失败保留原 bytes。

- [ ] **Step 4: 运行完整 W4-02 验证**

```powershell
npm.cmd exec -- vitest run tests/unit/forge/registryCas.test.ts tests/unit/forge/pathContainment.test.ts tests/integration/forgeRegistryRecovery.test.ts tests/migration/forgeRegistryV3.test.ts tests/failure/forgeInstallFailure.test.ts tests/forge.test.ts
npm.cmd run typecheck
```

---

## Task W4-03：九类组件模板、manifest 与真实 handler

**Requirements/Subprojects:** R02-R06、R19；S10

**Files**
- Create: `src/domain/forge/componentManifest.ts`
- Create: `src/application/forge/generators/componentGenerator.ts`
- Create: `src/application/forge/generators/generatorCatalog.ts`
- Create: `src/infrastructure/forge/templateRenderer.ts`
- Create: `src/infrastructure/forge/templates/componentTemplates.ts`
- Create: `src/infrastructure/forge/templates/templateTypes.ts`
- Create: `src/infrastructure/forge/templates/templateVersion.ts`
- Create: `src/infrastructure/forge/templates/sessionStartTemplate.ts`
- Create: `src/infrastructure/forge/templates/commandTemplate.ts`
- Create: `src/infrastructure/forge/templates/mcpTemplate.ts`
- Create: `src/infrastructure/forge/templates/subAgentTemplate.ts`
- Create: `src/infrastructure/forge/templates/pluginTemplate.ts`
- Create: `src/infrastructure/forge/templates/skillTemplate.ts`
- Create: `src/infrastructure/forge/templates/hookTemplate.ts`
- Create: `src/infrastructure/forge/templates/verifierTemplate.ts`
- Create: `src/infrastructure/forge/templates/automationTemplate.ts`
- Modify: `src/forge/forge.ts`
- Create: `tests/fixtures/forge/session-start.json`
- Create: `tests/fixtures/forge/command.json`
- Create: `tests/fixtures/forge/mcp.json`
- Create: `tests/fixtures/forge/sub-agent.json`
- Create: `tests/fixtures/forge/plugin.json`
- Create: `tests/fixtures/forge/skill.json`
- Create: `tests/fixtures/forge/hook.json`
- Create: `tests/fixtures/forge/verifier.json`
- Create: `tests/fixtures/forge/automation.json`
- Create: `tests/contract/forgeManifests.contract.test.ts`
- Create: `tests/integration/forgeGeneratedComponents.test.ts`
- Create: `tests/failure/forgePlaceholder.test.ts`

`componentTemplates.ts` 是九个精确模板文件的 typed catalog：只 import 并映射 `sessionStartTemplate.ts`、`commandTemplate.ts`、`mcpTemplate.ts`、`subAgentTemplate.ts`、`pluginTemplate.ts`、`skillTemplate.ts`、`hookTemplate.ts`、`verifierTemplate.ts`、`automationTemplate.ts`；每个文件只包含对应 kind 的真实窄 handler。九份 `tests/fixtures/forge/*.json` 分别固定 id、kind、version、behavior、expected positive/negative result，集成测试逐份读取，不动态伪造缺失 fixture。

**九份 fixture 的精确 JSON 内容:** 每个文件包含 `id`、`kind`、`version: "1.0.0"`、`behavior: { "type": "echo", "inputField": "value" }` 和 `expected: { "positive": "passed", "negative": "failed" }`；`id` 依次为文件 basename，`kind` 精确等于文件名所表达的九个 `ComponentKind`。例如 `tests/fixtures/forge/mcp.json`：

```json
{
  "id": "mcp",
  "kind": "mcp",
  "version": "1.0.0",
  "behavior": { "type": "echo", "inputField": "value" },
  "expected": { "positive": "passed", "negative": "failed" }
}
```

- [ ] **Step 1: 粘贴完整红测 `tests/contract/forgeManifests.contract.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { generateComponent } from '../../src/application/forge/generators/generatorCatalog.js';

const kinds = ['session-start', 'command', 'mcp', 'sub-agent', 'plugin', 'skill', 'hook', 'verifier', 'automation'] as const;
const forbidden = ['TO' + 'DO', 'T' + 'BD', 'Not ' + 'implemented', 'throw new Error("example failure")'];

describe('Forge component manifests', () => {
  it.each(kinds)('generates a complete %s component with a real handler', kind => {
    const result = generateComponent({
      id: `sample-${kind}`,
      kind,
      version: '1.0.0',
      behavior: { type: 'echo', inputField: 'value' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.manifest).toMatchObject({
      schemaVersion: 1,
      id: `sample-${kind}`,
      kind,
      version: '1.0.0',
    });
    expect(result.value.manifest.entrypoints.length).toBeGreaterThan(0);
    expect(result.value.manifest.permissions).toBeDefined();
    expect(result.value.manifest.capabilities.length).toBeGreaterThan(0);
    expect(result.value.manifest.verification.positive.length).toBeGreaterThan(0);
    expect(result.value.manifest.verification.negative.length).toBeGreaterThan(0);
    expect(result.value.manifest.install.files.length).toBeGreaterThan(0);
    expect(result.value.manifest.uninstall.ownedPaths.length).toBeGreaterThan(0);
    const allText = Object.values(result.value.files).join('\n');
    for (const token of forbidden) expect(allText).not.toContain(token);
  });

  it('rejects open-domain behavior instead of emitting a convincing shell', () => {
    const result = generateComponent({
      id: 'unknown-driver', kind: 'automation', version: '1.0.0',
      behavior: { type: 'open-domain', inputField: 'value' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'GENERATION_UNSUPPORTED' } });
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/contract/forgeManifests.contract.test.ts
```

Expected: FAIL；九类统一 manifest/generator 尚不存在。

- [ ] **Step 3: 粘贴九个模板文件及 catalog**

下列 `sessionStartTemplate`、`commandTemplate`、`mcpTemplate`、`subAgentTemplate`、`pluginTemplate`、`skillTemplate`、`hookTemplate`、`verifierTemplate`、`automationTemplate` 对象必须分别放入同名 `src/infrastructure/forge/templates/*Template.ts` 并 `export const`；共同的 `RenderedTemplate` 放入 `templateTypes.ts`。每个具体模板文件 import `RenderedTemplate`；`componentTemplates.ts` 只 import `ComponentKind`、`RenderedTemplate` 和九个对象，并建立最后的 `COMPONENT_TEMPLATES` map，不能重新内联实现。

```ts
// templateTypes.ts
export interface RenderedTemplate {
  entrypoint: string;
  files: Record<string, string>;
  capability: string;
  positive: string;
  negative: string;
}

// sessionStartTemplate.ts 等九个具体模板文件均先写：
import type { RenderedTemplate } from './templateTypes.js';

export const sessionStartTemplate: RenderedTemplate = {
  entrypoint: 'src/sessionStart.ts', capability: 'session.lifecycle',
  positive: 'continues a valid session.start event', negative: 'denies a missing session id',
  files: { 'src/sessionStart.ts': `export function onSessionStart(input: { sessionId: string }) {\n  if (!input.sessionId) return { action: 'deny', reason: 'SESSION_ID_REQUIRED' } as const;\n  return { action: 'continue' } as const;\n}\n` },
};
export const commandTemplate: RenderedTemplate = {
  entrypoint: 'src/command.ts', capability: 'command.registry',
  positive: 'echoes validated arguments', negative: 'rejects a non-array argument list',
  files: { 'src/command.ts': `export function execute(args: unknown) {\n  if (!Array.isArray(args)) return { ok: false, code: 'COMMAND_ARGS_INVALID' } as const;\n  return { ok: true, value: args.map(String) } as const;\n}\n` },
};
export const mcpTemplate: RenderedTemplate = {
  entrypoint: 'src/server.ts', capability: 'mcp.server',
  positive: '2026-07-28 server/discover, tools/list and echo tools/call carry valid per-request _meta',
  negative: 'missing/invalid _meta and unknown tools fail; legacy initialize is reachable only through isolated compat',
  files: {
    'src/server.ts': `export const MCP_PROTOCOL_VERSION = '2026-07-28' as const;
type RequestMeta = {
  'io.modelcontextprotocol/protocolVersion': typeof MCP_PROTOCOL_VERSION;
  'io.modelcontextprotocol/clientInfo': { name: string; version: string };
  'io.modelcontextprotocol/clientCapabilities': Record<string, unknown>;
};
type Request = { method: string; params?: Record<string, unknown> & { _meta?: unknown } };
const readMeta = (request: Request): RequestMeta => {
  const meta = request.params?._meta as Partial<RequestMeta> | undefined;
  if (meta?.['io.modelcontextprotocol/protocolVersion'] !== MCP_PROTOCOL_VERSION ||
      typeof meta['io.modelcontextprotocol/clientInfo']?.name !== 'string' ||
      typeof meta['io.modelcontextprotocol/clientInfo']?.version !== 'string' ||
      !meta['io.modelcontextprotocol/clientCapabilities'] ||
      typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object') {
    throw Object.assign(new Error('MCP_REQUEST_META_INVALID'), { code: 'MCP_REQUEST_META_INVALID' });
  }
  return meta as RequestMeta;
};
export function handleRequest(request: Request) {
  readMeta(request);
  if (request.method === 'server/discover') return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'generated-forge-server', version: '1.0.0' } };
  if (request.method === 'tools/list') return { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { value: {} }, required: ['value'] } }] };
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    const args = request.params?.arguments as { value?: unknown } | undefined;
    return name === 'echo' ? { content: [{ type: 'text', text: JSON.stringify(args?.value) }] } : { isError: true, code: 'MCP_TOOL_UNKNOWN' };
  }
  return { isError: true, code: 'MCP_METHOD_UNKNOWN' };
}
`,
    'src/legacyCompat.ts': `export function handleLegacyInitialize(request: { method: string }) {
  if (request.method !== 'initialize') return { isError: true, code: 'MCP_LEGACY_METHOD_UNKNOWN' };
  return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'generated-forge-server-legacy-compat', version: '1.0.0' } };
}
`,
  },
};
export const subAgentTemplate: RenderedTemplate = {
  entrypoint: 'src/subAgent.ts', capability: 'agent.subagent',
  positive: 'creates a bounded TaskTicket', negative: 'rejects empty acceptance criteria',
  files: { 'src/subAgent.ts': `export function createTicket(input: { id: string; parentRunId: string; objective: string; acceptanceCriteria: string[] }) {\n  if (!input.acceptanceCriteria.length) return { ok: false, code: 'TASK_ACCEPTANCE_REQUIRED' } as const;\n  return { ok: true, value: { ...input, ownedFiles: [], allowedTools: [], budget: {}, workspaceStrategy: 'worktree' } } as const;\n}\n` },
};
export const pluginTemplate: RenderedTemplate = {
  entrypoint: 'src/plugin.ts', capability: 'plugin.runtime',
  positive: 'registers through broker and disposes registration', negative: 'broker denial is returned unchanged',
  files: { 'src/plugin.ts': `export async function onLoad(broker: { register(name: string): Promise<{ dispose(): void }> }) {\n  const registration = await broker.register('echo');\n  return { dispose: () => registration.dispose() };\n}\n` },
};
export const skillTemplate: RenderedTemplate = {
  entrypoint: 'SKILL.md', capability: 'skill.runtime',
  positive: 'frontmatter parses and instruction is callable', negative: 'missing input is rejected by host schema',
  files: { 'SKILL.md': `---\nname: sample-skill\nversion: 1.0.0\ndescription: Echo a validated value\ncapabilities:\n  - skill.runtime\nentrypoints:\n  - prompt\n---\nReturn the validated input value without invoking external effects.\n` },
};
export const hookTemplate: RenderedTemplate = {
  entrypoint: 'src/hook.ts', capability: 'hook.registry',
  positive: 'returns continue for a valid event', negative: 'returns deny for missing correlation id',
  files: { 'src/hook.ts': `export function run(event: { correlationId?: string }) {\n  return event.correlationId ? { action: 'continue' } as const : { action: 'deny', reason: 'CORRELATION_ID_REQUIRED' } as const;\n}\n` },
};
export const verifierTemplate: RenderedTemplate = {
  entrypoint: 'src/verifier.ts', capability: 'quality.verify',
  positive: 'equal expected and observed pass', negative: 'mismatch fails',
  files: { 'src/verifier.ts': `export function verify(input: { expected: unknown; observed: unknown }) {\n  const passed = JSON.stringify(input.expected) === JSON.stringify(input.observed);\n  return { status: passed ? 'passed' : 'failed', observed: input.observed } as const;\n}\n` },
};
export const automationTemplate: RenderedTemplate = {
  entrypoint: 'src/automation.ts', capability: 'computer.automation',
  positive: 'verified postcondition returns passed', negative: 'missing postcondition blocks action',
  files: { 'src/automation.ts': `export function execute(input: { action: string; postcondition?: { passed: boolean } }) {\n  if (!input.postcondition) return { ok: false, code: 'POSTCONDITION_REQUIRED' } as const;\n  return input.postcondition.passed ? { ok: true, action: input.action } as const : { ok: false, code: 'POSTCONDITION_FAILED' } as const;\n}\n` },
};

// componentTemplates.ts
import type { ComponentKind } from '../../../domain/forge/componentKind.js';
import type { RenderedTemplate } from './templateTypes.js';
import { sessionStartTemplate } from './sessionStartTemplate.js';
import { commandTemplate } from './commandTemplate.js';
import { mcpTemplate } from './mcpTemplate.js';
import { subAgentTemplate } from './subAgentTemplate.js';
import { pluginTemplate } from './pluginTemplate.js';
import { skillTemplate } from './skillTemplate.js';
import { hookTemplate } from './hookTemplate.js';
import { verifierTemplate } from './verifierTemplate.js';
import { automationTemplate } from './automationTemplate.js';

export const COMPONENT_TEMPLATES: Record<ComponentKind, RenderedTemplate> = {
  'session-start': sessionStartTemplate,
  command: commandTemplate,
  mcp: mcpTemplate,
  'sub-agent': subAgentTemplate,
  plugin: pluginTemplate,
  skill: skillTemplate,
  hook: hookTemplate,
  verifier: verifierTemplate,
  automation: automationTemplate,
};
```

- [ ] **Step 4: 粘贴最小实现 `src/application/forge/generators/generatorCatalog.ts`**

```ts
import type { OperationResult } from '../../../protocol/results.js';
import type { ComponentKind } from '../../../domain/forge/componentKind.js';
import type { ComponentManifest } from '../../../domain/forge/componentManifest.js';
import { COMPONENT_TEMPLATES } from '../../../infrastructure/forge/templates/componentTemplates.js';

interface ComponentSpec {
  id: string;
  kind: ComponentKind;
  version: string;
  behavior: { type: 'echo' | 'open-domain'; inputField: string };
}

interface GeneratedComponent {
  manifest: ComponentManifest;
  files: Record<string, string>;
}

export function generateComponent(spec: ComponentSpec): OperationResult<GeneratedComponent> {
  if (spec.behavior.type !== 'echo') {
    return { ok: false, error: { code: 'GENERATION_UNSUPPORTED', message: 'Only the bounded echo behavior is supported', messageKey: 'GENERATION_UNSUPPORTED', retryable: false } };
  }
  const template = COMPONENT_TEMPLATES[spec.kind];
  if (!template) {
    return { ok: false, error: { code: 'FORGE_KIND_INVALID', message: 'Unknown component kind', messageKey: 'FORGE_KIND_INVALID', retryable: false } };
  }
  const files = { ...template.files };
  const manifest: ComponentManifest = {
    schemaVersion: 1,
    id: spec.id,
    kind: spec.kind,
    version: spec.version,
    templateVersion: '4.0.0',
    entrypoints: [template.entrypoint],
    permissions: [],
    capabilities: [template.capability],
    verification: { positive: [template.positive], negative: [template.negative] },
    install: { files: Object.keys(files), scopeOwner: `forge:${spec.id}` },
    uninstall: { ownedPaths: Object.keys(files), disposeScope: true },
    source: { generator: 'wxnodus-component-forge', generatorVersion: '4.0.0' },
  };
  return { ok: true, value: { manifest, files } };
}
```

`forgeGeneratedComponents.test.ts` 必须在 temp workspace 对九类执行其正反 handler。MCP generated server 的 primary contract 固定为 modern `2026-07-28`：client 先以含三个必需 namespaced keys 的 per-request `params._meta` 调 `server/discover`，再对 `tools/list`、positive/negative `tools/call` 各自携带新建 `_meta`，最后 shutdown；任一请求缺 key、版本不一致或复用隐式 initialize session 都失败。`src/server.ts` 禁止导出或处理 `initialize`；只有 generated `src/legacyCompat.ts` 可实现 `initialize`/`notifications/initialized`，由 modern discover 的非-modern error/timeout 显式选择，且不能共享 modern 隐式状态。`forgePlaceholder.test.ts` 扫描生成文件并以 `GENERATED_COMPONENT_PLACEHOLDER` quarantine，而不是给 verified 状态。

- [ ] **Step 5: 运行完整 W4-03 验证**

```powershell
npm.cmd exec -- vitest run tests/contract/forgeManifests.contract.test.ts tests/integration/forgeGeneratedComponents.test.ts tests/failure/forgePlaceholder.test.ts tests/forge.test.ts
npm.cmd run typecheck
```

---

## Task W4-04：组件 protocol/behavior 验证与完整生命周期 E2E

**Requirements/Subprojects:** R02-R06、R15、R19；S4/S9/S10

**Files**
- Create: `src/application/forge/componentVerifier.ts`
- Create: `src/application/forge/componentApprovalService.ts`
- Create: `src/application/forge/componentLifecycleService.ts`
- Create: `src/application/quality/componentVerifiers.ts`
- Modify: `src/application/forge/componentForgeService.ts`
- Modify: `src/application/extensions/extensionLifecycleService.ts`
- Modify: `src/commands/handlersExt.ts`
- Modify: `src/wxnodus-ui/wxGateway.ts`
- Create: `tests/integration/forgeLifecycle.test.ts`
- Create: `tests/integration/forgeAllKindsLifecycle.test.ts`
- Create: `tests/integration/forgeScopeCleanup.test.ts`
- Create: `tests/security/forgePermissionEscalation.test.ts`
- Create: `tests/failure/forgeVerifierCrash.test.ts`

W4-04 必须修改 Wave 2 已定义的 `src/application/extensions/extensionLifecycleService.ts`；不得创建或引用 `extensionService.ts`。

- [ ] **Step 1: 粘贴完整红测 `tests/integration/forgeAllKindsLifecycle.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { ComponentLifecycleService } from '../../src/application/forge/componentLifecycleService.js';
import { createDraftRevision, transitionComponent } from '../../src/domain/forge/lifecyclePolicy.js';

const kinds = ['session-start', 'command', 'mcp', 'sub-agent', 'plugin', 'skill', 'hook', 'verifier', 'automation'] as const;

const generated = (kind: typeof kinds[number]) => {
  const draft = createDraftRevision(`cmp-${kind}`, kind);
  const result = transitionComponent(draft, { requestId: `${kind}-generate`, expectedRevision: 0, action: 'generate' });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

describe('all Forge kinds lifecycle', () => {
  it.each(kinds)('%s reaches invoke and leaves no owned scope after uninstall', async kind => {
    const revisions = new Map([[`cmp-${kind}`, generated(kind)]]);
    const scope = { activate: vi.fn(async () => ({ ok: true as const, value: { scopeId: `forge:cmp-${kind}` } })), deactivate: vi.fn(async () => ({ ok: true as const, value: undefined })) };
    const verifier = { verify: vi.fn(async (_id: string, level: string) => ({ ok: true as const, value: { level, evidenceIds: [`e-${level}`], artifactDigest: 'a'.repeat(64) } })) };
    const service = new ComponentLifecycleService({ revisions, verifier, scope });

    expect((await service.verify(`cmp-${kind}`, 'protocol')).ok).toBe(true);
    expect((await service.verify(`cmp-${kind}`, 'behavior')).ok).toBe(true);
    expect((await service.approve(`cmp-${kind}`, { artifactDigest: 'a'.repeat(64), permissionsDigest: 'b'.repeat(64) })).ok).toBe(true);
    expect((await service.install(`cmp-${kind}`)).ok).toBe(true);
    expect((await service.enable(`cmp-${kind}`)).ok).toBe(true);
    expect((await service.invoke(`cmp-${kind}`, { value: 'ok' })).ok).toBe(true);
    expect((await service.disable(`cmp-${kind}`)).ok).toBe(true);
    expect((await service.uninstall(`cmp-${kind}`)).ok).toBe(true);
    expect(scope.deactivate).toHaveBeenCalledWith(`forge:cmp-${kind}`);
  });

  it('quarantines verifier crashes and does not activate a scope', async () => {
    const revision = generated('plugin');
    const scope = { activate: vi.fn(), deactivate: vi.fn() };
    const verifier = { verify: vi.fn(async () => { throw new Error('worker exited'); }) };
    const service = new ComponentLifecycleService({ revisions: new Map([[revision.id, revision]]), verifier, scope });
    const result = await service.verify(revision.id, 'behavior');
    expect(result).toMatchObject({ ok: false, error: { code: 'FORGE_VERIFIER_INCONCLUSIVE' } });
    expect(service.snapshot(revision.id)?.state.verification).toBe('quarantined');
    expect(scope.activate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/integration/forgeAllKindsLifecycle.test.ts
```

Expected: FAIL；统一 lifecycle service 尚不存在。

- [ ] **Step 3: 粘贴最小实现 `src/application/forge/componentLifecycleService.ts`**

```ts
import type { OperationResult } from '../../protocol/results.js';
import { transitionComponent, type ComponentRevision, type ForgeAction } from '../../domain/forge/lifecyclePolicy.js';

interface VerificationReceipt { level: string; evidenceIds: string[]; artifactDigest: string }
interface ApprovalGrant { artifactDigest: string; permissionsDigest: string }
interface Dependencies {
  revisions: Map<string, ComponentRevision>;
  verifier: { verify(id: string, level: 'protocol' | 'behavior'): Promise<OperationResult<VerificationReceipt>> };
  scope: {
    activate(owner: string): Promise<OperationResult<{ scopeId: string }>>;
    deactivate(owner: string): Promise<OperationResult<void>>;
  };
}

const fail = (code: string, message: string): OperationResult<never> => ({
  ok: false, error: { code, message, messageKey: code, retryable: false },
});

export class ComponentLifecycleService {
  private readonly approvals = new Map<string, ApprovalGrant>();
  private request = 0;
  constructor(private readonly deps: Dependencies) {}

  snapshot(id: string): ComponentRevision | undefined { return this.deps.revisions.get(id); }

  async verify(id: string, level: 'protocol' | 'behavior'): Promise<OperationResult<ComponentRevision>> {
    const current = this.deps.revisions.get(id);
    if (!current) return fail('FORGE_TRANSITION_INVALID', 'Component was not found');
    try {
      const receipt = await this.deps.verifier.verify(id, level);
      if (!receipt.ok) return receipt;
      return this.apply(id, level === 'protocol' ? 'verify_protocol' : 'verify_behavior');
    } catch (error) {
      const quarantined = this.apply(id, 'quarantine');
      if (!quarantined.ok) return quarantined;
      return fail('FORGE_VERIFIER_INCONCLUSIVE', error instanceof Error ? error.message : String(error));
    }
  }

  async approve(id: string, grant: ApprovalGrant): Promise<OperationResult<ComponentRevision>> {
    const current = this.deps.revisions.get(id);
    if (!current) return fail('FORGE_TRANSITION_INVALID', 'Component was not found');
    if (grant.artifactDigest !== 'a'.repeat(64)) return fail('FORGE_APPROVAL_STALE', 'Approval artifact digest is stale');
    this.approvals.set(id, grant);
    return this.apply(id, 'approve');
  }

  async install(id: string): Promise<OperationResult<ComponentRevision>> {
    if (!this.approvals.has(id)) return fail('FORGE_APPROVAL_STALE', 'A current approval is required');
    const activated = await this.deps.scope.activate(`forge:${id}`);
    if (!activated.ok) return activated;
    return this.apply(id, 'install');
  }

  async enable(id: string): Promise<OperationResult<ComponentRevision>> { return this.apply(id, 'enable'); }
  async disable(id: string): Promise<OperationResult<ComponentRevision>> { return this.apply(id, 'disable'); }

  async invoke(id: string, value: unknown): Promise<OperationResult<unknown>> {
    const current = this.deps.revisions.get(id);
    if (!current || current.state.runtime !== 'enabled') return fail('FORGE_ENABLE_PRECONDITION', 'Component is not enabled');
    return { ok: true, value };
  }

  async uninstall(id: string): Promise<OperationResult<ComponentRevision>> {
    const deactivated = await this.deps.scope.deactivate(`forge:${id}`);
    if (!deactivated.ok) return deactivated;
    this.approvals.delete(id);
    return this.apply(id, 'uninstall');
  }

  private apply(id: string, action: ForgeAction): OperationResult<ComponentRevision> {
    const current = this.deps.revisions.get(id);
    if (!current) return fail('FORGE_TRANSITION_INVALID', 'Component was not found');
    const result = transitionComponent(current, {
      requestId: `lifecycle-${++this.request}`,
      expectedRevision: current.revision,
      action,
    });
    if (result.ok) this.deps.revisions.set(id, result.value);
    return result;
  }
}
```

实施时将测试中的固定 digest 替换为 W3 `ArtifactManifest.rootDigest`；approval 必须绑定 component revision、artifact digest、permissions digest、policy snapshot 和 single-use nonce。`extensionLifecycleService.ts` 只接受已通过 Forge lifecycle 的 staged scope；CLI/Wire/HTTP/TUI 全部调用同一 service。`forgePermissionEscalation.test.ts` 必须期待 `FORGE_PERMISSION_ESCALATION`，旧 approval 在文件或 permission 变化后期待 `FORGE_APPROVAL_STALE`。

- [ ] **Step 4: 运行完整 W4-04 验证**

```powershell
npm.cmd exec -- vitest run tests/integration/forgeLifecycle.test.ts tests/integration/forgeAllKindsLifecycle.test.ts tests/integration/forgeScopeCleanup.test.ts tests/security/forgePermissionEscalation.test.ts tests/failure/forgeVerifierCrash.test.ts
npm.cmd run typecheck
```

---

## Task W4-05：公共 Distribution Types、Profile manifests 与 CapabilityReport

**Requirements/Subprojects:** R17、R18；S12

**Files**
- Create: `distribution/profiles/core.json`
- Create: `distribution/profiles/standard.json`
- Create: `distribution/profiles/full-local-ai.json`
- Create: `distribution/profile.schema.json`
- Create: `src/domain/distribution/types.ts`
- Create: `src/domain/distribution/profile.ts`
- Create: `src/application/distribution/profileService.ts`
- Create: `src/application/distribution/capabilityReportService.ts`
- Create: `src/infrastructure/distribution/profileLoader.ts`
- Modify: `src/application/capabilities/capabilityRegistry.ts`
- Modify: `src/commands/handlers.ts`
- Create: `tests/contract/distributionProfiles.contract.test.ts`
- Create: `tests/integration/capabilityReport.test.ts`
- Create: `tests/property/profileCapabilityMatrix.test.ts`

**公共类型唯一声明**

```ts
export type TargetPlatform =
  | 'win32-x64' | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';
export type SupportLevel = 'required' | 'optional' | 'unavailable';

export interface AssetIdentity {
  id: string;
  version: string;
  kind: 'package' | 'binary' | 'model' | 'runtime' | 'bundle' | 'sbom' | 'installer';
  target: TargetPlatform | 'any';
  sha256: string;
  size: number;
  mediaType: string;
  source: string;
  license: string;
}

export interface LockedPackage extends AssetIdentity {
  kind: 'package';
  packageName: string;
  integrity: `sha512-${string}`;
  resolved: `https://${string}`;
  dev: boolean;
  optional: boolean;
}

export interface LockedAsset extends AssetIdentity {
  kind: 'binary' | 'model' | 'runtime';
  target: TargetPlatform;
  urls: readonly [string, ...string[]];
  executable: boolean;
  unpack?: { format: 'zip' | 'tar.gz' | 'none'; stripComponents: number };
}
```

`types.ts` 不得 import `profile.ts` 或 `assetLock.ts`。W4-08 只能从该文件 import `LockedAsset`/`AssetIdentity`/`TargetPlatform`，从而消除 profile ↔ asset 循环。

- [ ] **Step 1: 粘贴完整红测 `tests/contract/distributionProfiles.contract.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadProfiles } from '../../src/infrastructure/distribution/profileLoader.js';
import type { TargetPlatform } from '../../src/domain/distribution/types.js';

const targets: TargetPlatform[] = ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

describe('distribution profiles', () => {
  it('loads exactly three schema-valid profiles and all target cells', async () => {
    const result = await loadProfiles('distribution/profiles');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.map(profile => profile.id).sort()).toEqual(['core', 'full-local-ai', 'standard']);
    for (const profile of result.value) {
      for (const capability of profile.capabilities) {
        expect(Object.keys(capability.support).sort()).toEqual([...targets].sort());
      }
    }
  });

  it('matches the Core/Standard/Full signed-profile contract on secondary platforms', async () => {
    const loaded = await loadProfiles('distribution/profiles');
    if (!loaded.ok) throw new Error(loaded.error.code);
    const byId = new Map(loaded.value.map(profile => [profile.id, profile]));
    const coreRequired = ['cli', 'noninteractive', 'jsonl', 'wire', 'session', 'agent', 'mcp', 'skill', 'build'];
    const standardRequired = [...coreRequired, 'memory', 'plugin', 'pty', 'browser.dom', 'verify', 'evidence'];
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const) {
      for (const id of coreRequired) expect(byId.get('core')?.capabilities.find(item => item.id === id)?.support[target]).toBe('required');
      for (const id of ['memory', 'plugin', 'pty', 'browser.dom', 'verify', 'evidence']) {
        expect(byId.get('core')?.capabilities.find(item => item.id === id)?.support[target]).toBe('optional');
      }
      for (const profileId of ['standard', 'full-local-ai'] as const) {
        for (const id of standardRequired) expect(byId.get(profileId)?.capabilities.find(item => item.id === id)?.support[target]).toBe('required');
      }
    }
  });

  it('keeps Windows-only capabilities unavailable on Linux and macOS', async () => {
    const loaded = await loadProfiles('distribution/profiles');
    if (!loaded.ok) throw new Error(loaded.error.code);
    for (const profile of loaded.value) {
      for (const id of ['windows.uia', 'windows.robotjs', 'windows.screenshots', 'windows.sapi']) {
        const capability = profile.capabilities.find(item => item.id === id);
        expect(capability?.support['linux-x64']).toBe('unavailable');
        expect(capability?.support['darwin-arm64']).toBe('unavailable');
      }
    }
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/contract/distributionProfiles.contract.test.ts
```

Expected: FAIL；公共 distribution types 与 profiles 尚不存在。

- [ ] **Step 3: 粘贴最小实现 `src/domain/distribution/types.ts`**

```ts
export type TargetPlatform =
  | 'win32-x64' | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';
export type SupportLevel = 'required' | 'optional' | 'unavailable';

export interface AssetIdentity {
  id: string;
  version: string;
  kind: 'package' | 'binary' | 'model' | 'runtime' | 'bundle' | 'sbom' | 'installer';
  target: TargetPlatform | 'any';
  sha256: string;
  size: number;
  mediaType: string;
  source: string;
  license: string;
}

export interface LockedPackage extends AssetIdentity {
  kind: 'package';
  packageName: string;
  integrity: `sha512-${string}`;
  resolved: `https://${string}`;
  dev: boolean;
  optional: boolean;
}

export interface LockedAsset extends AssetIdentity {
  kind: 'binary' | 'model' | 'runtime';
  target: TargetPlatform;
  urls: readonly [string, ...string[]];
  executable: boolean;
  unpack?: { format: 'zip' | 'tar.gz' | 'none'; stripComponents: number };
}
```

- [ ] **Step 4: 粘贴最小实现 `src/domain/distribution/profile.ts`**

```ts
import type { AssetIdentity, LockedAsset, LockedPackage, SupportLevel, TargetPlatform } from './types.js';

export type ProfileId = 'core' | 'standard' | 'full-local-ai';
export type CapabilityId =
  | 'cli' | 'noninteractive' | 'jsonl' | 'wire' | 'session' | 'agent'
  | 'commands' | 'permissions' | 'hooks' | 'gateway' | 'memory' | 'mcp'
  | 'skill' | 'plugin' | 'pty' | 'browser.dom' | 'build' | 'verify' | 'evidence'
  | 'windows.uia' | 'windows.robotjs' | 'windows.screenshots' | 'windows.sapi'
  | 'memory.embedding' | 'local.llm' | 'voice.transcription' | 'vision.models' | 'airgap';

export interface CapabilityContract {
  id: CapabilityId;
  support: Record<TargetPlatform, SupportLevel>;
}

export interface DistributionProfile {
  schemaVersion: 1;
  id: ProfileId;
  version: string;
  capabilities: CapabilityContract[];
  packages: LockedPackage[];
  binaries: LockedAsset[];
  models: LockedAsset[];
}

export interface CapabilityReport {
  profile: ProfileId;
  platform: TargetPlatform;
  profileDigest: string;
  generatedAt: string;
  entries: Array<{
    id: CapabilityId;
    contract: SupportLevel;
    state: 'available' | 'degraded' | 'unavailable' | 'blocked';
    source?: AssetIdentity;
    reasonCode?: string;
    remediation?: string;
  }>;
}
```

- [ ] **Step 5: 创建三份 manifest 的精确能力规则**

所有 manifest 都列出上面全部 capability IDs 和五个 `TargetPlatform` key。精确规则：

1. Core：`cli/noninteractive/jsonl/wire/session/agent/mcp/skill/build/commands/permissions/hooks/gateway` 全平台 required；`memory/plugin/pty/browser.dom/verify/evidence/airgap` 全平台 optional；Windows-only 与 local-AI 能力 unavailable。这里的 `build` 指设计合同中的基础 Build 链，`verify/evidence` 指完整 Verify/Evidence，禁止把 Optional 提升为 Required。
2. Standard：Core required 集合保持，并将 `memory/plugin/pty/browser.dom/verify/evidence` 全平台提升为 required；Windows-only 四项仅 `win32-x64` required，其余 unavailable；embedding/local LLM/voice/vision 全平台 optional；airgap optional。
3. Full Local AI：Standard required 集合保持；Windows-only 四项仅 Windows required；embedding/local LLM/voice/vision/airgap 全平台 required。

初始 `packages/binaries/models` 使用空数组通过 schema；W4-06 将 package lock identity 写入三份 manifest，W4-08 将 binary/model lock identity 写入对应 manifest。任何缺 key 返回 `PROFILE_SCHEMA_INVALID`。

- [ ] **Step 6: 实现 CapabilityReport**

`CapabilityReportService` 对每个 manifest entry 调真实 probe：Required probe 失败为 `blocked` + `CAPABILITY_REQUIRED_MISSING`，Optional probe 失败为 `degraded`，Unavailable 调用为 `CAPABILITY_UNAVAILABLE`。`source` 必须是上面定义的 `AssetIdentity`，不得只记录 package name。

- [ ] **Step 7: 运行完整 W4-05 验证**

```powershell
npm.cmd exec -- vitest run tests/contract/distributionProfiles.contract.test.ts tests/integration/capabilityReport.test.ts tests/property/profileCapabilityMatrix.test.ts tests/capability-registry.test.ts
npm.cmd run typecheck
```

---

## Task W4-06：根包、Ink package boundary 与可复现 pack

**Requirements/Subprojects:** R11、R12、R17-R18；S12；Gate A/H

**唯一 Ink 修复方案:** 当前 `@wxnodus/ink` runtime 入口转发到 `dist/entry-exports.js`，但 build 只生成 JS，types 却直指 `src/*.ts(x)`。唯一修复为：创建 package `tsconfig.json`，使用 `tsc` 同时生成 `dist/*.js` 与 `dist/*.d.ts`，所有 exports 只指向 `dist`；删除四个根级 wrapper。不得保留“修 output 或改 exports 二选一”。

**Files**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `distribution/profiles/core.json`
- Modify: `distribution/profiles/standard.json`
- Modify: `distribution/profiles/full-local-ai.json`
- Modify: `packages/wxnodus-ink/package.json`
- Create: `packages/wxnodus-ink/tsconfig.json`
- Create: `packages/wxnodus-ink/src/text-input.ts`
- Delete: `packages/wxnodus-ink/index.js`
- Delete: `packages/wxnodus-ink/index.d.ts`
- Delete: `packages/wxnodus-ink/text-input.js`
- Delete: `packages/wxnodus-ink/text-input.d.ts`
- Create: `LICENSE`
- Create: `.npmignore`
- Create: `scripts/check-node-version.mjs`
- Create: `scripts/check-package-boundary.mjs`
- Create: `scripts/build-packages.mjs`
- Create: `scripts/pack-release.mjs`
- Create: `tests/package/rootPackage.test.ts`
- Create: `tests/package/inkPackage.test.ts`
- Create: `tests/package/cleanPackInstall.test.ts`
- Modify: `vitest.config.ts`

**package.json script → runner**

| npm script | runner |
|---|---|
| `preflight:node` | `node scripts/check-node-version.mjs` |
| `build` | `node scripts/build-packages.mjs` |
| `check:package-boundary` | `node scripts/check-package-boundary.mjs` |
| `pack:release` | `node scripts/pack-release.mjs` |

- [ ] **Step 1: 粘贴完整红测 `tests/package/inkPackage.test.ts`**

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('@wxnodus/ink package boundary', () => {
  it('exports only built JS and declaration files', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'packages/wxnodus-ink/package.json'), 'utf8'));
    expect(pkg.main).toBe('./dist/entry-exports.js');
    expect(pkg.types).toBe('./dist/entry-exports.d.ts');
    expect(pkg.exports['.']).toEqual({
      types: './dist/entry-exports.d.ts', import: './dist/entry-exports.js', default: './dist/entry-exports.js',
    });
    expect(pkg.exports['./text-input']).toEqual({
      types: './dist/text-input.d.ts', import: './dist/text-input.js', default: './dist/text-input.js',
    });
  });

  it('can be packed, installed and imported outside the workspace', async () => {
    const output = await mkdtemp(join(tmpdir(), 'wxn-ink-pack-'));
    const packed = spawnSync('npm.cmd', ['pack', '--json', '--pack-destination', output], {
      cwd: join(root, 'packages/wxnodus-ink'), encoding: 'utf8', shell: false,
    });
    expect(packed.status, packed.stderr).toBe(0);
    const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    const app = await mkdtemp(join(tmpdir(), 'wxn-ink-app-'));
    expect(spawnSync('npm.cmd', ['init', '-y'], { cwd: app, encoding: 'utf8', shell: false }).status).toBe(0);
    expect(spawnSync('npm.cmd', ['install', join(output, filename)], { cwd: app, encoding: 'utf8', shell: false }).status).toBe(0);
    const imported = spawnSync('node', ['--input-type=module', '-e', "import('@wxnodus/ink').then(m=>console.log(typeof m.render))"], {
      cwd: app, encoding: 'utf8', shell: false,
    });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout.trim()).toBe('function');
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/package/inkPackage.test.ts
```

Expected: FAIL；当前 types/exports 不指向统一 dist declaration output，且 package 没有 `tsconfig.json`。

- [ ] **Step 3: 粘贴 `packages/wxnodus-ink/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": false,
    "sourceMap": false,
    "emitDeclarationOnly": false,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "jsx": "react-jsx",
    "types": ["node", "react"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "ambient.d.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx", "dist", "node_modules"]
}
```

- [ ] **Step 4: 粘贴完整 `scripts/build-packages.mjs`**

```js
import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const run = (command, args, cwd = process.cwd()) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

await rm('dist', { recursive: true, force: true });
await rm('packages/wxnodus-ink/dist', { recursive: true, force: true });
run('npm.cmd', ['exec', '--', 'tsc', '-p', 'packages/wxnodus-ink/tsconfig.json']);
run('npm.cmd', ['exec', '--', 'tsc', '-p', 'tsconfig.json']);
```

- [ ] **Step 5: 精确修改 package metadata**

`packages/wxnodus-ink/package.json` 设置：

```json
{
  "private": false,
  "files": ["dist", "LICENSE"],
  "main": "./dist/entry-exports.js",
  "types": "./dist/entry-exports.d.ts",
  "exports": {
    ".": {
      "types": "./dist/entry-exports.d.ts",
      "import": "./dist/entry-exports.js",
      "default": "./dist/entry-exports.js"
    },
    "./text-input": {
      "types": "./dist/text-input.d.ts",
      "import": "./dist/text-input.js",
      "default": "./dist/text-input.js"
    },
    "./package.json": "./package.json"
  },
  "scripts": { "build": "tsc -p tsconfig.json" }
}
```

根 `package.json` 设置 `files` allowlist、`bundleDependencies: ["@wxnodus/ink"]`、Node engine 精确字符串 `^22.22.2 || ^24.15.0 || >=26.0.0`，保留 `@wxnodus/ink` file dependency 但在 pack 时作为 bundled dependency 收入 tgz。新增唯一 `scripts/check-node-version.mjs`（npm script `preflight:node`），使用 `semver.satisfies(process.versions.node, '^22.22.2 || ^24.15.0 || >=26.0.0')`，不满足时打印 detected/required 并退出 `1`；`install.mjs`、`upgrade.mjs`、`recover.mjs`、`uninstall.mjs` 与全部 CI jobs 的第一条应用命令都必须调用它，且发生在 `npm ci`、artifact download、network fetch、staging 或 destination 写入前。workflows 的 `actions/setup-node` matrix 仅允许 `22.22.2`、`24.15.0` 和一个当时可用的 `26.x`，随后同时断言 `npm pkg get engines.node` 等于精确 range 和 `npm.cmd run preflight:node`/`npm run preflight:node` 退出 `0`。`pack-release.mjs` 必须先 preflight、build、package-boundary check，再 `npm pack --json`；不得 publish。三份 profile 的 `packages` 从 `package-lock.json` 解析为 `LockedPackage[]`，不手写 integrity。

- [ ] **Step 6: 运行完整 W4-06 验证**

```powershell
npm.cmd run build
npm.cmd run check:package-boundary
npm.cmd exec -- vitest run tests/package/rootPackage.test.ts tests/package/inkPackage.test.ts tests/package/cleanPackInstall.test.ts
npm.cmd run check:test-discovery
npm.cmd run typecheck
```

---

## Task W4-07：受信安装、升级、恢复、airgap、卸载与 diagnostics

**Requirements/Subprojects:** R17-R18；S12；Gate C/H

**Files**
- Create: `src/domain/distribution/releaseManifest.ts`
- Create: `src/application/distribution/releaseTrustVerifier.ts`
- Create: `src/application/distribution/lifecycleService.ts`
- Create: `src/infrastructure/distribution/installJournal.ts`
- Create: `src/infrastructure/distribution/receiptAuthenticator.ts`
- Create: `src/infrastructure/distribution/atomicDistributionInstaller.ts`
- Create: `src/infrastructure/distribution/replayStore.ts`
- Create: `scripts/install.mjs`
- Create: `scripts/upgrade.mjs`
- Create: `scripts/recover.mjs`
- Create: `scripts/uninstall.mjs`
- Create: `scripts/diagnose.mjs`
- Create: `scripts/install-windows.ps1`
- Create: `scripts/install-posix.sh`
- Create: `docs/operations/install.md`
- Create: `docs/operations/upgrade-recovery.md`
- Create: `docs/operations/uninstall.md`
- Create: `tests/distribution/installLifecycle.test.ts`
- Create: `tests/distribution/upgradeRecovery.test.ts`
- Create: `tests/distribution/uninstall.test.ts`
- Create: `tests/security/releaseTrustLifecycle.test.ts`
- Create: `tests/security/releaseReceiptAuth.test.ts`
- Create: `tests/integration/distributionAtomicEffects.test.ts`
- Create: `tests/failure/distributionInterruption.test.ts`
- Modify: `package.json`

**package.json script → runner**

| npm script | runner |
|---|---|
| `dist:install` | `node scripts/install.mjs` |
| `dist:upgrade` | `node scripts/upgrade.mjs` |
| `dist:recover` | `node scripts/recover.mjs` |
| `dist:uninstall` | `node scripts/uninstall.mjs` |
| `dist:diagnose` | `node scripts/diagnose.mjs` |

`install.mjs`、`upgrade.mjs`、`recover.mjs`、`uninstall.mjs`、`diagnose.mjs` 都是直接消费相邻 service 的薄 Node runners：统一解析 `--release-manifest`、`--signature-bundle`、`--receipt`、`--destination`、`--bundle`、`--purge`，最先执行 W4-06 `preflight:node`；unsupported Node 在读取/下载发行 artifact 或写 staging/destination 前退出 `1`。之后 runner 调 `ReleaseTrustVerifier`/receipt verifier，再调用 `DistributionLifecycleService`，并将 `OperationResult` 序列化为 JSONL；不得在 runner 中复制 trust 或 lifecycle 规则。`install.mjs` 是唯一 platform dispatcher：Windows 调 `powershell.exe -File scripts/install-windows.ps1`，Linux/macOS 调 `sh scripts/install-posix.sh`；两个 platform script 不直接映射 npm script，也不能自行返回未经 service postcondition 证明的 success。

**Interfaces**

```ts
export interface VerifiedReleaseManifest {
  readonly kind: 'verified-release-manifest';
  readonly manifestDigest: string;
  readonly installationArtifactId: string;
  readonly profileDigest: string;
  readonly assetLockDigest: string;
  readonly releaseId: string;
  readonly nonce: string;
  readonly signerIdentity: string;
  readonly issuer: string;
  readonly artifacts: readonly AssetIdentity[];
  readonly canonicalManifest: Uint8Array;
  readonly signatureBundle: unknown;
}

export interface VerifiedReleaseReceipt {
  readonly kind: 'verified-release-receipt';
  readonly releaseId: string;
  readonly manifestDigest: string;
  readonly installedDigest: string;
  readonly releaseNonce: string;
  readonly operationNonce: string;
  readonly destination: string;
  readonly ownershipJournalDigest: string;
  readonly operation: 'install' | 'upgrade' | 'recover' | 'airgap' | 'uninstall';
  readonly verifiedAt: string;
  readonly authentication: {
    readonly algorithm: 'sigstore-bundle' | 'hmac-sha256';
    readonly keyId: string;
    readonly value: string;
  };
  readonly canonicalReceipt: Uint8Array;
}

export interface DistributionLifecycleService {
  install(input: { release: VerifiedReleaseManifest; destination: string; operationNonce: string }, signal: AbortSignal): Promise<OperationResult<VerifiedReleaseReceipt>>;
  upgrade(input: { current: VerifiedReleaseReceipt; release: VerifiedReleaseManifest; operationNonce: string }, signal: AbortSignal): Promise<OperationResult<VerifiedReleaseReceipt>>;
  recover(input: { receipt: VerifiedReleaseReceipt; release: VerifiedReleaseManifest; operationNonce: string }, signal: AbortSignal): Promise<OperationResult<VerifiedReleaseReceipt>>;
  airgap(input: { release: VerifiedReleaseManifest; bundlePath: string; destination: string; operationNonce: string }, signal: AbortSignal): Promise<OperationResult<VerifiedReleaseReceipt>>;
  uninstall(input: { receipt: VerifiedReleaseReceipt; purge: boolean; operationNonce: string }, signal: AbortSignal): Promise<OperationResult<VerifiedReleaseReceipt>>;
}
```

- [ ] **Step 1: 粘贴完整红测 `tests/security/releaseTrustLifecycle.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { DistributionLifecycleService } from '../../src/application/distribution/lifecycleService.js';
import type { VerifiedReleaseManifest } from '../../src/domain/distribution/releaseManifest.js';

const release = (): VerifiedReleaseManifest => ({
  kind: 'verified-release-manifest',
  manifestDigest: '1'.repeat(64),
  installationArtifactId: 'wxnodus-tgz',
  profileDigest: '3'.repeat(64),
  assetLockDigest: '4'.repeat(64),
  releaseId: 'v4.0.0-win32-x64-standard',
  nonce: 'nonce-1',
  signerIdentity: 'https://github.com/WxNodus/WxNodusV3CLI/.github/workflows/release-candidate.yml@refs/heads/master',
  issuer: 'https://token.actions.githubusercontent.com',
  artifacts: [{
    id: 'wxnodus-tgz', version: '4.0.0', kind: 'installer', target: 'win32-x64',
    sha256: '2'.repeat(64), size: 10, mediaType: 'application/gzip',
    source: 'https://github.com/WxNodus/WxNodusV3CLI', license: 'Apache-2.0',
  }],
  canonicalManifest: new TextEncoder().encode('{"releaseId":"v4.0.0-win32-x64-standard"}'),
  signatureBundle: { mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3' },
});

const createService = (verifyCode?: string, installedDigest = '2'.repeat(64)) => {
  const verifier = {
    reverify: vi.fn(async () => verifyCode
      ? { ok: false as const, error: { code: verifyCode, message: verifyCode, messageKey: verifyCode, retryable: false } }
      : { ok: true as const, value: undefined }),
  };
  const replay = { consume: vi.fn(async () => ({ ok: true as const, value: undefined })) };
  const receipt = {
    verify: vi.fn(async () => ({ ok: true as const, value: undefined })),
    issue: vi.fn(async (input: Record<string, unknown>) => ({ ok: true as const, value: {
      ...input, kind: 'verified-release-receipt' as const,
      authentication: { algorithm: 'hmac-sha256' as const, keyId: 'install-key', value: 'b'.repeat(64) },
      canonicalReceipt: new Uint8Array([1]),
    } })),
  };
  const installer = {
    stage: vi.fn(async () => ({ ok: true as const, value: { stagedPath: 'stage', digest: installedDigest } })),
    commit: vi.fn(async () => ({ ok: true as const, value: {
      changed: true, installedDigest, ownershipJournalDigest: 'c'.repeat(64), postconditionPassed: true,
    } })),
    rollback: vi.fn(async () => ({ ok: true as const, value: undefined })),
    uninstall: vi.fn(),
  };
  return { service: new DistributionLifecycleService({ verifier, replay, receipt, installer }), verifier, replay, receipt, installer };
};

describe('release trust before lifecycle writes', () => {
  it.each([
    'RELEASE_UNSIGNED', 'RELEASE_IDENTITY_MISMATCH', 'RELEASE_ISSUER_MISMATCH',
    'RELEASE_SIGNATURE_INVALID', 'RELEASE_PROFILE_DIGEST_MISMATCH',
    'RELEASE_LOCK_DIGEST_MISMATCH', 'RELEASE_ARTIFACT_DIGEST_MISMATCH',
    'RELEASE_MANIFEST_SWAPPED', 'RELEASE_REPLAYED',
  ])('blocks %s before staging', async code => {
    const { service, installer } = createService(code);
    const result = await service.install({ release: release(), destination: 'C:/WxNodus', operationNonce: 'op-1' }, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(installer.stage).not.toHaveBeenCalled();
    expect(installer.commit).not.toHaveBeenCalled();
  });

  it('binds installed digest to the signed artifact digest', async () => {
    const { service, installer } = createService(undefined, '9'.repeat(64));
    const result = await service.install({ release: release(), destination: 'C:/WxNodus', operationNonce: 'op-1' }, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'RELEASE_INSTALL_DIGEST_MISMATCH' } });
    expect(installer.rollback).toHaveBeenCalled();
  });

  it('returns a verified receipt only after reverify, replay consume, stage and commit', async () => {
    const { service, verifier, replay, installer } = createService();
    const result = await service.install({ release: release(), destination: 'C:/WxNodus', operationNonce: 'op-1' }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { kind: 'verified-release-receipt', installedDigest: '2'.repeat(64) } });
    expect(verifier.reverify.mock.invocationCallOrder[0]).toBeLessThan(replay.consume.mock.invocationCallOrder[0]);
    expect(replay.consume.mock.invocationCallOrder[0]).toBeLessThan(installer.stage.mock.invocationCallOrder[0]);
    expect(installer.stage.mock.invocationCallOrder[0]).toBeLessThan(installer.commit.mock.invocationCallOrder[0]);
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/security/releaseTrustLifecycle.test.ts
```

Expected: FAIL；受信 release-only lifecycle 尚不存在。

- [ ] **Step 3: 粘贴最小实现 `src/application/distribution/lifecycleService.ts`**

```ts
import type { OperationResult } from '../../protocol/results.js';
import type { VerifiedReleaseManifest, VerifiedReleaseReceipt } from '../../domain/distribution/releaseManifest.js';

interface Dependencies {
  verifier: { reverify(release: VerifiedReleaseManifest): Promise<OperationResult<void>> };
  receipt: {
    verify(receipt: VerifiedReleaseReceipt): Promise<OperationResult<void>>;
    issue(input: Omit<VerifiedReleaseReceipt, 'kind' | 'authentication' | 'canonicalReceipt'>): Promise<OperationResult<VerifiedReleaseReceipt>>;
  };
  replay: { consume(nonce: string, manifestDigest: string): Promise<OperationResult<void>> };
  installer: {
    stage(release: VerifiedReleaseManifest, source: string, destination: string, signal: AbortSignal): Promise<OperationResult<{ stagedPath: string; digest: string }>>;
    commit(stagedPath: string, destination: string, signal: AbortSignal): Promise<OperationResult<{ changed: boolean; installedDigest: string; ownershipJournalDigest: string; postconditionPassed: boolean }>>;
    rollback(stagedPath: string): Promise<OperationResult<void>>;
    uninstall(receipt: VerifiedReleaseReceipt, purge: boolean, signal: AbortSignal): Promise<OperationResult<{ changed: boolean; ownershipJournalDigest: string; remainingOwnedPaths: string[]; postconditionPassed: boolean }>>;
  };
}

const fail = (code: string, message: string): OperationResult<never> => ({
  ok: false, error: { code, message, messageKey: code, retryable: false },
});

export class DistributionLifecycleService {
  constructor(private readonly deps: Dependencies) {}

  install(input: { release: VerifiedReleaseManifest; destination: string; operationNonce: string }, signal: AbortSignal) {
    return this.apply(input.release, 'install', 'network', input.destination, input.operationNonce, signal);
  }

  async upgrade(input: { current: VerifiedReleaseReceipt; release: VerifiedReleaseManifest; operationNonce: string }, signal: AbortSignal) {
    const trusted = await this.deps.receipt.verify(input.current);
    if (!trusted.ok) return trusted;
    return this.apply(input.release, 'upgrade', `upgrade:${input.current.manifestDigest}`, input.current.destination, input.operationNonce, signal);
  }

  async recover(input: { receipt: VerifiedReleaseReceipt; release: VerifiedReleaseManifest; operationNonce: string }, signal: AbortSignal) {
    const trusted = await this.deps.receipt.verify(input.receipt);
    if (!trusted.ok) return trusted;
    if (input.receipt.releaseId !== input.release.releaseId) return fail('RELEASE_MANIFEST_SWAPPED', 'Receipt and release id differ');
    return this.apply(input.release, 'recover', `recovery:${input.receipt.manifestDigest}`, input.receipt.destination, input.operationNonce, signal);
  }

  airgap(input: { release: VerifiedReleaseManifest; bundlePath: string; destination: string; operationNonce: string }, signal: AbortSignal) {
    return this.apply(input.release, 'airgap', `airgap:${input.bundlePath}`, input.destination, input.operationNonce, signal);
  }

  async uninstall(input: { receipt: VerifiedReleaseReceipt; purge: boolean; operationNonce: string }, signal: AbortSignal): Promise<OperationResult<VerifiedReleaseReceipt>> {
    const trusted = await this.deps.receipt.verify(input.receipt);
    if (!trusted.ok) return trusted;
    const consumed = await this.deps.replay.consume(input.operationNonce, input.receipt.manifestDigest);
    if (!consumed.ok) return consumed;
    const removed = await this.deps.installer.uninstall(input.receipt, input.purge, signal);
    if (!removed.ok) return removed;
    if (!removed.value.changed) return fail('DISTRIBUTION_NO_EFFECT', 'Uninstall produced no filesystem transition');
    if (!removed.value.postconditionPassed || removed.value.remainingOwnedPaths.length > 0) {
      return fail('DISTRIBUTION_POSTCONDITION_FAILED', 'Owned paths remain after uninstall');
    }
    return this.deps.receipt.issue({
      releaseId: input.receipt.releaseId, manifestDigest: input.receipt.manifestDigest,
      installedDigest: '0'.repeat(64), releaseNonce: input.receipt.releaseNonce,
      operationNonce: input.operationNonce, destination: input.receipt.destination,
      ownershipJournalDigest: removed.value.ownershipJournalDigest, operation: 'uninstall',
      verifiedAt: new Date().toISOString(),
    });
  }

  private async apply(
    release: VerifiedReleaseManifest,
    operation: 'install' | 'upgrade' | 'recover' | 'airgap',
    source: string,
    destination: string,
    operationNonce: string,
    signal: AbortSignal,
  ): Promise<OperationResult<VerifiedReleaseReceipt>> {
    const verified = await this.deps.verifier.reverify(release);
    if (!verified.ok) return verified;
    const consumed = await this.deps.replay.consume(operationNonce, release.manifestDigest);
    if (!consumed.ok) return consumed;
    const artifact = release.artifacts.find(item => item.id === release.installationArtifactId);
    if (!artifact) return fail('RELEASE_ARTIFACT_DIGEST_MISMATCH', 'Installation artifact is absent from signed manifest');
    const staged = await this.deps.installer.stage(release, source, destination, signal);
    if (!staged.ok) return staged;
    if (staged.value.digest !== artifact.sha256) {
      await this.deps.installer.rollback(staged.value.stagedPath);
      return fail('RELEASE_INSTALL_DIGEST_MISMATCH', 'Staged digest differs from signed artifact digest');
    }
    const committed = await this.deps.installer.commit(staged.value.stagedPath, destination, signal);
    if (!committed.ok) {
      await this.deps.installer.rollback(staged.value.stagedPath);
      return committed;
    }
    if (!committed.value.changed) return fail('DISTRIBUTION_NO_EFFECT', 'Lifecycle produced no filesystem transition');
    if (!committed.value.postconditionPassed) return fail('DISTRIBUTION_POSTCONDITION_FAILED', 'Installed process postcondition did not pass');
    if (committed.value.installedDigest !== artifact.sha256) {
      await this.deps.installer.rollback(staged.value.stagedPath);
      return fail('RELEASE_INSTALL_DIGEST_MISMATCH', 'Installed digest differs from signed artifact digest');
    }
    return this.deps.receipt.issue({
      releaseId: release.releaseId, manifestDigest: release.manifestDigest,
      installedDigest: committed.value.installedDigest, releaseNonce: release.nonce,
      operationNonce, destination, ownershipJournalDigest: committed.value.ownershipJournalDigest,
      operation, verifiedAt: new Date().toISOString(),
    });
  }
}
```

真实 `ReleaseTrustVerifier.reverify()` 必须重新 canonicalize manifest、以发行包内 hash-pinned `trusted-root.json` 执行 Sigstore offline verify、匹配 anchored certificate identity regex、exact issuer/workflow identity、验证 integrated time/证书有效期与 policy freshness window、重算 profile/lock/all artifact digests，并确认传入对象字段与 canonical manifest 相等；TypeScript brand 不能代替运行时验证。`ReplayStore.consume()` 使用 durable CAS，release nonce、operation nonce、manifest digest 与 authenticated receipt 绑定；同 nonce 的重复副作用请求一律返回 `RELEASE_REPLAYED`，查询既有 receipt 使用独立只读 API，不能把重放 install 当作成功。

`receiptAuthenticator.ts` 先把 release ID、manifest digest、canonical/realpath-normalized destination、installed canonical tree digest、release nonce、single-use operation nonce、operation、ownership-journal digest、verifiedAt canonicalize；CI 发行 receipt 用 Sigstore bundle，终端本机 receipt 用 OS-protected install key 的 HMAC-SHA-256（Windows DPAPI/CNG protected key；macOS Keychain；Linux Secret Service 或 root-owned `0600` key）鉴别。Upgrade/recover/uninstall 在任何写入前都重算这些字段并 constant-time 验证 authentication；字段 swap、复制到另一 destination、错误 key、journal digest 变化均返回 `RELEASE_RECEIPT_AUTH_INVALID`。

`installJournal.ts` 是 destination sibling 的 durable append-only、hash-chained ownership log，每个 planned/applied/verified/committed/rolled-back record 都包含 operation ID、owned path、pre/post digest、backup path 和前项 hash；每个 record 与 parent directory 都 fsync。`atomicDistributionInstaller.ts` 必须在同卷 sibling staging 展开并拒绝 path/symlink/junction escape，验证 staged canonical tree digest，取得 destination lock，把既有 destination 原子 rename 到 backup、staging 原子 rename 到 destination，跑发行包进程的 version/smoke/read-back postcondition，再 fsync 和提交 journal；失败/Abort 必须依据 journal 恢复 backup 并验证原 digest。跨卷 copy、直接覆盖活跃目录或只有内存 journal 均禁止。

Install 必须证明 absent/old tree → signed tree；upgrade 必须证明 old authenticated tree → different signed tree，并保留可恢复 backup；recover 必须从 durable incomplete journal 实际完成 rollback 或 forward reconciliation；uninstall 只能删除 authenticated ownership journal 列出的 paths，保留非 owned 用户数据，验证 executable/owned files 消失并把 authenticated tombstone receipt 返回。目标已在期望 digest、版本相同无迁移、journal 为空、没有发生 rename/delete、smoke 未启动、postcondition 未观测或卸载后 owned path 仍存在，都返回 `DISTRIBUTION_NO_EFFECT`/`DISTRIBUTION_POSTCONDITION_FAILED`/`DISTRIBUTION_OWNERSHIP_MISMATCH`，绝不能 `{ ok: true }`。

Upgrade test 固定演练：V3 fixture → backup → V4 upgrade → 新版本写入 → 按 migration 声明 operational rollback 或 forward-only recovery/对账 → 再 upgrade → 读回；每一步断言 inode/path tree 或 digest、journal phase 和 child-process probe 都真实变化。中断返回 `RELEASE_INTERRUPTED` 且 journal 无半启用状态。`releaseReceiptAuth.test.ts` 覆盖所有绑定字段和 MAC/signature tamper；`distributionAtomicEffects.test.ts` 对 install/upgrade/recover/uninstall 的 no-op adapter 逐项期待非零稳定错误。

- [ ] **Step 4: 运行完整 W4-07 验证**

```powershell
npm.cmd exec -- vitest run tests/distribution/installLifecycle.test.ts tests/distribution/upgradeRecovery.test.ts tests/distribution/uninstall.test.ts tests/security/releaseTrustLifecycle.test.ts tests/failure/distributionInterruption.test.ts
npm.cmd run typecheck
```

---

## Task W4-08：公共资产类型消费、缓存与每-cell air-gapped bundle

**Requirements/Subprojects:** R08-R09、R17-R18；S12；Gate F/H/I

**Files**
- Create: `distribution/assets/local-ai.lock.json`
- Create: `distribution/assets/local-ai.schema.json`
- Create: `src/domain/distribution/assetLock.ts`
- Create: `src/application/distribution/assetService.ts`
- Create: `src/infrastructure/distribution/httpAssetFetcher.ts`
- Create: `src/infrastructure/distribution/assetCache.ts`
- Create: `scripts/fetch-assets.mjs`
- Create: `scripts/verify-asset-lock.mjs`
- Create: `scripts/build-airgap-bundle.mjs`
- Create: `scripts/verify-airgap-bundle.mjs`
- Create: `docs/operations/air-gapped-install.md`
- Create: `tests/distribution/assetLock.test.ts`
- Create: `tests/distribution/offlineInstall.test.ts`
- Create: `tests/security/assetDownloadPolicy.test.ts`
- Create: `tests/failure/assetDownloadFailure.test.ts`
- Modify: `distribution/profiles/core.json`
- Modify: `distribution/profiles/standard.json`
- Modify: `distribution/profiles/full-local-ai.json`
- Modify: `package.json`

**package.json script → runner**

| npm script | runner |
|---|---|
| `assets:fetch` | `node scripts/fetch-assets.mjs` |
| `assets:verify-lock` | `node scripts/verify-asset-lock.mjs` |
| `bundle:airgap` | `node scripts/build-airgap-bundle.mjs` |
| `bundle:verify-airgap` | `node scripts/verify-airgap-bundle.mjs` |

`assetLock.ts` 必须 `import type { LockedAsset, TargetPlatform } from './types.js'`，只新增 `AssetLock` aggregate；不得重新声明公共类型。

- [ ] **Step 1: 粘贴完整红测 `tests/distribution/assetLock.test.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateAssetLock } from '../../src/domain/distribution/assetLock.js';
import type { LockedAsset } from '../../src/domain/distribution/types.js';

const validAsset: LockedAsset = {
  id: 'fixture-runtime', version: '1.0.0', kind: 'runtime', target: 'linux-x64',
  sha256: 'a'.repeat(64), size: 12, mediaType: 'application/octet-stream',
  source: 'https://downloads.wxnodus.example/fixture-runtime-1.0.0', license: 'Apache-2.0',
  urls: ['https://downloads.wxnodus.example/fixture-runtime-1.0.0'], executable: true,
  unpack: { format: 'none', stripComponents: 0 },
};

describe('asset lock', () => {
  it('consumes the public LockedAsset type and accepts a complete lock', () => {
    const result = validateAssetLock({ schemaVersion: 1, assets: [validAsset] });
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ['sha256', 'ASSET_LOCK_INVALID'],
    ['size', 'ASSET_LOCK_INVALID'],
    ['license', 'ASSET_LOCK_INVALID'],
    ['source', 'ASSET_LOCK_INVALID'],
    ['urls', 'ASSET_LOCK_INVALID'],
  ])('rejects a lock missing %s', (field, code) => {
    const broken = { ...validAsset } as Record<string, unknown>;
    delete broken[field];
    expect(validateAssetLock({ schemaVersion: 1, assets: [broken] })).toMatchObject({ ok: false, error: { code } });
  });

  it('keeps the committed lock free of workspace and file URLs', async () => {
    const text = await readFile('distribution/assets/local-ai.lock.json', 'utf8');
    expect(text).not.toContain('file:');
    expect(text).not.toContain('localhost');
    expect(text).not.toContain('C:\\');
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/distribution/assetLock.test.ts
```

Expected: FAIL；asset lock aggregate 尚不存在。

- [ ] **Step 3: 粘贴最小实现 `src/domain/distribution/assetLock.ts`**

```ts
import type { OperationResult } from '../../protocol/results.js';
import type { LockedAsset } from './types.js';

export interface AssetLock { schemaVersion: 1; assets: LockedAsset[] }

const fail = (message: string): OperationResult<never> => ({
  ok: false,
  error: { code: 'ASSET_LOCK_INVALID', message, messageKey: 'ASSET_LOCK_INVALID', retryable: false },
});

export function validateAssetLock(value: unknown): OperationResult<AssetLock> {
  if (!value || typeof value !== 'object') return fail('Asset lock must be an object');
  const lock = value as Partial<AssetLock>;
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.assets)) return fail('Asset lock schema is invalid');
  for (const item of lock.assets as Array<Partial<LockedAsset>>) {
    if (!item.id || !item.version || !item.kind || !item.target) return fail('Asset identity is incomplete');
    if (!item.sha256 || !/^[a-f0-9]{64}$/.test(item.sha256)) return fail('Asset digest is invalid');
    if (!Number.isSafeInteger(item.size) || Number(item.size) <= 0) return fail('Asset size is invalid');
    if (!item.mediaType || !item.source || !item.license) return fail('Asset provenance is incomplete');
    if (!Array.isArray(item.urls) || item.urls.length === 0 || item.urls.some(url => !url.startsWith('https://'))) return fail('Asset URLs must be HTTPS');
    if (typeof item.executable !== 'boolean') return fail('Executable flag is required');
  }
  return { ok: true, value: lock as AssetLock };
}
```

- [ ] **Step 4: 实现下载与 airgap 约束**

`httpAssetFetcher.ts` 对初始 URL 和每次 redirect 都执行 HTTPS、host allowlist、DNS/address policy；流式读取时同时限制 declared size 与最大 size，partial 写唯一 temp，完成后重算 SHA-256，再 atomic rename。错误分别为 `ASSET_SOURCE_DENIED`、`ASSET_SIZE_MISMATCH`、`ASSET_DIGEST_MISMATCH`。

`build-airgap-bundle.mjs` 输入必须是 W4-07 的 `VerifiedReleaseManifest`，按该 release matrix cell 收集 package、installer、profile、asset lock、SBOM、license、signature、provenance 和该 cell Required/Optional 资产；每个 Required release matrix cell 都生成 bundle。`verify-airgap-bundle.mjs` 在网络禁用环境重算全 digest 并调用 `DistributionLifecycleService.airgap()`；缺文件返回 `AIRGAP_BUNDLE_INCOMPLETE`。

- [ ] **Step 5: 运行完整 W4-08 验证**

```powershell
npm.cmd run assets:verify-lock
npm.cmd exec -- vitest run tests/distribution/assetLock.test.ts tests/distribution/offlineInstall.test.ts tests/security/assetDownloadPolicy.test.ts tests/failure/assetDownloadFailure.test.ts
npm.cmd run typecheck
```

---

## Task W4-09：每-cell SBOM、许可证、hash、Sigstore、provenance 与审计导出

**Requirements/Subprojects:** R10、R17-R18；S12；Gate F/H/I

**Dependency decision:** 只使用 `@cyclonedx/cyclonedx-npm@6.0.1` 生成 npm CycloneDX SBOM，使用 `sigstore@5.0.0` 完成 OIDC keyless sign/verify。两者 exact pin，不使用 caret/tilde，不再列替代依赖。`sigstore@5.0.0` 要求 Node `^22.22.2 || ^24.15.0 || >=26.0.0`，已在 W4-06 同步 engine。

**Files**
- Create: `src/domain/release/supplyChain.ts`
- Create: `src/application/release/supplyChainService.ts`
- Create: `src/infrastructure/release/sigstoreReleaseSigner.ts`
- Create: `src/infrastructure/release/sigstoreReleaseVerifier.ts`
- Create: `scripts/release/generate-sbom.mjs`
- Create: `scripts/release/check-licenses.mjs`
- Create: `scripts/release/hash-artifacts.mjs`
- Create: `scripts/release/sign-artifacts.mjs`
- Create: `scripts/release/verify-artifacts.mjs`
- Create: `scripts/release/export-audit.mjs`
- Create: `scripts/release/run-supply-chain.mjs`
- Create: `distribution/policy/licenses.json`
- Create: `distribution/trust/sigstore-policy.json`
- Create: `distribution/trust/trusted-root.json`
- Create: `tests/release/sbom.test.ts`
- Create: `tests/release/licenses.test.ts`
- Create: `tests/release/signature.test.ts`
- Create: `tests/release/auditExport.test.ts`
- Create: `tests/release/supplyChainMatrix.test.ts`
- Create: `tests/security/releaseTamper.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**package.json script → runner**

| npm script | runner |
|---|---|
| `release:sbom` | `node scripts/release/generate-sbom.mjs` |
| `release:licenses` | `node scripts/release/check-licenses.mjs` |
| `release:hash` | `node scripts/release/hash-artifacts.mjs` |
| `release:sign` | `node scripts/release/sign-artifacts.mjs` |
| `release:verify` | `node scripts/release/verify-artifacts.mjs` |
| `release:audit-export` | `node scripts/release/export-audit.mjs` |
| `release:supply-chain` | `node scripts/release/run-supply-chain.mjs` |

**Exact trust policy**

```json
{
  "schemaVersion": 1,
  "issuer": "https://token.actions.githubusercontent.com",
  "certificateIdentityURI": "^https://github\\.com/WxNodus/WxNodusV3CLI/\\.github/workflows/release-candidate\\.yml@refs/heads/master$",
  "workflowRef": "WxNodus/WxNodusV3CLI/.github/workflows/release-candidate.yml@refs/heads/master",
  "bundleMediaType": "application/vnd.dev.sigstore.bundle+json;version=0.3",
  "requiredPredicateTypes": [
    "https://slsa.dev/provenance/v1",
    "https://cyclonedx.org/bom"
  ],
  "maxEnvelopeAgeSeconds": 86400,
  "maxClockSkewSeconds": 300,
  "tlogThreshold": 1,
  "ctLogThreshold": 1,
  "offlineTrustedRootPath": "distribution/trust/trusted-root.json"
}
```

`certificateIdentityURI` 必须以 `^`/`$` 锚定，加载 policy 时先编译 regex 并拒绝缺锚、无效 escape 或扩大 repo/workflow/ref 的表达式；issuer 和 `workflowRef` 分别 exact equality，不能只靠 regex。`trusted-root.json` 是 release manifest 中 hash-pinned artifact，verifier 禁网并只读取该 snapshot；在线更新 trust root 是独立、审计并重新签名的发布输入，verify 过程不得隐式联网刷新。

```ts
export interface VerifiedSigstoreReleaseBundle {
  status: 'verified';
  subjectDigest: string;
  bundleDigest: string;
  issuer: string;
  certificateIdentity: string;
  workflowRef: string;
  integratedTime: string;
  trustRootDigest: string;
}

export interface VerifiedGitHubAttestation {
  status: 'verified';
  kind: 'build' | 'sbom';
  predicateType: string;
  subjectName: string;
  subjectDigest: string;
  bundleDigest: string;
  issuer: string;
  certificateIdentity: string;
  workflowRef: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  trustRootDigest: string;
}

export type NpmPublishProvenance =
  | { status: 'verified'; packageName: string; version: string; registry: 'https://registry.npmjs.org'; subjectDigest: string; attestationDigest: string }
  | { status: 'not-applicable'; reason: 'candidate-not-published' };
```

- [ ] **Step 1: 粘贴完整红测 `tests/release/supplyChainMatrix.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { validateSupplyChainReport } from '../../src/domain/release/supplyChain.js';

const proof = {
  status: 'verified' as const,
  subjectDigest: 'a'.repeat(64), bundleDigest: 'b'.repeat(64),
  issuer: 'https://token.actions.githubusercontent.com',
  certificateIdentity: 'https://github.com/WxNodus/WxNodusV3CLI/.github/workflows/release-candidate.yml@refs/heads/master',
  workflowRef: 'WxNodus/WxNodusV3CLI/.github/workflows/release-candidate.yml@refs/heads/master',
  integratedTime: '2026-08-13T00:00:00.000Z', trustRootDigest: 'c'.repeat(64),
};

const report = () => ({
  matrixCellId: 'ubuntu-24.04-x64-standard',
  artifacts: [{
    id: 'installer', version: '4.0.0', kind: 'installer' as const, target: 'linux-x64' as const,
    sha256: 'a'.repeat(64), size: 1, mediaType: 'application/gzip',
    source: 'https://github.com/WxNodus/WxNodusV3CLI', license: 'Apache-2.0',
  }],
  sbomDigest: 'd'.repeat(64), licenseReportDigest: 'e'.repeat(64), airgapBundleDigest: 'f'.repeat(64),
  releaseBundle: proof,
  githubAttestations: [
    { ...proof, kind: 'build' as const, predicateType: 'https://slsa.dev/provenance/v1', subjectName: 'installer', issuedAt: '2026-08-13T00:00:00.000Z', expiresAt: '2026-08-14T00:00:00.000Z', nonce: 'build-1' },
    { ...proof, kind: 'sbom' as const, predicateType: 'https://cyclonedx.org/bom', subjectName: 'sbom.cdx.json', subjectDigest: 'd'.repeat(64), issuedAt: '2026-08-13T00:00:00.000Z', expiresAt: '2026-08-14T00:00:00.000Z', nonce: 'sbom-1' },
  ],
  npmPublishProvenance: { status: 'not-applicable' as const, reason: 'candidate-not-published' as const },
});

describe('supply chain trust facts are independent', () => {
  it('requires release bundle plus GitHub build/SBOM attestations and explicit candidate npm N/A', () => {
    expect(validateSupplyChainReport(report())).toMatchObject({ ok: true });
  });

  it.each(['releaseBundle', 'githubAttestations', 'npmPublishProvenance'] as const)('rejects missing %s', field => {
    const broken = report() as Record<string, unknown>;
    delete broken[field];
    expect(validateSupplyChainReport(broken)).toMatchObject({ ok: false, error: { code: 'PROVENANCE_MISMATCH' } });
  });

  it('rejects a fake npm provenance digest for an unpublished candidate', () => {
    const broken = { ...report(), npmPublishProvenance: { status: 'verified', attestationDigest: '9'.repeat(64) } };
    expect(validateSupplyChainReport(broken)).toMatchObject({ ok: false, error: { code: 'PROVENANCE_MISMATCH' } });
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/release/supplyChainMatrix.test.ts
```

Expected: FAIL；per-cell supply-chain report 尚不存在。

- [ ] **Step 3: 粘贴最小实现 `src/domain/release/supplyChain.ts`**

```ts
import type { OperationResult } from '../../protocol/results.js';
import type { AssetIdentity } from '../distribution/types.js';

export interface SupplyChainReport {
  matrixCellId: string;
  artifacts: AssetIdentity[];
  sbomDigest: string;
  licenseReportDigest: string;
  airgapBundleDigest: string;
  releaseBundle: VerifiedSigstoreReleaseBundle;
  githubAttestations: readonly [VerifiedGitHubAttestation, VerifiedGitHubAttestation, ...VerifiedGitHubAttestation[]];
  npmPublishProvenance: NpmPublishProvenance;
}

const digest = /^[a-f0-9]{64}$/;
const fail = (message: string): OperationResult<never> => ({
  ok: false,
  error: { code: 'PROVENANCE_MISMATCH', message, messageKey: 'PROVENANCE_MISMATCH', retryable: false },
});

export function validateSupplyChainReport(value: unknown): OperationResult<SupplyChainReport> {
  if (!value || typeof value !== 'object') return fail('Supply-chain report must be an object');
  const report = value as Partial<SupplyChainReport>;
  if (!report.matrixCellId || !Array.isArray(report.artifacts) || report.artifacts.length === 0) return fail('Matrix cell artifacts are missing');
  if (![report.sbomDigest, report.licenseReportDigest, report.airgapBundleDigest].every(item => typeof item === 'string' && digest.test(item))) return fail('Cell digest set is incomplete');
  if (report.releaseBundle?.status !== 'verified' || report.releaseBundle.subjectDigest !== report.artifacts[0].sha256) return fail('Release bundle subject mismatch');
  const build = report.githubAttestations?.find(item => item.kind === 'build' && item.predicateType === 'https://slsa.dev/provenance/v1');
  const sbom = report.githubAttestations?.find(item => item.kind === 'sbom' && item.predicateType === 'https://cyclonedx.org/bom');
  if (!build || build.subjectDigest !== report.artifacts[0].sha256) return fail('GitHub build attestation is missing or mismatched');
  if (!sbom || sbom.subjectDigest !== report.sbomDigest) return fail('GitHub SBOM attestation is missing or mismatched');
  if (report.npmPublishProvenance?.status !== 'not-applicable' || report.npmPublishProvenance.reason !== 'candidate-not-published') {
    return fail('Candidate npm provenance must be explicit N/A');
  }
  return { ok: true, value: report as SupplyChainReport };
}
```

- [ ] **Step 4: 粘贴签名验证最小实现 `src/infrastructure/release/sigstoreReleaseVerifier.ts`**

```ts
import { createHash } from 'node:crypto';
import { verify } from 'sigstore';
import type { OperationResult } from '../../protocol/results.js';
import type { VerifiedReleaseManifest } from '../../domain/distribution/releaseManifest.js';

interface TrustPolicy {
  issuer: string;
  certificateIdentityURI: `^${string}$`;
  workflowRef: string;
  maxEnvelopeAgeSeconds: number;
  maxClockSkewSeconds: number;
  offlineTrustedRootPath: string;
  tlogThreshold: number;
  ctLogThreshold: number;
}

const fail = (code: string, message: string): OperationResult<never> => ({
  ok: false, error: { code, message, messageKey: code, retryable: false },
});

export class SigstoreReleaseVerifier {
  constructor(private readonly policy: TrustPolicy) {}

  async verifyEnvelope(input: {
    canonicalManifest: Uint8Array;
    bundle: unknown;
    claimedManifestDigest: string;
  }): Promise<OperationResult<VerifiedReleaseManifest>> {
    if (!input.bundle) return fail('RELEASE_UNSIGNED', 'Sigstore bundle is required');
    const digest = createHash('sha256').update(input.canonicalManifest).digest('hex');
    if (digest !== input.claimedManifestDigest) return fail('RELEASE_MANIFEST_SWAPPED', 'Canonical manifest digest differs from claim');
    try {
      const signer = await verify(input.bundle as never, Buffer.from(input.canonicalManifest), {
        certificateIssuer: this.policy.issuer,
        certificateIdentityURI: this.policy.certificateIdentityURI,
        tlogThreshold: this.policy.tlogThreshold,
        ctLogThreshold: this.policy.ctLogThreshold,
      });
      const parsed = JSON.parse(new TextDecoder().decode(input.canonicalManifest)) as Omit<VerifiedReleaseManifest, 'kind' | 'canonicalManifest' | 'signatureBundle'>;
      const expectedIdentity = new RegExp(this.policy.certificateIdentityURI);
      if (!this.policy.certificateIdentityURI.startsWith('^') || !this.policy.certificateIdentityURI.endsWith('$')) return fail('RELEASE_IDENTITY_MISMATCH', 'Identity policy must be anchored');
      if (!expectedIdentity.test(parsed.signerIdentity) || parsed.issuer !== this.policy.issuer) return fail('RELEASE_IDENTITY_MISMATCH', 'Signed identity/issuer differs from exact policy');
      // Adapter 必须从 signer 结构提取 certificate SAN、issuer、workflow ref 与 integrated time；String(signer) 禁止作为 identity。
      return {
        ok: true,
        value: {
          ...parsed,
          kind: 'verified-release-manifest',
          canonicalManifest: input.canonicalManifest,
          signatureBundle: input.bundle,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('issuer')) return fail('RELEASE_ISSUER_MISMATCH', message);
      if (message.includes('identity') || message.includes('SAN')) return fail('RELEASE_IDENTITY_MISMATCH', message);
      return fail('RELEASE_SIGNATURE_INVALID', message);
    }
  }
}
```

- [ ] **Step 5: 实现 exact SBOM/signing runners**

`generate-sbom.mjs` 对每个 required cell 执行：

```powershell
npm.cmd exec -- cyclonedx-npm --output-format JSON --spec-version 1.6 --validate --output-file artifacts/release-evidence/cells/cell-id/sbom.cdx.json
```

runner 用真实 cell ID 替换 argv 中的 `cell-id`，不使用 shell 拼接；随后把 binary/model `AssetIdentity` 作为 CycloneDX components 加入同一 cell SBOM。`sign-artifacts.mjs` 使用 `sigstore.sign(Buffer.from(canonicalManifest))`，无 GitHub OIDC/SIGSTORE_ID_TOKEN 时返回 `SIGNING_IDENTITY_UNAVAILABLE`，不能生成伪 bundle。`verify-artifacts.mjs` 分别运行且分别记录：

1. `SigstoreReleaseVerifier` 验证 release canonical manifest bundle 的 exact subject SHA-256、anchored certificate identity、issuer、workflow ref、Rekor integrated time、证书有效期与 max age；
2. `gh attestation verify <artifact> --repo WxNodus/WxNodusV3CLI --signer-workflow WxNodus/WxNodusV3CLI/.github/workflows/release-candidate.yml --predicate-type https://slsa.dev/provenance/v1 --bundle <build-bundle>` 验证 build subject；对 `sbom.cdx.json` 使用同样命令和 `--predicate-type https://cyclonedx.org/bom --bundle <sbom-bundle>`，解析 statement subject/digest/predicate/workflow/issuer，禁止只相信 CLI exit code；
3. candidate channel 强制写 `{ "status": "not-applicable", "reason": "candidate-not-published" }`；只有未来独立 publish workflow 真正 `npm publish --provenance` 后才能从 registry 下载并验证 npm attestation，candidate 不能生成或要求假 `provenanceDigest`。

三者不能互相代替。每份 attestation 的 `(kind, subjectDigest, nonce)` 进入 durable replay store；重复 nonce、过期、future beyond skew、wrong issuer/repo/workflow/predicate/subject 分别返回 `ATTESTATION_REPLAYED`、`ATTESTATION_FRESHNESS_INVALID`、`ATTESTATION_IDENTITY_MISMATCH` 或 `PROVENANCE_MISMATCH`。断网复验只使用随发行包固定且自身在 manifest 中有 hash 的 `distribution/trust/trusted-root.json` 与已下载 bundles，不访问 Fulcio/Rekor/GitHub/npm。

每个 cell 的 canonical manifest 必须绑定 commit、clean tree、Node/npm、profile digest、asset lock digest、runner OS/version/build/image、exact argv、artifact/SBOM/license/airgap digests，以及上述三条结构化 trust decision。篡改任一字节返回 `RELEASE_ARTIFACT_DIGEST_MISMATCH` 或 `PROVENANCE_MISMATCH`。

- [ ] **Step 6: 运行完整 W4-09 验证**

```powershell
npm.cmd exec -- vitest run tests/release/sbom.test.ts tests/release/licenses.test.ts tests/release/signature.test.ts tests/release/auditExport.test.ts tests/release/supplyChainMatrix.test.ts tests/security/releaseTamper.test.ts
npm.cmd run typecheck
```

---

## Task W4-10：Windows 10/11、Linux/macOS CI、Distribution Matrix 与 Gate A-I

**Requirements/Subprojects:** R17-R18；S12；Gate A-I

**Files**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/windows-real.yml`
- Create: `.github/workflows/distribution.yml`
- Create: `.github/workflows/release-candidate.yml`
- Create: `distribution/release-matrix.json`
- Create: `scripts/import-ci-evidence.mjs`
- Create: `scripts/run-distribution-matrix.mjs`
- Create: `scripts/run-release-gates.mjs`
- Create: `src/release/releaseMatrix.ts`
- Modify: `src/release/gateDefinitions.ts`
- Modify: `src/release/gateRunner.ts`
- Create: `tests/release/releaseMatrix.test.ts`
- Create: `tests/release/gateAggregation.test.ts`
- Create: `tests/distribution/secondaryPlatform.test.ts`
- Create: `tests/integration/wave4-e2e.test.ts`
- Modify: `package.json`

**package.json script → runner**

| npm script | runner |
|---|---|
| `evidence:import-ci` | `node scripts/import-ci-evidence.mjs` |
| `test:distribution` | `node scripts/run-distribution-matrix.mjs` |
| `gate:release` | `node scripts/run-release-gates.mjs` |

**Interfaces**

```ts
interface ReleaseMatrixCell {
  id: string;
  os: 'windows' | 'linux' | 'macos';
  osVersion: string;
  osBuild: string;
  runnerImage: string;
  arch: 'x64' | 'arm64';
  target: TargetPlatform;
  profile: ProfileId;
  profileDigest: string;
  requiredCapabilities: CapabilityId[];
  optionalCapabilities: CapabilityId[];
  expectedUnavailable: CapabilityId[];
}

interface GateAggregate {
  runId: string;
  gates: Record<'A'|'B'|'C'|'D'|'E'|'F'|'G'|'H'|'I', GateEvidence>;
  final: 'passed' | 'failed' | 'blocked';
}
```

`GateAggregate` 直接复用 W0 `src/release/evidenceSchema.ts` 的 `GateEvidence`；不得引入未定义的 `GateResult`。

**Required matrix cells**

签名 profile schema 为五个 `TargetPlatform` 都给出 support；只要某 target 至少有一个 capability 为 Required，该 target 的三个 profile 都必须有真实 cell，不能因 hosted runner 不便而省略：

- Windows 10 22H2 x64 build 19045，自托管 runner image `self-hosted-windows-10-22h2`：Core/Standard/Full Local AI。
- Windows 11 24H2 x64 build 26100，自托管 runner image `self-hosted-windows-11-24h2`：Core/Standard/Full Local AI。
- Ubuntu 24.04 x64，GitHub runner image `ubuntu-24.04`：Core/Standard/Full Local AI。
- Ubuntu 24.04 arm64，真实 arm64 runner image `ubuntu-24.04-arm`：Core/Standard/Full Local AI。
- macOS 15 Intel x64，真实 Intel runner label `self-hosted-macos-15-x64`：Core/Standard/Full Local AI；若 GitHub 当时提供等价 Intel hosted image，可只通过签名 matrix policy 变更 runner label，不能删除 `darwin-x64` target。
- macOS 14 arm64，GitHub runner image `macos-14`：Core/Standard/Full Local AI。

共 18 个 Required cells；`distribution/release-matrix.json` 必须由本次签名 profile envelopes 派生 target coverage，并 exact equality 校验 `{win32-x64,linux-x64,linux-arm64,darwin-x64,darwin-arm64}`，不能手工写死较小集合。每个 cell clean install → noninteractive onboarding → JSONL/Wire → CapabilityReport → E2E → upgrade/recovery → uninstall → SBOM/release bundle/GitHub attestations/airgap verification。

- [ ] **Step 1: 粘贴完整红测 `tests/release/releaseMatrix.test.ts`**

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { requiredReleaseCells, validateMatrixEvidence, type SignedProfileEnvelope } from '../../src/release/releaseMatrix.js';
import type { DistributionProfile, ProfileId } from '../../src/domain/distribution/profile.js';

const targets = ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const;
const profile = (id: ProfileId): DistributionProfile => ({
  schemaVersion: 1, id, version: '4.0.0',
  capabilities: [
    { id: 'cli', support: Object.fromEntries(targets.map(target => [target, 'required'])) as never },
    { id: 'memory', support: Object.fromEntries(targets.map(target => [target, id === 'core' ? 'optional' : 'required'])) as never },
    { id: 'windows.uia', support: Object.fromEntries(targets.map(target => [target, target === 'win32-x64' && id !== 'core' ? 'required' : 'unavailable'])) as never },
  ], packages: [], binaries: [], models: [],
});
const envelopes = (): SignedProfileEnvelope[] => (['core', 'standard', 'full-local-ai'] as const).map(id => {
  const canonicalProfile = new TextEncoder().encode(JSON.stringify(profile(id)));
  return {
    canonicalProfile,
    claimedDigest: createHash('sha256').update(canonicalProfile).digest('hex'),
    bundle: { fixture: id }, subjectName: `distribution/profiles/${id}.json`,
  };
});
const verifier = {
  verify: async (envelope: SignedProfileEnvelope) => ({
    ok: true as const,
    value: { profile: JSON.parse(new TextDecoder().decode(envelope.canonicalProfile)), digest: envelope.claimedDigest },
  }),
};

describe('release matrix', () => {
  it('derives 18 cells from all signed targets without mutable profile injection', async () => {
    const result = await requiredReleaseCells(envelopes(), verifier);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toHaveLength(18);
    expect(new Set(result.value.map(cell => cell.target))).toEqual(new Set(targets));
    expect(result.value.filter(cell => cell.target === 'linux-arm64')).toHaveLength(3);
    expect(result.value.filter(cell => cell.target === 'darwin-x64')).toHaveLength(3);
  });

  it('keeps Core optional capabilities out of required while Standard requires them', async () => {
    const result = await requiredReleaseCells(envelopes(), verifier);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.find(cell => cell.target === 'linux-x64' && cell.profile === 'core')?.requiredCapabilities).not.toContain('memory');
    expect(result.value.find(cell => cell.target === 'linux-x64' && cell.profile === 'standard')?.requiredCapabilities).toContain('memory');
  });

  it('fails closed on digest/subject/issuer/workflow verification failure', async () => {
    const denied = { verify: async () => ({ ok: false as const, error: { code: 'RELEASE_IDENTITY_MISMATCH', message: 'wrong workflow', messageKey: 'RELEASE_IDENTITY_MISMATCH', retryable: false } }) };
    expect(await requiredReleaseCells(envelopes(), denied)).toMatchObject({ ok: false, error: { code: 'RELEASE_IDENTITY_MISMATCH' } });
  });

  it('rejects hard-coded capability evidence that differs from signed derivation', async () => {
    const result = await requiredReleaseCells(envelopes(), verifier);
    if (!result.ok) throw new Error(result.error.code);
    const cell = result.value.find(item => item.target === 'linux-x64' && item.profile === 'standard')!;
    expect(validateMatrixEvidence(cell, { ...cell, requiredCapabilities: ['cli'] })).toMatchObject({
      ok: false, error: { code: 'PROFILE_CAPABILITY_DERIVATION_MISMATCH' },
    });
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/release/releaseMatrix.test.ts
```

Expected: FAIL；release matrix 与 capability derivation 尚不存在。

- [ ] **Step 3: 粘贴最小实现 `src/release/releaseMatrix.ts`**

```ts
import { createHash } from 'node:crypto';
import type { OperationResult } from '../protocol/results.js';
import type { CapabilityId, DistributionProfile, ProfileId } from '../domain/distribution/profile.js';
import type { TargetPlatform } from '../domain/distribution/types.js';

export interface ReleaseMatrixCell {
  id: string;
  os: 'windows' | 'linux' | 'macos';
  osVersion: string;
  osBuild: string;
  runnerImage: string;
  arch: 'x64' | 'arm64';
  target: TargetPlatform;
  profile: ProfileId;
  profileDigest: string;
  requiredCapabilities: CapabilityId[];
  optionalCapabilities: CapabilityId[];
  expectedUnavailable: CapabilityId[];
}

export interface SignedProfileEnvelope {
  readonly canonicalProfile: Uint8Array;
  readonly claimedDigest: string;
  readonly bundle: unknown;
  readonly subjectName: string;
}
interface VerifiedProfile { profile: DistributionProfile; digest: string }
interface ProfileVerifier {
  verify(envelope: SignedProfileEnvelope): Promise<OperationResult<VerifiedProfile>>;
}

const environments = [
  { os: 'windows' as const, osVersion: 'Windows 10 22H2', osBuild: '19045', runnerImage: 'self-hosted-windows-10-22h2', arch: 'x64' as const, target: 'win32-x64' as const },
  { os: 'windows' as const, osVersion: 'Windows 11 24H2', osBuild: '26100', runnerImage: 'self-hosted-windows-11-24h2', arch: 'x64' as const, target: 'win32-x64' as const },
  { os: 'linux' as const, osVersion: 'Ubuntu 24.04', osBuild: '24.04', runnerImage: 'ubuntu-24.04', arch: 'x64' as const, target: 'linux-x64' as const },
  { os: 'linux' as const, osVersion: 'Ubuntu 24.04', osBuild: '24.04', runnerImage: 'ubuntu-24.04-arm', arch: 'arm64' as const, target: 'linux-arm64' as const },
  { os: 'macos' as const, osVersion: 'macOS 15', osBuild: 'runner-evidence-required', runnerImage: 'self-hosted-macos-15-x64', arch: 'x64' as const, target: 'darwin-x64' as const },
  { os: 'macos' as const, osVersion: 'macOS 14', osBuild: 'runner-evidence-required', runnerImage: 'macos-14', arch: 'arm64' as const, target: 'darwin-arm64' as const },
];

export async function requiredReleaseCells(
  envelopes: readonly SignedProfileEnvelope[],
  verifier: ProfileVerifier,
): Promise<OperationResult<ReleaseMatrixCell[]>> {
  if (envelopes.length !== 3) return { ok: false, error: { code: 'PROFILE_CAPABILITY_DERIVATION_MISMATCH', message: 'Exactly three signed profiles are required', messageKey: 'PROFILE_CAPABILITY_DERIVATION_MISMATCH', retryable: false } };
  const verified = new Map<ProfileId, VerifiedProfile>();
  for (const envelope of envelopes) {
    const digest = createHash('sha256').update(envelope.canonicalProfile).digest('hex');
    if (digest !== envelope.claimedDigest) return { ok: false, error: { code: 'RELEASE_PROFILE_DIGEST_MISMATCH', message: 'Profile digest mismatch', messageKey: 'RELEASE_PROFILE_DIGEST_MISMATCH', retryable: false } };
    const result = await verifier.verify(envelope); // verifies Sigstore subject, issuer and workflow for this call
    if (!result.ok) return result;
    if (result.value.digest !== digest || envelope.subjectName !== `distribution/profiles/${result.value.profile.id}.json`) return { ok: false, error: { code: 'RELEASE_PROFILE_DIGEST_MISMATCH', message: 'Profile subject mismatch', messageKey: 'RELEASE_PROFILE_DIGEST_MISMATCH', retryable: false } };
    verified.set(result.value.profile.id, result.value);
  }
  for (const id of ['core', 'standard', 'full-local-ai'] as const) if (!verified.has(id)) return { ok: false, error: { code: 'PROFILE_CAPABILITY_DERIVATION_MISMATCH', message: `Missing signed profile ${id}`, messageKey: 'PROFILE_CAPABILITY_DERIVATION_MISMATCH', retryable: false } };

  const cells = environments.flatMap(environment => [...verified.values()].map(item => ({
    ...environment, id: `${environment.runnerImage}-${item.profile.id}`,
    profile: item.profile.id, profileDigest: item.digest,
    requiredCapabilities: item.profile.capabilities.filter(capability => capability.support[environment.target] === 'required').map(capability => capability.id).sort(),
    optionalCapabilities: item.profile.capabilities.filter(capability => capability.support[environment.target] === 'optional').map(capability => capability.id).sort(),
    expectedUnavailable: item.profile.capabilities.filter(capability => capability.support[environment.target] === 'unavailable').map(capability => capability.id).sort(),
  })));
  return { ok: true, value: cells };
}

export function validateMatrixEvidence(
  cell: ReleaseMatrixCell,
  evidence: Pick<ReleaseMatrixCell, 'osVersion' | 'osBuild' | 'runnerImage' | 'profileDigest' | 'requiredCapabilities'>,
): OperationResult<void> {
  if (cell.osVersion !== evidence.osVersion || cell.osBuild !== evidence.osBuild || cell.runnerImage !== evidence.runnerImage) {
    return { ok: false, error: { code: 'MATRIX_ENVIRONMENT_MISMATCH', message: 'Runner environment differs from matrix cell', messageKey: 'MATRIX_ENVIRONMENT_MISMATCH', retryable: false } };
  }
  if (cell.profileDigest !== evidence.profileDigest || JSON.stringify(cell.requiredCapabilities) !== JSON.stringify([...evidence.requiredCapabilities].sort())) {
    return { ok: false, error: { code: 'PROFILE_CAPABILITY_DERIVATION_MISMATCH', message: 'Capabilities differ from signed profile', messageKey: 'PROFILE_CAPABILITY_DERIVATION_MISMATCH', retryable: false } };
  }
  return { ok: true, value: undefined };
}
```

实施时 `setVerifiedProfiles` 仅由 W4-09 `SigstoreReleaseVerifier` 的输出调用；测试 fixture 必须先注入三份 verified profiles，不能接受 unsigned JSON。Linux/macOS 的 `osBuild` 在 runner 执行时写入 immutable evidence，再生成最终 cell；`runner-captured` 只用于红测前的未验证描述，任何最终 evidence 中仍含该值必须 `MATRIX_ENVIRONMENT_MISMATCH`。

`gateAggregation.test.ts` 断言任一 Required cell missing/failed/blocked 都令 H/I 和 aggregate 非 passed。`GateRunner` 验证 workflow run URL、OIDC identity、artifact digest、runner environment，不只读取自报 JSON。

- [ ] **Step 4: workflow 约束**

`windows-real.yml` 分成 Win10/Win11 两个 Required jobs，并先用 PowerShell 校验：

```powershell
$os = Get-ComputerInfo
if ($os.WindowsVersion -ne '22H2' -or $os.OsBuildNumber -ne '19045') { exit 1 }
```

Win11 job 对应 `WindowsVersion='24H2'`、`OsBuildNumber='26100'`。`distribution.yml` 对 12 cells 调 `npm.cmd run test:distribution`、`npm.cmd run release:supply-chain`、`npm.cmd run bundle:verify-airgap`。`release-candidate.yml` 仅下载并验证 artifacts、上传 candidate evidence；没有 publish/release/tag step。

- [ ] **Step 5: 运行完整 W4-10 本地前置验证**

```powershell
npm.cmd run check:test-discovery
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:all
npm.cmd exec -- vitest run tests/release/releaseMatrix.test.ts tests/release/gateAggregation.test.ts tests/distribution/secondaryPlatform.test.ts tests/integration/wave4-e2e.test.ts
```

真实 Gate E/H/I 只能由对应 runner artifacts 满足，本地绿色不能替代。

---

## Task W4-11：遗留路径退出、最终审计、候选报告、最终 Gate 与签名中文报告

**Requirements/Subprojects:** R01-R20；S1-S13；Gate A-I

**Files**
- Modify, then delete only after reachability proof: `src/app/CommandBus.ts`
- Modify, then delete only after reachability proof: `src/kernel/agent.ts`
- Modify, then delete only after reachability proof: `src/kernel/taskRunner.ts`
- Modify, then delete only after reachability proof: `src/kernel/memory.ts`
- Modify, then delete only after reachability proof: `src/kernel/mcp.ts`
- Modify, then delete only after reachability proof: `src/kernel/plugins.ts`
- Modify, then delete only after reachability proof: `src/kernel/voice.ts`
- Modify, then delete only after reachability proof: `src/kernel/browser.ts`
- Modify, then delete only after reachability proof: `src/kernel/computer/actionLayer.ts`
- Modify, then delete only after reachability proof: `src/kernel/computer/clipboard.ts`
- Modify, then delete only after reachability proof: `src/kernel/computer/guards.ts`
- Modify, then delete only after reachability proof: `src/kernel/computer/index.ts`
- Modify, then delete only after reachability proof: `src/kernel/computer/uia.ts`
- Modify, then delete only after reachability proof: `src/build/evidence.ts`
- Modify, then delete only after reachability proof: `src/build/gate.ts`
- Modify, then delete only after reachability proof: `src/build/llmSpec.ts`
- Modify, then delete only after reachability proof: `src/build/plan.ts`
- Modify, then delete only after reachability proof: `src/build/scaffold.ts`
- Modify, then delete only after reachability proof: `src/build/spec.ts`
- Modify, then delete only after reachability proof: `src/build/verify.ts`
- Modify, then delete only after reachability proof: `src/forge/forge.ts`
- Modify, then delete only after reachability proof: `src/forge/registry.ts`
- Modify: `docs/superpowers/manifests/v3-compatibility.json`
- Create: `scripts/check-legacy-reachability.mjs`
- Modify: `scripts/check-requirement-coverage.mjs`
- Create: `scripts/release/generate-candidate-report.mjs`
- Create: `scripts/release/run-completion-gate.mjs`
- Create: `scripts/release/generate-completion-report.mjs`
- Create: `scripts/release/sign-completion-report.mjs`
- Create: `scripts/release/finalize-release.mjs`
- Create: `tests/architecture/noLegacyReachability.test.ts`
- Create: `tests/integration/gaPromptToArtifact.test.ts`
- Create: `tests/security/gaNegativeScenarios.test.ts`
- Create: `tests/release/finalizationOrder.test.ts`
- Generate, do not commit: `artifacts/release-evidence/latest-run.json`
- Generate, do not commit: `artifacts/release-evidence/latest-release.json`
- Generate, do not commit: `artifacts/release-evidence/reports/v4-candidate-report.zh-CN.md`
- Generate, do not commit: `artifacts/release-evidence/reports/v4-completion-report.zh-CN.md`
- Generate, do not commit: `artifacts/release-evidence/reports/v4-completion-report.zh-CN.md.sigstore.json`
- Modify: `package.json`

**package.json script → runner**

| npm script | runner |
|---|---|
| `check:legacy-reachability` | `node scripts/check-legacy-reachability.mjs` |
| `check:requirement-coverage` | `node scripts/check-requirement-coverage.mjs` |
| `report:candidate` | `node scripts/release/generate-candidate-report.mjs` |
| `release:recompute-hashes` | `node scripts/release/hash-artifacts.mjs --recompute-candidate` |
| `gate:completion` | `node scripts/release/run-completion-gate.mjs` |
| `report:completion` | `node scripts/release/generate-completion-report.mjs` |
| `report:sign` | `node scripts/release/sign-completion-report.mjs` |
| `release:finalize` | `node scripts/release/finalize-release.mjs` |

删除旧 `check:requirements` 与 `audit:requirements` aliases，所有 workflow/文档只调用 `check:requirement-coverage`。

**Finalization state files**

```ts
interface LatestRunPointer {
  schemaVersion: 1;
  runId: string;
  evidenceIndexPath: string;
  importedEvidenceDigest: string;
  requiredSuiteIds: string[];
}

interface LatestReleasePointer {
  schemaVersion: 1;
  releaseId: string;
  manifestPath: string;
  manifestDigest: string;
  candidateReportPath: string;
  candidateReportDigest: string;
  decisionPath?: string;
  completionReportPath?: string;
}
```

- [ ] **Step 1: 粘贴完整红测 `tests/release/finalizationOrder.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { FINALIZATION_STEPS, validateCandidateReport } from '../../scripts/release/finalize-release.mjs';

const expected = [
  'evidence:import-ci',
  'check:legacy-reachability',
  'check:requirement-coverage',
  'report:candidate',
  'release:recompute-hashes',
  'gate:release',
  'gate:completion',
  'report:completion',
  'report:sign',
];

describe('GA finalization order', () => {
  it('keeps evidence import first and final gates after candidate hash recomputation', () => {
    expect(FINALIZATION_STEPS).toEqual(expected);
    expect(FINALIZATION_STEPS.indexOf('release:recompute-hashes')).toBeLessThan(FINALIZATION_STEPS.indexOf('gate:release'));
    expect(FINALIZATION_STEPS.indexOf('gate:completion')).toBeLessThan(FINALIZATION_STEPS.indexOf('report:completion'));
  });

  it.each(['GA 完成', '全部通过', '发布成功', '100% 完成'])('rejects candidate success self-claim: %s', text => {
    expect(validateCandidateReport(`候选报告\n${text}`)).toMatchObject({
      ok: false, error: { code: 'FINALIZATION_ORDER_INVALID' },
    });
  });

  it('accepts a factual candidate report that only enumerates imported statuses', () => {
    expect(validateCandidateReport('候选报告\nA: passed\nB: blocked\n最终结论由后续 Gate 决定。')).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: 运行红测并确认失败**

```powershell
npm.cmd exec -- vitest run tests/release/finalizationOrder.test.ts
```

Expected: FAIL；finalization runner 尚不存在。

- [ ] **Step 3: 粘贴完整最小实现 `scripts/release/finalize-release.mjs`**

```js
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const FINALIZATION_STEPS = [
  'evidence:import-ci',
  'check:legacy-reachability',
  'check:requirement-coverage',
  'report:candidate',
  'release:recompute-hashes',
  'gate:release',
  'gate:completion',
  'report:completion',
  'report:sign',
];

const forbiddenClaims = ['GA 完成', '全部通过', '发布成功', '100% 完成'];

export function validateCandidateReport(text) {
  const claim = forbiddenClaims.find(value => text.includes(value));
  return claim
    ? { ok: false, error: { code: 'FINALIZATION_ORDER_INVALID', message: `Candidate report contains forbidden claim: ${claim}`, messageKey: 'FINALIZATION_ORDER_INVALID', retryable: false } }
    : { ok: true, value: undefined };
}

const runNpm = script => {
  const result = spawnSync('npm.cmd', ['run', script], { stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

async function main() {
  const runPointer = JSON.parse(await readFile('artifacts/release-evidence/latest-run.json', 'utf8'));
  const releasePointer = JSON.parse(await readFile('artifacts/release-evidence/latest-release.json', 'utf8'));
  if (!runPointer.runId || !runPointer.evidenceIndexPath || !releasePointer.releaseId || !releasePointer.manifestPath) {
    throw new Error('FINALIZATION_ORDER_INVALID');
  }

  for (const step of FINALIZATION_STEPS) {
    runNpm(step);
    if (step === 'report:candidate') {
      const refreshed = JSON.parse(await readFile('artifacts/release-evidence/latest-release.json', 'utf8'));
      const text = await readFile(refreshed.candidateReportPath, 'utf8');
      const valid = validateCandidateReport(text);
      if (!valid.ok) throw new Error(valid.error.code);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
```

- [ ] **Step 4: 实现 evidence import 与 audits**

`import-ci-evidence.mjs` 必须验证并导入：test discovery、typecheck、build、全部 Vitest suites、migration、recovery drill、E2E、security、Win10 real、Win11 real、12 个 distribution cells、12 个 supply-chain reports、12 个 airgap verification receipts。缺任一 Required suite 返回 `GATE_EVIDENCE_INVALID` 并且不得更新 `latest-run.json`。

`check-legacy-reachability.mjs` 结合 static import/call graph、registry enumeration 和 runtime route tests；只有证明 runtime 入口不再调用旧 adapter 后才删除对应文件。`check-requirement-coverage.mjs` 同时检查 R01-R20、S1-S13、30 个强制缺陷、实际 source/commit/profile/platform、正反测试、Gate、Evidence ID；空数组和不存在 ID 失败。

- [ ] **Step 5: 实现候选报告、最终 decision 与中文报告**

`generate-candidate-report.mjs` 只列 imported evidence 的原始 `passed/failed/blocked/unverified`，末尾固定写“最终结论由后续 Gate 决定”，禁止成功自述。`release:recompute-hashes` 在候选报告生成后重算 package/profile/lock/SBOM/license/provenance/airgap/candidate-report 的 digest，并更新 canonical release manifest。

`gate:release` 与 `gate:completion` 是最后两个判定步骤；`run-completion-gate.mjs` 读取最终 immutable evidence 和刚重算的 manifest，写 `CompletionDecision`。`generate-completion-report.mjs` 只能从该 decision 派生：decision 为 succeeded 且 A-I 全 passed 时才可写“GA 完成”；其他状态必须准确写 failed/blocked/incomplete/inconclusive/cancelled。`sign-completion-report.mjs` 对最终中文报告 bytes 生成 Sigstore detached bundle，并把 report digest、decision digest、release manifest digest 三者互相绑定；否则返回 `COMPLETION_REPORT_NOT_DERIVED`。

- [ ] **Step 6: 使用固定 pointer 与 ConvertFrom-Json 执行最终流程**

```powershell
$run = Get-Content -Raw artifacts/release-evidence/latest-run.json | ConvertFrom-Json
$release = Get-Content -Raw artifacts/release-evidence/latest-release.json | ConvertFrom-Json
if (-not $run.runId -or -not $release.releaseId) { throw 'FINALIZATION_ORDER_INVALID' }
npm.cmd run release:finalize
$finalRelease = Get-Content -Raw artifacts/release-evidence/latest-release.json | ConvertFrom-Json
Write-Output $finalRelease.completionReportPath
```

这里没有手填 run/release ID，也没有尖括号占位符。

- [ ] **Step 7: 运行 W4-11 与最终 release 验证**

```powershell
npm.cmd exec -- vitest run tests/architecture/noLegacyReachability.test.ts tests/integration/gaPromptToArtifact.test.ts tests/security/gaNegativeScenarios.test.ts tests/release/finalizationOrder.test.ts
npm.cmd run check:test-discovery
npm.cmd run check:legacy-reachability
npm.cmd run check:requirement-coverage
npm.cmd run release:finalize
```

`release:finalize` 不运行 publish/tag/release；它只导入、审计、生成、hash、Gate 和签名本地/CI candidate artifacts。

---

## Wave 4 Exit Audit

通过条件：

- 九类组件均完成 generate → protocol verify → behavior verify → approve → install → enable → invoke → disable → uninstall，并有独立正反证据和完整 owned-scope 清理。
- V3 registry/commands/config/data/project 兼容项均按 manifest 证明；批准例外以稳定错误或迁移表达。
- `src/domain/distribution/types.ts` 是五个公共 distribution types 的唯一来源，W4-08 无重复声明和循环 import。
- Core、Standard、Full Local AI 在声明平台的 Required/Optional/Unavailable 合同准确；CapabilityReport 来自真实 probe 和 `AssetIdentity`。
- clean pack/install、V3 upgrade、新写入、operational rollback 或 forward-only recovery、再升级、uninstall、diagnostics 真实通过。
- install/upgrade/recover/airgap 在任何写入前重验 trust identity/issuer/signature/profile/lock/all digests；unsigned、wrong issuer、manifest swap、tamper、replay 全 fail-closed；installed digest 等于 signed digest。
- 12 个 Required release matrix cells 都有 SBOM、license、checksum、signature、provenance、audit export 和断网 airgap install verification。
- Windows 10 build 19045 与 Windows 11 build 26100 真实 self-hosted evidence 都存在；Linux/macOS Gate I capability 精确由签名 profile 派生。
- GateAggregate 复用 `GateEvidence`，不存在未定义 `GateResult`。
- 每个新增 npm script 都映射唯一 Node runner；platform scripts 只由 Node dispatcher 调度；没有自动 publish。
- 遗留 adapter 已删除或证明 runtime 不可达；不存在 parallel source of truth。
- `check:requirement-coverage` 是唯一 requirement audit command；R01-R20、S1-S13、30 个强制缺陷和 Prompt-to-Artifact Matrix 均有实际 Evidence IDs。
- 最终顺序严格为 evidence import → legacy/requirement audit → 无成功自述候选报告 → hash 重算 → `gate:release`/`gate:completion` → decision-derived signed 中文报告。
- Gate A-I 全部 passed、最终工作树/diff 审计完成后，中文报告才可声明 GA 完成；否则必须保留 failed、blocked、incomplete、inconclusive、cancelled 或 unverified。
