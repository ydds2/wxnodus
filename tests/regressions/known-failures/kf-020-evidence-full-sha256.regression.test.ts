// tests/regressions/known-failures/kf-020-evidence-full-sha256.regression.test.ts — KF-020 迁移绿回归
// 契约：证据指纹必须是完整 SHA-256（64 hex）——6 hex 截断的碰撞空间不可接受；
// 指纹对内容变化敏感、对 evidence.json 自身免疫（写入不改变指纹）。
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fingerprint, writeEvidence, readEvidence } from '../../../src/build/evidence.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-kf-020-')); tempDirs.push(d); return d; };

describe('KF-020 resolved: 证据指纹完整 SHA-256', () => {
  it('指纹长度 64 hex（不再截断）', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), '内容');
    expect(fingerprint(dir)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('内容变化 → 指纹变化（完整性语义保持）', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'v1');
    const before = fingerprint(dir);
    writeFileSync(join(dir, 'a.txt'), 'v2');
    expect(fingerprint(dir)).not.toBe(before);
  });

  it('写入 evidence.json 不改变指纹（自免疫）', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'x');
    const before = fingerprint(dir);
    expect(writeEvidence(dir, { status: 'ok', checks: ['probe'], port: null })).toBe(true);
    expect(fingerprint(dir)).toBe(before);
    const ev = readEvidence(dir);
    expect(ev?.fingerprint).toBe(before);
    expect(JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')).fingerprint).toHaveLength(64);
  });
});
