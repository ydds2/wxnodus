// tests/wave3/w3-spec-acceptance.test.ts — spec → 结构化验收契约（模具确定性锚点；未知模具 fail-closed）
import { describe, expect, it } from 'vitest';
import { specToAcceptance } from '../../src/build/specAcceptance.js';

describe('spec acceptance adapter', () => {
  it('maps scaffolds to verifiable criteria', () => {
    const result = specToAcceptance({ scaffold: 'todo', title: '待办系统', acceptance: ['待办增删查'] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toMatchObject({ verifierId: 'file.exists', expected: { path: 'server/index.js' }, required: true });
    expect(result.value[1]).toMatchObject({ expected: { path: 'healthcheck.js' } });
  });

  it('fails closed on unknown scaffolds (no fake acceptance)', () => {
    const result = specToAcceptance({ scaffold: 'unknown', title: 'x', acceptance: ['a'] });
    expect(result).toMatchObject({ ok: false, error: { code: 'BUILD_ACCEPTANCE_UNSPECIFIED' } });
  });

  it('fails closed on missing scaffold', () => {
    const result = specToAcceptance({ title: 'x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'BUILD_ACCEPTANCE_UNSPECIFIED' } });
  });
});
