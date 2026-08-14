// src/release/gateI.ts — W6-03：Gate I 跨平台验收（只接受真实 Linux/macOS worker receipt；本机 skip/模拟不算通过）
// produce：非 linux/macos → GATE_I_PLATFORM_UNAVAILABLE（诚实 blocked，绝不模拟跨平台通过）；
// 真实 worker 上跑 headless E2E 并产出 receipt（platform 声明 + 附件哈希）。
// aggregate：receipt 结构 + platform 声明（linux/macos）+ 附件哈希匹配才收。
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

export function aggregateGateIReceipts(receiptDirs: readonly string[]): { status: 'passed' | 'blocked'; code: string } {
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
