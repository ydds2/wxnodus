// tests/release-evidence-integrity.test.ts — GateEvidence runtime validator 破坏矩阵
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  validateGateEvidence,
  writeValidatedGateEvidence,
  type GateEvidenceContext,
} from '../src/release/evidenceSchema.js';
import { computeEvidenceBindingSha256 } from '../src/release/artifactBinding.js';
import type { GateEvidence } from '../src/release/evidenceTypes.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dirs: string[] = [];

const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-evi-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 在 repoRoot 临时子目录中写真实 attachment 字节并返回 entry */
function makeAttachment(repo: string, rel: string, content: string, kind: string) {
  const full = resolve(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return { path: rel.replace(/\\/g, '/'), sha256: sha256(content), kind };
}

function makeContext(repo: string) {
  const envContent = '{"node":"v22"}';
  const policyBytes = readFileSync(resolve(repoRoot, 'docs/superpowers/manifests/v3-policy.json'));
  const policyJson = JSON.parse(policyBytes.toString('utf8'));
  const artifactContent = '{"commit":"c1"}';
  const env = makeAttachment(repo, 'tmp/env.json', envContent, 'environment');
  const policy = {
    ...makeAttachment(repo, 'tmp/policy.json', policyBytes.toString('utf8'), 'policy-manifest'),
    manifestChecksum: policyJson.checksum,
  };
  const artifact = {
    ...makeAttachment(repo, 'tmp/artifact.json', artifactContent, 'artifact'),
    artifactSha256: sha256(artifactContent),
    commit: 'c1',
  };
  const bindingSha256 = computeEvidenceBindingSha256({
    environmentSha256: env.sha256,
    policyManifestSha256: policy.sha256,
    policyManifestChecksum: policyJson.checksum,
    artifactSha256: artifact.artifactSha256,
    commit: 'c1',
  });
  return {
    env, policy, artifact, bindingSha256,
    context: {
      repoRoot: repo,
      expectedGate: 'A' as const,
      currentArtifact: artifact,
      currentEnvironment: env,
      currentPolicyManifest: policy,
    } as GateEvidenceContext,
  };
}

function makePassedEvidence(repo: string, ctx: ReturnType<typeof makeContext>, gate: 'A' | 'B' = 'A') {
  const stdout = makeAttachment(repo, 'tmp/out.txt', 'ok', 'stdout');
  const stderr = makeAttachment(repo, 'tmp/err.txt', '', 'stderr');
  const plain = (a: { path: string; sha256: string; kind: string }) => ({ path: a.path, sha256: a.sha256, kind: a.kind });
  const evidence = {
    schemaVersion: 1,
    waveScope: 'wave0',
    gate,
    requirementIds: ['R01'],
    profiles: ['core'],
    platforms: ['windows'],
    capabilityIds: ['wave0-gate-a'],
    status: 'passed',
    commands: [{
      executable: 'node',
      args: ['-e', '1'],
      exitCode: 0,
      stdoutAttachment: stdout.path,
      stderrAttachment: stderr.path,
    }],
    attachments: [stdout, stderr, plain(ctx.env), plain(ctx.policy), plain(ctx.artifact)],
    binding: {
      environment: ctx.env,
      policyManifest: ctx.policy,
      artifact: ctx.artifact,
      bindingSha256: ctx.bindingSha256,
    },
  };
  return evidence as unknown as GateEvidence;
}

describe('GateEvidence runtime validator', () => {
  it('接受合法 passed evidence 并写盘', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    const result = writeValidatedGateEvidence(resolve(repo, 'gate-a.json'), evidence, ctx.context);
    expect(result.ok).toBe(true);
  });

  it('gate 非预期 → GATE_EVIDENCE_INVALID', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    const result = validateGateEvidence(evidence, { ...ctx.context, expectedGate: 'B' });
    expect(result).toEqual({ ok: false, code: 'GATE_EVIDENCE_INVALID' });
  });

  it('passed 携带非零 exitCode → GATE_PASSED_COMMAND_NONZERO', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    (evidence as any).commands[0].exitCode = 1;
    const result = validateGateEvidence(evidence, ctx.context);
    expect(result).toEqual({ ok: false, code: 'GATE_PASSED_COMMAND_NONZERO' });
  });

  it('attachment hash 与实际字节不一致 → GATE_ATTACHMENT_HASH_MISMATCH', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    (evidence as any).attachments[0].sha256 = 'a'.repeat(64);
    const result = validateGateEvidence(evidence, ctx.context);
    expect(result).toEqual({ ok: false, code: 'GATE_ATTACHMENT_HASH_MISMATCH' });
  });

  it('attachment 路径逃逸 repo → GATE_ATTACHMENT_PATH_INVALID', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    (evidence as any).attachments[0].path = '../outside.txt';
    const result = validateGateEvidence(evidence, ctx.context);
    expect(result).toEqual({ ok: false, code: 'GATE_ATTACHMENT_PATH_INVALID' });
  });

  it('binding 缺 environment → GATE_BINDING_MISSING', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    (evidence as any).binding = { policyManifest: ctx.policy, artifact: ctx.artifact, bindingSha256: ctx.bindingSha256 };
    const result = validateGateEvidence(evidence, ctx.context);
    expect(result).toEqual({ ok: false, code: 'GATE_BINDING_MISSING' });
  });

  it('bindingSha256 非 canonical 重算值 → GATE_BINDING_HASH_MISMATCH', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    (evidence as any).binding.bindingSha256 = 'b'.repeat(64);
    const result = validateGateEvidence(evidence, ctx.context);
    expect(result).toEqual({ ok: false, code: 'GATE_BINDING_HASH_MISMATCH' });
  });

  it('not_applicable 缺 unreachableEvidenceIds → GATE_NA_SCOPE_MISSING', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const plain = (a: { path: string; sha256: string; kind: string }) => ({ path: a.path, sha256: a.sha256, kind: a.kind });
    const evidence = {
      schemaVersion: 1,
      waveScope: 'wave0',
      gate: 'D',
      requirementIds: ['R10'],
      profiles: ['core'],
      platforms: ['windows'],
      capabilityIds: ['x'],
      status: 'not_applicable',
      unreachableEvidenceIds: [],
      reasonCode: 'CAPABILITY_NOT_DELIVERED_IN_WAVE_SCOPE',
      attachments: [plain(ctx.env), plain(ctx.policy), plain(ctx.artifact)],
      binding: {
        environment: ctx.env,
        policyManifest: ctx.policy,
        artifact: ctx.artifact,
        bindingSha256: ctx.bindingSha256,
      },
    };
    const result = validateGateEvidence(evidence, { ...ctx.context, expectedGate: 'D' });
    expect(result).toEqual({ ok: false, code: 'GATE_NA_SCOPE_MISSING' });
  });

  it('failed 无非零 command → GATE_STATUS_SHAPE_INVALID', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    (evidence as any).status = 'failed';
    (evidence as any).reasonCode = 'GATE_RUNNER_FAILED';
    const result = validateGateEvidence(evidence, ctx.context);
    expect(result).toEqual({ ok: false, code: 'GATE_STATUS_SHAPE_INVALID' });
  });

  it('未知额外字段 → GATE_EVIDENCE_INVALID', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    (evidence as any).bogusField = true;
    const result = validateGateEvidence(evidence, ctx.context);
    expect(result).toEqual({ ok: false, code: 'GATE_EVIDENCE_INVALID' });
  });

  it('command 未引用 stdout/stderr attachment → GATE_COMMAND_ATTACHMENT_MISSING', () => {
    const repo = tempDir();
    const ctx = makeContext(repo);
    const evidence = makePassedEvidence(repo, ctx);
    (evidence as any).commands[0].stdoutAttachment = 'tmp/missing.txt';
    const result = validateGateEvidence(evidence, ctx.context);
    expect(result).toEqual({ ok: false, code: 'GATE_COMMAND_ATTACHMENT_MISSING' });
  });
});
