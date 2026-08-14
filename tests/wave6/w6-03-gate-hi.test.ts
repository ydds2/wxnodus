// tests/wave6/w6-03-gate-hi.test.ts — W6-03 契约：候选冻结器 + Gate H 离线证据运行器 + Gate I 诚实 blocked（RED → 实现后全绿）
// 冻结器：真实 npm pack → candidate.json 元数据（commit/tgzSha256/cell/entrypoint）；dist 缺失诚实失败。
// Gate H：四步真实证据（pack 复验/干净安装/installer 全生命周期/空 HOME 运行）——任一步 blocked → 整体 blocked，
// 附件 sha256 与磁盘一致；全 passed 才 passed。Gate I：win32 produce → GATE_I_PLATFORM_UNAVAILABLE（绝不模拟）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeCandidate } from '../../src/release/candidateFreezer.js';
import { runGateH } from '../../src/release/gateHRunner.js';
import { produceGateIReceipt, aggregateGateIReceipts } from '../../src/release/gateI.js';

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* already closed */ } } });

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const FAKE_TGZ = Buffer.from('fake-tgz-bytes');

describe('W6-03 候选冻结器（freezeCandidate）', () => {
  it('真实 pack（注入）→ candidate.json 元数据与实盘一致 + 读回可校验', async () => {
    const repoRoot = tmp('w6-freeze-');
    mkdirSync(join(repoRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(repoRoot, 'dist', 'cli', 'index.js'), 'console.log(1)');
    const result = await freezeCandidate({
      repoRoot, runId: 'run-freeze-1', outDir: join(repoRoot, 'artifacts', 'release-evidence', 'run-freeze-1'),
      // 注入 pack（单测不跑真实构建链；C4 用真实 npm pack smoke 覆盖）
      pack: async (packDestination) => {
        const file = join(packDestination, 'wxnodus-3.0.0.tgz');
        writeFileSync(file, FAKE_TGZ);
        return { ok: true, tgzFile: file };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidateFile).toContain('candidate.json');
    const candidate = JSON.parse(readFileSync(result.value.candidateFile, 'utf8')) as Record<string, unknown>;
    expect(candidate.candidateId).toMatch(/^cand-[a-f0-9]{10}-/);
    expect(candidate.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(candidate.tgzSha256).toBe(sha256(FAKE_TGZ));
    expect(candidate.entrypoint).toBe('dist/cli/index.js');
    expect(candidate.cell).toMatchObject({ os: process.platform, arch: process.arch });
    expect(typeof (candidate.cell as Record<string, unknown>).node).toBe('string');
    expect(existsSync(result.value.tgzFile)).toBe(true);
  });

  it('dist 入口缺失 → FREEZE_DIST_MISSING（绝不冻结不存在的运行时树）', async () => {
    const repoRoot = tmp('w6-freeze-nodist-');
    const result = await freezeCandidate({
      repoRoot, runId: 'run-freeze-2', outDir: join(repoRoot, 'out'),
      pack: async () => ({ ok: true, tgzFile: join(repoRoot, 'x.tgz') }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'FREEZE_DIST_MISSING' } });
  });
});

describe('W6-03 Gate H 离线证据运行器（runGateH）', () => {
  const passStep = async (id: string) => ({ id, status: 'passed' as const, attachments: [] });
  const candidateOf = (dir: string): string => {
    const file = join(dir, 'candidate.json');
    writeFileSync(file, JSON.stringify({
      candidateId: 'cand-test', commit: 'a'.repeat(40), tgzSha256: 'b'.repeat(64),
      cell: { os: process.platform, arch: process.arch, node: process.version }, entrypoint: 'dist/cli/index.js', dynamicImportDeclarations: [],
    }, null, 2));
    return file;
  };

  it('四步全 passed → outcome passed；步骤附件 sha256 与磁盘一致', async () => {
    const dir = tmp('w6-gateh-pass-');
    const candidateFile = candidateOf(dir);
    const result = await runGateH({
      repoRoot: tmp('w6-gateh-repo-'), evidenceDir: dir, runId: 'run-h-1', candidateFile,
      steps: {
        packVerify: async () => ({ id: 'pack-verify', status: 'passed', attachments: [] }),
        cleanInstall: async () => ({ id: 'clean-install', status: 'passed', attachments: [] }),
        installerLifecycle: async (evidenceDir) => {
          const file = join(evidenceDir, 'attachments', 'install.log');
          mkdirSync(join(evidenceDir, 'attachments'), { recursive: true });
          writeFileSync(file, 'INSTALLED');
          return { id: 'installer-lifecycle', status: 'passed', attachments: [{ path: file, sha256: sha256(readFileSync(file)) }] };
        },
        blankHomeRun: passStep,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('passed');
    expect(result.value.steps.map(step => step.id)).toEqual(['pack-verify', 'clean-install', 'installer-lifecycle', 'blank-home-run']);
    for (const step of result.value.steps) {
      for (const attachment of step.attachments) {
        expect(sha256(readFileSync(attachment.path))).toBe(attachment.sha256);
      }
    }
    const outcome = JSON.parse(readFileSync(join(dir, 'outcome.json'), 'utf8'));
    expect(outcome).toMatchObject({ gate: 'H', status: 'passed', runId: 'run-h-1' });
  });

  it('任一步 blocked → 整体 blocked（绝不把部分通过当完整边界证据）', async () => {
    const dir = tmp('w6-gateh-blocked-');
    const candidateFile = candidateOf(dir);
    const result = await runGateH({
      repoRoot: tmp('w6-gateh-repo2-'), evidenceDir: dir, runId: 'run-h-2', candidateFile,
      steps: {
        packVerify: passStep,
        cleanInstall: async () => ({ id: 'clean-install', status: 'blocked', reason: 'network blocked (registry unreachable)', attachments: [] }),
        installerLifecycle: passStep,
        blankHomeRun: passStep,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('blocked');
    const blockedStep = result.value.steps.find(step => step.id === 'clean-install');
    expect(blockedStep).toMatchObject({ status: 'blocked', reason: expect.stringContaining('network') });
  });
});

describe('W6-03 Gate I（诚实 blocked，绝不模拟 Linux 通过）', () => {
  it('win32/非 linux-macos 上 produce → GATE_I_PLATFORM_UNAVAILABLE', async () => {
    const result = await produceGateIReceipt({ repoRoot: tmp('w6-gatei-'), evidenceDir: tmp('w6-gatei-ev-'), runId: 'run-i-1', platform: 'win32' });
    expect(result).toMatchObject({ ok: true, value: { gate: 'I', status: 'blocked', code: 'GATE_I_PLATFORM_UNAVAILABLE' } });
  });

  it('aggregate：platform 声明 linux/macos + 附件哈希匹配才收；附件篡改 → blocked', () => {
    const dir = tmp('w6-gatei-agg-');
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    writeFileSync(join(dir, 'attachments', 'headless.log'), 'e2e passed');
    const receipt = {
      gate: 'I', runId: 'run-i-2', platform: 'linux', osLabel: 'linux-x64',
      artifact: { id: 'wxnodus-art', sha256: 'a'.repeat(64) },
      attachments: [{ path: 'attachments/headless.log', sha256: sha256(readFileSync(join(dir, 'attachments', 'headless.log'))) }],
    };
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
    expect(aggregateGateIReceipts([dir])).toMatchObject({ status: 'passed' });
    // platform 声明非法 → blocked
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ ...receipt, platform: 'windows' }, null, 2));
    expect(aggregateGateIReceipts([dir])).toMatchObject({ status: 'blocked', code: 'GATE_I_RECEIPT_PLATFORM_INVALID' });
    // 附件篡改 → blocked
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
    writeFileSync(join(dir, 'attachments', 'headless.log'), 'tampered');
    expect(aggregateGateIReceipts([dir])).toMatchObject({ status: 'blocked', code: 'GATE_I_RECEIPT_ATTACHMENT_MISMATCH' });
  });
});
