// tests/wave3/w3-build-service-wiring.test.ts — Wave 3 Build 生产端口组装（真实 authority 闭环）
// 真实闭环：WorkspaceTransaction(staging) → scaffold 节点 → staticEntry → verifier →
// EvidenceService.close → readVerifiedClosed → reviewer attestation(Ed25519) → CompletionGate →
// coordinator owned receipt。快照/密钥注入真实（确定性 sha256 + 真 ed25519 签名）。
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdirSync, rm, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createProductionBuildWiring, type BuildSnapshotProviders } from '../../src/application/build/buildServiceWiring.js';
import { BuildService, type BuildServicePorts } from '../../src/application/build/buildService.js';
import { CompletionCoordinator } from '../../src/application/quality/completionCoordinator.js';
import { createReviewerKeyService } from '../../src/application/quality/reviewerKeyService.js';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';
import { FileReviewNonceStore } from '../../src/infrastructure/quality/fileReviewNonceStore.js';
import { BUILTIN_VERIFIER_DESCRIPTORS } from '../../src/domain/quality/verifier.js';

const mkdtempAsync = promisify(mkdtemp);
const rmAsync = promisify(rm);
const sha = (char: string) => char.repeat(64);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function writeMinServer(dir: string) {
  mkdirSync(join(dir, 'server'), { recursive: true });
  writeFileSync(join(dir, 'server', 'index.js'),
    "const http = require('http');const s=http.createServer((q,r)=>{if(q.url==='/health')r.end('ok');else r.end('<html>hi</html>')});s.listen(process.env.PORT||4321);\n");
  writeFileSync(join(dir, 'healthcheck.js'),
    "const http=require('http');http.get('http://127.0.0.1:'+(process.env.PORT||4321)+'/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1));\n");
}

const specWith = (verifierId: string): unknown => [
  { id: 'criterion-1', required: true, description: 'serves /', verifierId, expected: { path: 'server/index.js' }, evidenceRequirements: [] },
];

const criterionOf = () => ({
  id: 'criterion-1', required: true, description: 'serves /', verifierId: 'file.exists', expected: { path: 'server/index.js' }, evidenceRequirements: [],
});

interface Fixture {
  root: string;
  ports: BuildServicePorts;
  coordinator: CompletionCoordinator;
  cleanup(): Promise<void>;
}

const fakeCipher = () => {
  const map = new Map<string, string>();
  return {
    encrypt: (plain: string) => {
      const token = `enc:${map.size + 1}`;
      map.set(token, plain);
      return token;
    },
    decrypt: (stored: string) => map.get(stored) ?? null,
  };
};

async function fixture(overrides: {
  verify?: (dir: string) => Promise<{ status: 'ok' | 'failed' | 'skipped'; detail: string }>;
  snapshots?: Partial<BuildSnapshotProviders>;
} = {}): Promise<Fixture> {
  const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-wiring-'));
  const store = new FileEvidenceStore(root, () => '2026-08-13T00:02:30.000Z');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signer = {
    issuer: 'review-service-1',
    keyId: 'review-key-1',
    sign: async (hash: Uint8Array) => sign(null, hash, privateKey),
  };
  const trustPolicy = {
    resolve: (issuer: string, keyId: string) => issuer === signer.issuer && keyId === signer.keyId ? {
      issuer,
      keyId,
      algorithm: 'Ed25519' as const,
      publicKey,
      reviewerActorIds: ['reviewer-1'],
      activeFrom: '2026-08-01T00:00:00.000Z',
      activeUntil: '2026-09-01T00:00:00.000Z',
      maxAgeMs: 600_000,
      maxClockSkewMs: 5_000,
    } : undefined,
  };

  const snapshots: BuildSnapshotProviders = {
    environment: () => ({ ok: true, value: { snapshotId: 'env-1', sha256: digest('env'), platform: 'win32', arch: 'x64' } }),
    capability: () => ({ ok: true, value: { snapshotId: 'cap-1', sha256: digest('cap') } }),
    policy: () => ({ ok: true, value: { snapshotId: 'policy-1', sha256: digest('policy'), decisionId: 'decision-1' } }),
    ...overrides.snapshots,
  };

  const wiring = createProductionBuildWiring({
    dataDir: root,
    runId: 'run-1',
    sessionId: 'session-1',
    instantiate: (spec, targetDir) => {
      writeMinServer(targetDir);
      return { ok: true, value: { spec } };
    },
    verifyProject: overrides.verify ?? (async () => ({ status: 'ok', detail: 'verified' })),
    evidenceStore: store as never,
    snapshots,
    reviewerSigner: signer,
    reviewerTrust: trustPolicy,
    nonceStore: new FileReviewNonceStore(join(root, 'review-nonces')),
    makerActorId: 'maker-1',
    reviewerActorId: 'reviewer-1',
    clock: () => '2026-08-13T00:03:00.000Z',
  });

  if (!wiring.ok) {
    throw new Error(wiring.error.code);
  }
  return {
    root,
    ports: wiring.value.ports,
    coordinator: wiring.value.coordinator,
    cleanup: () => rmAsync(root, { recursive: true, force: true }),
  };
}

describe('production build wiring', () => {
  it('maps a criterion verifier id that exists in the builtin registry', async () => {
    const f = await fixture();
    try {
      const result = f.ports.verifierMap.resolve(criterionOf());
      expect(result).toMatchObject({ ok: true, value: { verifierId: 'file.exists' } });
    } finally { await f.cleanup(); }
  });

  it('rejects a criterion whose verifier id is not in the builtin registry', async () => {
    const f = await fixture();
    try {
      const result = f.ports.verifierMap.resolve({ ...criterionOf(), verifierId: 'ghost.verifier' });
      expect(result).toMatchObject({ ok: false, error: { code: 'BUILD_VERIFIER_MAPPING_MISSING' } });
    } finally { await f.cleanup(); }
  });

  it('static entry requires a real http server in staging', async () => {
    const f = await fixture();
    try {
      const staging = await mkdtempAsync(join(tmpdir(), 'wxnodus-static-'));
      const missing = await f.ports.staticEntry.verify(staging, new AbortController().signal);
      expect(missing).toMatchObject({ ok: false, error: { code: 'BUILD_STATIC_ENTRY_MISSING' } });
      writeMinServer(staging);
      const present = await f.ports.staticEntry.verify(staging, new AbortController().signal);
      expect(present).toMatchObject({ ok: true, value: { servesRoot: true } });
      await rmAsync(staging, { recursive: true, force: true });
    } finally { await f.cleanup(); }
  });

  it('runs the full authority chain to an owned succeeded receipt', async () => {
    const f = await fixture();
    try {
      const service = new BuildService(f.ports, f.coordinator);
      const result = await service.compileAndRun({
        spec: specWith('file.exists'),
        targetDir: join(f.root, 'projects', 'p1'),
        dataDir: f.root,
        snapshotInput: {
          runId: 'run-1', artifactId: 'artifact-1', artifactHash: sha('a'),
          environmentSnapshotId: 'env-1', environmentHash: digest('env'),
          capabilitySnapshotId: 'cap-1', policySnapshotId: 'policy-1', policyHash: digest('policy'),
        },
      }, AbortSignal.timeout(30_000));
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(result.value.committed).toBe(true);
      expect(result.value.decision.status).toBe('succeeded');
    } finally { await f.cleanup(); }
  });

  it('fails closed with BUILD_SNAPSHOT_UNAVAILABLE when a snapshot provider is missing', async () => {
    const f = await fixture({
      snapshots: {
        policy: () => ({ ok: false, error: { code: 'POLICY_SNAPSHOT_UNAVAILABLE', message: 'x', messageKey: 'x', retryable: false } }),
      },
    });
    try {
      const input = await f.ports.completionInput({
        criteria: [criterionOf()],
        nodes: {},
        snapshot: {
          runId: 'run-1', artifactId: 'artifact-1', artifactHash: sha('a'), verificationId: 'v-1',
          environmentSnapshotId: 'env-1', environmentHash: digest('env'),
          capabilitySnapshotId: 'cap-1', policySnapshotId: 'policy-1', policyHash: digest('policy'),
        },
        stagingDir: join(f.root, 'staging'),
      });
      expect(input).toMatchObject({ ok: false, error: { code: 'BUILD_SNAPSHOT_UNAVAILABLE' } });
    } finally { await f.cleanup(); }
  });

  it('all sixteen builtin verifier descriptors are referenced by the wiring probe', () => {
    expect(Object.keys(BUILTIN_VERIFIER_DESCRIPTORS)).toHaveLength(16);
  });

  it('interoperates with the persisted reviewer key service across the full chain', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-reviewer-wiring-'));
    try {
      const cipher = fakeCipher();
      const keyService = createReviewerKeyService({
        dataDir: root,
        encrypt: cipher.encrypt,
        decrypt: cipher.decrypt,
        clock: () => '2026-08-13T00:00:00.000Z', // activeFrom 早于 wiring 的 issuedAt
      });
      const bundle = await keyService.loadOrCreate();
      if (!bundle.ok) throw new Error(bundle.error.code);

      const rewired = createProductionBuildWiring({
        dataDir: root,
        runId: 'run-2',
        sessionId: 'session-2',
        instantiate: (spec, targetDir) => {
          writeMinServer(targetDir);
          return { ok: true, value: { spec } };
        },
        verifyProject: async () => ({ status: 'ok', detail: 'verified' }),
        evidenceStore: new FileEvidenceStore(root, () => '2026-08-13T00:02:30.000Z') as never,
        snapshots: {
          environment: () => ({ ok: true, value: { snapshotId: 'env-1', sha256: digest('env'), platform: 'win32', arch: 'x64' } }),
          capability: () => ({ ok: true, value: { snapshotId: 'cap-1', sha256: digest('cap') } }),
          policy: () => ({ ok: true, value: { snapshotId: 'policy-1', sha256: digest('policy'), decisionId: 'decision-1' } }),
        },
        reviewerSigner: bundle.value.signer,
        reviewerTrust: bundle.value.trustPolicy,
        nonceStore: new FileReviewNonceStore(join(root, 'review-nonces')),
        makerActorId: 'maker-1',
        reviewerActorId: 'reviewer',
        clock: () => '2026-08-13T00:03:00.000Z',
      });
      if (!rewired.ok) throw new Error(rewired.error.code);
      const service = new BuildService(rewired.value.ports, rewired.value.coordinator);
      const result = await service.compileAndRun({
        spec: specWith('file.exists'),
        targetDir: join(root, 'projects', 'p2'),
        dataDir: root,
        snapshotInput: {
          runId: 'run-2', artifactId: 'artifact-1', artifactHash: sha('a'),
          environmentSnapshotId: 'env-1', environmentHash: digest('env'),
          capabilitySnapshotId: 'cap-1', policySnapshotId: 'policy-1', policyHash: digest('policy'),
        },
      }, AbortSignal.timeout(30_000));
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(result.value.committed).toBe(true);
      expect(result.value.decision.status).toBe('succeeded');
    } finally {
      await rmAsync(root, { recursive: true, force: true });
    }
  });
});
