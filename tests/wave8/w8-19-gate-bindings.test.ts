// tests/wave8/w8-19-gate-bindings.test.ts — W8-19：wave3 门绑定解析（kebab flag → camelCase）
// 实盘缺陷：run-wave3-gates 曾 kebab-case 存、camelCase 读——绑定恒 undefined → C-W3 drill
// 收到空候选/工件哈希 → 假 blocked（missing bin / hash drift）。解析必须真实映射，缺失如实 undefined。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGateBindings } from '../../src/release/gateBindings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('W8-19 wave3 门绑定解析', () => {
  it('kebab flag → camelCase 绑定真实映射（不再恒空）', () => {
    const binding = parseGateBindings([
      '--run', 'run-x',
      '--candidate-commit', 'a'.repeat(40),
      '--artifact-id', 'cand-test',
      '--artifact-sha256', 'b'.repeat(64),
      '--environment-snapshot', 'env-1',
    ]);
    expect(binding).toEqual({
      candidateCommit: 'a'.repeat(40),
      artifactId: 'cand-test',
      artifactSha256: 'b'.repeat(64),
      environmentSnapshot: 'env-1',
    });
  });

  it('缺失 flag 如实 undefined（绝不编默认值——绑定必须显式供给）', () => {
    expect(parseGateBindings(['--run', 'run-x'])).toEqual({});
    expect(parseGateBindings(['--candidate-commit', 'x'])).toEqual({ candidateCommit: 'x' });
  });

  it('源锚点：run-wave3-gates 使用 parseGateBindings 并把冻结 tgz 哈希绑定供给 C-W3（跑完清理）', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'run-wave3-gates.mjs'), 'utf8');
    expect(src).toContain('parseGateBindings(args)');
    expect(src).toContain('candidate-artifact.bin');
    expect(src).toContain('copyFileSync(frozenTgz, artifactBin)');
    expect(src).toContain('rmSync(artifactBin');
  });
});
