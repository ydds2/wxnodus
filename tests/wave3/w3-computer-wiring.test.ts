// tests/wave3/w3-computer-wiring.test.ts — W3 Computer facade：生产端口组装 + 真实证据落盘
import { mkdtemp, rm } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ComputerUseService } from '../../src/application/computer/computerUseService.js';
import { createProductionComputerPorts } from '../../src/application/computer/computerWiring.js';
import { createComputerEvidenceStore } from '../../src/application/computer/computerEvidenceStore.js';

const mkdtempAsync = promisify(mkdtemp);
const rmAsync = promisify(rm);

const marker = { path: join(tmpdir(), 'wxnodus-done-marker.txt'), matcher: 'done' };
const context = { actorId: 'a1', sessionId: 's1', runId: 'r1', effectId: 'e1', correlationId: 'c1' };
const request = {
  kind: 'click',
  target: { type: 'screen', id: 'main', display: '主屏' },
  effect: { summary: '点击按钮', parameters: { path: marker.path } },
  verification: { verifierId: 'file.exists', description: '动作后标记文件存在（re-observe 观察值）' },
};

let observations = 0;
const kernel = {
  observe: async () => {
    observations += 1;
    // 第一次观察：动作前（截图）；第二次观察：动作后（观察值携带校验路径——真实 re-observe 语义）
    return observations === 1
      ? { png: Buffer.from('png'), width: 800, height: 600, scale: 1 }
      : { png: Buffer.from('png2'), width: 800, height: 600, scale: 1, path: marker.path };
  },
  act: async () => '已点击 (10,20)',
};

describe('computer wiring', () => {
  it('assembles the production pipeline and runs the fixed stage order', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(marker.path, 'job done', 'utf8');
    const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-computer-'));
    try {
      const evidence = createComputerEvidenceStore(root);
      const ports = createProductionComputerPorts({
        kernel,
        emergencyStop: { active: () => false },
        pdp: { decide: async () => ({ ok: true as const, value: { allow: true } }) },
        approvals: { authorize: async () => ({ ok: true as const, value: undefined }) },
        evidence,
      });
      const service = new ComputerUseService(ports);
      const result = await service.execute(request, context, AbortSignal.timeout(5_000));
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      // 证据真实落盘且读回重算一致
      const read = evidence.readEvidence(result.value.evidenceId);
      expect(read.ok).toBe(true);
      if (read.ok) expect((read.value.bundle as { context: { effectId: string } }).context.effectId).toBe('e1');
    } finally {
      await rmAsync(root, { recursive: true, force: true });
      await rmAsync(marker.path, { force: true });
    }
  });

  it('fails closed without an injected pdp (no policy, no action)', async () => {
    const ports = createProductionComputerPorts({ kernel, emergencyStop: { active: () => false } });
    const service = new ComputerUseService(ports);
    const result = await service.execute(request, context, AbortSignal.timeout(5_000));
    expect(result).toMatchObject({ ok: false, error: { code: 'COMPUTER_PDP_UNAVAILABLE' } });
  });

  it('rejects tampered evidence on read-back (sha256 recomputation)', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-computer-ev-'));
    try {
      const { writeFileSync, readFileSync } = await import('node:fs');
      const evidence = createComputerEvidenceStore(root);
      const closed = await evidence.closeComputerAction({ marker: 'x' });
      if (!closed.ok) throw new Error(closed.error.code);
      const path = join(root, 'evidence', 'computer', closed.value.evidenceId + '.json');
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      parsed.bundle = { marker: 'tampered' };
      writeFileSync(path, JSON.stringify(parsed), 'utf8');
      expect(evidence.readEvidence(closed.value.evidenceId)).toMatchObject({ ok: false, error: { code: 'COMPUTER_EVIDENCE_INTEGRITY_FAILED' } });
    } finally {
      await rmAsync(root, { recursive: true, force: true });
    }
  });

  it('high impact kinds are recognized by the pdp default helper', async () => {
    const { highImpactOf } = await import('../../src/application/computer/computerWiring.js');
    expect(highImpactOf({ ...request, kind: 'payment' } as never)).toBe(true);
    expect(highImpactOf(request as never)).toBe(false);
  });
});
