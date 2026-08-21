// tests/wave-p0/p0-release-signal.test.ts — W0-02：known-failure oracle 与 release eligibility 分离
// oracle 绿色只证明缺陷稳定复现；release 放行必须全部 required gate 终态可判定且无 open P0 blocker。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseEligibility } from '../../src/release/releaseEligibility.js';
import { KNOWN_FAILURES } from '../../src/release/knownFailures.js';
import { checkReleaseEligibility } from '../../src/cli/checkReleaseEligibility.js';
import type { RunFinalStatus } from '../../src/protocol/runs.js';

const required = ['A', 'B', 'C', 'F', 'G'];

const outcomes = (overrides: Record<string, string> = {}) => required.map(gate => ({
  gate,
  status: overrides[gate] ?? 'passed',
}));

describe('release eligibility signal', () => {
  it('is eligible only when every required gate passed and no open P0 blocker remains', () => {
    expect(releaseEligibility({ requiredGates: required, outcomes: outcomes(), openBlockers: [] }))
      .toEqual({ status: 'succeeded', code: null, reasons: [] });
  });

  it('known failure ledger fully resolved（零 open——账本 30/30 迁移完毕）', () => {
    expect(KNOWN_FAILURES.filter(entry => entry.status === 'open')).toEqual([]);
  });

  it('blocks with RELEASE_BLOCKED_OPEN_P0 while any open blocker is supplied', () => {
    expect(releaseEligibility({ requiredGates: required, outcomes: outcomes(), openBlockers: ['KF-023'] }))
      .toMatchObject({ status: 'blocked', code: 'RELEASE_BLOCKED_OPEN_P0' });
  });

  it('reports failed for a failed required gate and never lets it pass', () => {
    const result = releaseEligibility({ requiredGates: required, outcomes: outcomes({ F: 'failed' }), openBlockers: [] });
    expect(result.status).toBe('failed');
    expect(result.code).toMatch(/^RELEASE_REQUIRED_GATE_FAILED/);
    expect(result.status).not.toBe('succeeded');
  });

  it.each(['blocked', 'cancelled', 'inconclusive', 'incomplete', 'not_applicable'] as const)(
    'never releases on a required gate terminal status %s',
    status => {
      const result = releaseEligibility({ requiredGates: required, outcomes: outcomes({ G: status }), openBlockers: [] });
      expect(result.status).not.toBe('succeeded');
      expect(['blocked', 'cancelled', 'inconclusive', 'incomplete']).toContain(result.status);
      expect(result.code).not.toBeNull();
    },
  );

  it('reports incomplete when a required gate has no outcome at all', () => {
    const result = releaseEligibility({
      requiredGates: required,
      outcomes: outcomes().filter(item => item.gate !== 'B'),
      openBlockers: [],
    });
    expect(result).toMatchObject({ status: 'incomplete', code: 'RELEASE_GATE_OUTCOME_MISSING' });
  });

  it('attaches open P0 to the reasons even when a gate already failed', () => {
    const result = releaseEligibility({
      requiredGates: required,
      outcomes: outcomes({ F: 'failed' }),
      openBlockers: ['KF-023'],
    });
    expect(result.status).toBe('failed');
    expect(result.reasons).toContain('RELEASE_BLOCKED_OPEN_P0');
  });

  it.each(RUN_FINAL_STATUS_LIST)('preserves terminal status %s without upgrading to succeeded', status => {
    if (status === 'succeeded') return;
    const result = releaseEligibility({
      requiredGates: required,
      outcomes: outcomes({ F: status }),
      openBlockers: [],
    });
    expect(result.status).not.toBe('succeeded');
  });
});

describe('release eligibility adapter', () => {
  it('passes with exit 0 when all gates passed and no open known failures remain（账本已清零）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-release-eligibility-'));
    try {
      const gatesPath = join(root, 'gates.json');
      await writeFile(gatesPath, JSON.stringify(required.map(gate => ({ gate, status: 'passed' }))));
      const exit = checkReleaseEligibility(['--gates', gatesPath, '--required', 'A,B,C,F,G']);
      expect(exit).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns failed exit 1 when a required gate failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-release-failed-'));
    try {
      const gatesPath = join(root, 'gates.json');
      await writeFile(gatesPath, JSON.stringify(required.map(gate => ({ gate, status: gate === 'F' ? 'failed' : 'passed' }))));
      const exit = checkReleaseEligibility(['--gates', gatesPath, '--required', 'A,B,C,F,G']);
      expect(exit).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns incomplete exit 53 when no gate outcomes file exists', async () => {
    expect(checkReleaseEligibility(['--gates', 'C:/nonexistent/does-not-exist/gates.json'])).toBe(53);
  });
});

const RUN_FINAL_STATUS_LIST: RunFinalStatus[] = ['succeeded', 'failed', 'blocked', 'incomplete', 'inconclusive', 'cancelled'];
