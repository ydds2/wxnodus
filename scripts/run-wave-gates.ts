// scripts/run-wave-gates.ts — Wave 0 Gate runner：执行 required runners、生成 N/A evidence、严格验证后落盘
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeValidatedGateEvidence } from '../src/release/evidenceSchema.js';
import { prepareWave0EvidenceContext } from '../src/release/wave0EvidenceContext.js';
import {
  WAVE_0_SCOPE,
  WAVE_0_RUNNERS,
  WAVE_0_GATE_REQUIREMENTS,
  WAVE_0_PROFILES,
  WAVE_0_PLATFORMS,
  WAVE_0_UNREACHABLE,
} from '../src/release/gateDefinitions.js';
import type { GateEvidence, GateId, MigrationDrillBinding } from '../src/release/evidenceTypes.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = resolve(repoRoot, 'docs/superpowers/evidence/wave0');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sha256File = (path: string): string => sha256(readFileSync(path));

const wave0 = prepareWave0EvidenceContext(repoRoot);
const environmentHash = wave0.environmentHash;
const artifactHash = wave0.artifactHash;
const policyHash = wave0.policyHash;
const policyManifestChecksum = wave0.policyChecksum;
const bindingSha256 = wave0.bindingSha256;

const environmentAttachment = { path: 'docs/superpowers/evidence/wave0/attachments/environment.json', sha256: environmentHash, kind: 'environment' as const };
const policyAttachment = {
  path: 'docs/superpowers/manifests/v3-policy.json',
  sha256: policyHash,
  kind: 'policy-manifest' as const,
  manifestChecksum: policyManifestChecksum,
};
const artifactAttachment = {
  path: 'docs/superpowers/evidence/wave0/candidate-artifact.json',
  sha256: artifactHash,
  kind: 'artifact' as const,
  artifactSha256: artifactHash,
  commit: wave0.commit,
};

// attachments 数组只允许 {path,sha256,kind}；扩展字段仅出现在 binding 中
const plain = (a: { path: string; sha256: string; kind: string }) => ({ path: a.path, sha256: a.sha256, kind: a.kind });
const environmentAttPlain = plain(environmentAttachment);
const policyAttPlain = plain(policyAttachment);
const artifactAttPlain = plain(artifactAttachment);

function writeAttachmentBytes(relPath: string, bytes: Buffer): string {
  const full = resolve(repoRoot, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, bytes);
  return sha256(bytes);
}

function resolveRunner(executable: string, args: string[]): { executable: string; args: string[] } {
  // Windows spawnSync 不能直接执行 .cmd（EINVAL）——改走 node + 系统 npm-cli.js（argv 数组，无 shell 拼接）
  if (executable === 'npm.cmd') {
    const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (existsSync(npmCli)) {
      return { executable: process.execPath, args: [npmCli, ...args] };
    }
  }
  return { executable, args };
}

function runCommand(executable: string, args: string[]): { exitCode: number | null; stdoutPath: string; stderrPath: string } {
  const resolved = resolveRunner(executable, args);
  const result = spawnSync(resolved.executable, resolved.args, {
    cwd: repoRoot,
    encoding: 'buffer',
    timeout: 600000,
    maxBuffer: 200 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = result.stdout ?? Buffer.from('');
  const stderr = result.stderr ?? Buffer.from('');
  const id = `${Math.random().toString(36).slice(2, 8)}`;
  const stdoutPath = `docs/superpowers/evidence/wave0/attachments/run-${id}-stdout.txt`;
  const stderrPath = `docs/superpowers/evidence/wave0/attachments/run-${id}-stderr.txt`;
  writeAttachmentBytes(stdoutPath, stdout);
  writeAttachmentBytes(stderrPath, stderr);
  return { exitCode: result.error ? null : (result.status ?? null), stdoutPath, stderrPath };
}

const gateOutcomes: Array<{ gate: GateId; status: string }> = [];

for (const gate of Object.keys(WAVE_0_SCOPE) as GateId[]) {
  const scope = WAVE_0_SCOPE[gate];
  const common = {
    schemaVersion: 1 as const,
    waveScope: 'wave0' as const,
    gate,
    requirementIds: WAVE_0_GATE_REQUIREMENTS[gate],
    profiles: [...WAVE_0_PROFILES],
    platforms: [...WAVE_0_PLATFORMS],
    capabilityIds: WAVE_0_UNREACHABLE[gate].length ? [...WAVE_0_UNREACHABLE[gate]] : [`wave0-gate-${gate.toLowerCase()}`],
    binding: {
      environment: environmentAttachment,
      policyManifest: policyAttachment,
      artifact: artifactAttachment,
      bindingSha256,
    },
  };

  let evidence: unknown;
  let migrationBinding: MigrationDrillBinding | undefined;
  if (scope.mode === 'na') {
    const unreachable = WAVE_0_UNREACHABLE[gate];
    const unreachableAttachments = unreachable.map(id => {
      const rel = `docs/superpowers/evidence/wave0/attachments/unreachable-${gate.toLowerCase()}-${id.replace(/[^a-z0-9-]/g, '-')}.json`;
      const hash = writeAttachmentBytes(rel, Buffer.from(JSON.stringify({ capabilityId: id, reasonCode: scope.reasonCode }, null, 2)));
      return { path: rel, sha256: hash, kind: 'unreachable-capability' as const };
    });
    evidence = {
      ...common,
      status: 'not_applicable',
      unreachableEvidenceIds: unreachable,
      reasonCode: scope.reasonCode,
      attachments: [...unreachableAttachments, environmentAttPlain, policyAttPlain, artifactAttPlain],
    };
  } else {
    const commands = [];
    const attachments = [];
    const seen = new Set<string>([environmentAttPlain.path, policyAttPlain.path, artifactAttPlain.path]);
    for (const runnerId of scope.runnerIds) {
      const command = WAVE_0_RUNNERS[runnerId];
      if (!command) throw new Error(`WAVE0_RUNNER_MISSING:${runnerId}`);
      const result = runCommand(command.executable, command.args);
      const stdoutHash = sha256File(resolve(repoRoot, result.stdoutPath));
      const stderrHash = sha256File(resolve(repoRoot, result.stderrPath));
      const stdoutAtt = { path: result.stdoutPath, sha256: stdoutHash, kind: 'stdout' as const };
      const stderrAtt = { path: result.stderrPath, sha256: stderrHash, kind: 'stderr' as const };
      for (const att of [stdoutAtt, stderrAtt]) {
        if (!seen.has(att.path)) {
          seen.add(att.path);
          attachments.push(att);
        }
      }
      commands.push({
        executable: command.executable,
        args: command.args,
        exitCode: result.exitCode,
        stdoutAttachment: result.stdoutPath,
        stderrAttachment: result.stderrPath,
      });
    }

    // Gate C：把当前 recovery-drill.json 作为 migration-drill attachment 并构造 binding
    if (gate === 'C') {
      const drillPath = resolve(evidenceDir, 'recovery-drill.json');
      const drillBytes = readFileSync(drillPath);
      const drillHash = sha256(drillBytes);
      const drill = JSON.parse(drillBytes.toString('utf8')) as Record<string, unknown>;
      attachments.push({ path: 'docs/superpowers/evidence/wave0/recovery-drill.json', sha256: drillHash, kind: 'migration-drill' });
      migrationBinding = {
        waveScope: 'wave0',
        registryPath: drill.registryPath as MigrationDrillBinding['registryPath'],
        descriptorId: String(drill.descriptorId),
        descriptorChecksum: String(drill.descriptorChecksum),
        registryArtifactPath: String(drill.registryArtifactPath),
        registryArtifactSha256: String(drill.registryArtifactSha256),
        compatibilityManifestPath: drill.compatibilityManifestPath as MigrationDrillBinding['compatibilityManifestPath'],
        compatibilityManifestSha256: String(drill.compatibilityManifestSha256),
        candidateArtifactSha256: String(drill.candidateArtifactSha256),
        environmentSha256: String(drill.environmentSha256),
        policyManifestSha256: String(drill.policyManifestSha256),
        bindingSha256: String(drill.bindingSha256),
      };
    }

    const passed = commands.every(c => c.exitCode === 0);
    evidence = {
      ...common,
      status: passed ? 'passed' : 'failed',
      commands,
      ...(passed ? {} : { reasonCode: 'GATE_RUNNER_FAILED' }),
      attachments: [...attachments, environmentAttPlain, policyAttPlain, artifactAttPlain],
    };
  }

  const outPath = resolve(evidenceDir, `gate-${gate.toLowerCase()}.json`);
  const result = writeValidatedGateEvidence(outPath, evidence, {
    repoRoot,
    expectedGate: gate,
    currentArtifact: artifactAttachment,
    currentEnvironment: environmentAttachment,
    currentPolicyManifest: policyAttachment,
    ...(migrationBinding ? { currentMigrationBinding: migrationBinding } : {}),
  });
  if (!result.ok) {
    console.error(`GATE_${gate}_EVIDENCE_REJECTED:${result.code}`);
    gateOutcomes.push({ gate, status: `evidence-rejected:${result.code}` });
    continue;
  }
  gateOutcomes.push({ gate, status: (evidence as GateEvidence).status });
  console.log(`GATE_${gate}:${(evidence as GateEvidence).status}`);
}

const requiredGates = (Object.keys(WAVE_0_SCOPE) as GateId[])
  .filter(g => WAVE_0_SCOPE[g].mode === 'required');
const allPassed = requiredGates.every(g => gateOutcomes.find(o => o.gate === g)?.status === 'passed');
console.log(JSON.stringify(gateOutcomes));
process.exit(allPassed ? 0 : 1);
