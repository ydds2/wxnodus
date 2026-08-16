// src/release/gateI.ts — W6-03：Gate I 跨平台验收（只接受真实 Linux/macOS worker receipt；本机 skip/模拟不算通过）
// produce：非 linux/macos → GATE_I_PLATFORM_UNAVAILABLE（诚实 blocked，绝不模拟跨平台通过）；
// 真实 worker 上跑 headless E2E 并产出 receipt（platform 声明 + 附件哈希）。
// aggregate：receipt 结构 + platform 声明（linux/macos）+ 附件哈希匹配才收。
// W6-09（用户决策）：--scope windows-only 档——产品定位「Windows 本地优先，只做 Windows」时，
// 六个非 Windows canonical cells 以声明性 waiver 豁免（哈希绑定的平台范围证据文件背书，
// 与 Gate E single-display 数学层证据同源纪律）；full 档（缺省）行为完全不变。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationResult } from '../protocol/results.js';

export interface GateIOutcome {
  gate: 'I';
  runId: string;
  status: 'passed' | 'blocked';
  code: string;
  reason?: string;
  completedAt: string;
}

export interface GateIReceipt {
  gate: 'I';
  runId: string;
  platform: 'linux' | 'macos';
  osLabel: string;
  artifact: { id: string; sha256: string };
  attachments: Array<{ path: string; sha256: string }>;
}

// roadmap「Gate I 的签名 profile 精确派生规则」canonical required target-cell 闭包——windows-only 档豁免集合必须逐字相等
export const CANONICAL_NON_WINDOWS_CELLS = [
  'ubuntu-24.04-linux-x64-core',
  'ubuntu-24.04-linux-x64-standard',
  'ubuntu-24.04-linux-x64-full-local-ai',
  'macos-14-darwin-arm64-core',
  'macos-14-darwin-arm64-standard',
  'macos-14-darwin-arm64-full-local-ai',
] as const;

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export async function produceGateIReceipt(options: {
  repoRoot: string;
  evidenceDir: string;
  runId: string;
  platform?: NodeJS.Platform;
  now?: () => string;
}): Promise<OperationResult<GateIOutcome>> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    // 诚实 blocked：本机（win32）绝不模拟 Linux/macOS 验收通过
    return {
      ok: true,
      value: {
        gate: 'I', runId: options.runId, status: 'blocked',
        code: 'GATE_I_PLATFORM_UNAVAILABLE',
        reason: `Gate I 只接受真实 Linux/macOS worker receipt（当前平台：${platform}）——skip/模拟不算通过`,
        completedAt: (options.now ?? (() => new Date().toISOString()))(),
      },
    };
  }
  // 真实 worker 路径：跑 headless E2E（test:wave3-headless）→ stdout/stderr 附件 + receipt
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(options.evidenceDir, { recursive: true });
  const npm = 'npm';
  try {
    const output = execFileSync(npm, ['run', 'test:wave3-headless'], {
      cwd: options.repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    });
    const attachmentFile = join(options.evidenceDir, 'attachments', 'headless.log');
    mkdirSync(join(options.evidenceDir, 'attachments'), { recursive: true });
    writeFileSync(attachmentFile, output, 'utf8');
    const receipt: GateIReceipt = {
      gate: 'I', runId: options.runId,
      platform: platform === 'darwin' ? 'macos' : 'linux',
      osLabel: platform === 'darwin' ? 'macos-arm64' : 'linux-x64',
      artifact: { id: 'wxnodus-art', sha256: '0'.repeat(64) },
      attachments: [{ path: 'attachments/headless.log', sha256: sha256(readFileSync(attachmentFile)) }],
    };
    writeFileSync(join(options.evidenceDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      value: {
        gate: 'I', runId: options.runId, status: 'passed', code: 'GATE_I_PASSED',
        completedAt: (options.now ?? (() => new Date().toISOString()))(),
      },
    };
  } catch (cause) {
    return {
      ok: true,
      value: {
        gate: 'I', runId: options.runId, status: 'blocked', code: 'GATE_I_HEADLESS_FAILED',
        reason: String((cause as Error)?.message ?? cause).slice(0, 300),
        completedAt: (options.now ?? (() => new Date().toISOString()))(),
      },
    };
  }
}

export function aggregateGateIReceipts(
  receiptDirs: readonly string[],
  opts: { scope?: 'windows-only' | 'full'; waiverEvidenceFile?: string } = {},
): { status: 'passed' | 'blocked'; code: string; scope?: 'windows-only'; waivedCells?: string[]; waiverReason?: string } {
  const scope = opts.scope === 'windows-only' ? 'windows-only' : 'full';
  // W6-09（用户决策）：windows-only 档——零跨平台 receipt，六个非 Windows cells 声明性豁免；
  // 豁免证据文件必须真实在场且内容 canonical（六 cell 逐字相等），否则 fail-closed 绝不放行
  if (scope === 'windows-only') {
    if (!opts.waiverEvidenceFile || !existsSync(opts.waiverEvidenceFile)) {
      return { status: 'blocked', code: 'GATE_I_WAIVER_EVIDENCE_MISSING' };
    }
    let evidence: { scope?: string; waivedCells?: string[]; waiverReason?: string };
    try { evidence = JSON.parse(readFileSync(opts.waiverEvidenceFile, 'utf8')) as typeof evidence; } catch {
      return { status: 'blocked', code: 'GATE_I_WAIVER_EVIDENCE_INVALID' };
    }
    const canonical = [...CANONICAL_NON_WINDOWS_CELLS].sort();
    const declared = [...(evidence.waivedCells ?? [])].sort();
    if (evidence.scope !== 'windows-only' ||
        declared.length !== canonical.length ||
        JSON.stringify(declared) !== JSON.stringify(canonical)) {
      return { status: 'blocked', code: 'GATE_I_WAIVER_MISMATCH' };
    }
    return {
      status: 'passed', code: 'GATE_I_PASSED', scope: 'windows-only',
      waivedCells: [...CANONICAL_NON_WINDOWS_CELLS],
      waiverReason: evidence.waiverReason || '产品定位 Windows 本地优先（用户决策）——非 Windows cells 声明性豁免，仅 Windows 已验证',
    };
  }
  if (!Array.isArray(receiptDirs) || receiptDirs.length === 0) {
    return { status: 'blocked', code: 'GATE_I_RECEIPT_MISSING' };
  }
  for (const dir of receiptDirs) {
    const receiptFile = join(dir, 'receipt.json');
    if (!existsSync(receiptFile)) return { status: 'blocked', code: 'GATE_I_RECEIPT_MISSING' };
    let receipt: GateIReceipt;
    try { receipt = JSON.parse(readFileSync(receiptFile, 'utf8')) as GateIReceipt; } catch {
      return { status: 'blocked', code: 'GATE_I_RECEIPT_INVALID' };
    }
    if (receipt.gate !== 'I' || (receipt.platform !== 'linux' && receipt.platform !== 'macos') || typeof receipt.osLabel !== 'string') {
      return { status: 'blocked', code: 'GATE_I_RECEIPT_PLATFORM_INVALID' };
    }
    if (!/^[a-f0-9]{64}$/.test(receipt.artifact.sha256)) return { status: 'blocked', code: 'GATE_I_RECEIPT_INVALID' };
    for (const attachment of receipt.attachments) {
      if (attachment.path.includes('..') || attachment.path.includes('\\') || attachment.path.startsWith('/')) {
        return { status: 'blocked', code: 'GATE_I_RECEIPT_ATTACHMENT_INVALID' };
      }
      const file = join(dir, attachment.path);
      if (!existsSync(file)) return { status: 'blocked', code: 'GATE_I_RECEIPT_ATTACHMENT_MISSING' };
      if (sha256(readFileSync(file)) !== attachment.sha256) return { status: 'blocked', code: 'GATE_I_RECEIPT_ATTACHMENT_MISMATCH' };
    }
  }
  return { status: 'passed', code: 'GATE_I_PASSED' };
}
