// tests/regressions/known-failures/kf-017-forge-placeholder-verification.regression.test.ts — KF-017 已修复回归
// 注册表状态机：quarantine 不得任意跳转 verified——验证必须经 verify() 携带证据（严禁占位符伪 verified）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegistry } from '../../../src/forge/registry.js';

describe('KF-017 resolved: 验证状态须证据（不任意跳 verified）', () => {
  it('setStatus(id, verified) 无证据 → 状态保持 quarantine（伪 verified 拒绝）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf017r-'));
    try {
      const reg = createRegistry(join(dir, 'registry.json'));
      const id = reg.add({ name: 'ph', kind: 'mcp', source: '/x', version: '1.0.0' });
      reg.setStatus(id, 'verified');
      expect(reg.get(id)!.status).toBe('quarantine');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verify() 需证据：空证据拒绝；有证据 → verified 落库持久化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf017v-'));
    try {
      const file = join(dir, 'registry.json');
      const reg = createRegistry(file);
      const id = reg.add({ name: 'ph2', kind: 'skill', source: '/y', version: '1.0.0' });
      expect(reg.verify(id, {})).toMatchObject({ ok: false });
      expect(reg.get(id)!.status).toBe('quarantine');
      expect(reg.verify(id, { built: true, sha256: 'a'.repeat(64) })).toMatchObject({ ok: true });
      expect(reg.get(id)!.status).toBe('verified');
      const reg2 = createRegistry(file);
      expect(reg2.get(id)!.status).toBe('verified'); // 持久化读回
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('状态机：quarantine 不得直接 installed（不跳过验证）；verified → installed 允许', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-kf017s-'));
    try {
      const reg = createRegistry(join(dir, 'registry.json'));
      const id = reg.add({ name: 'ph3', kind: 'mcp', source: '/z', version: '1.0.0' });
      reg.setStatus(id, 'installed');
      expect(reg.get(id)!.status).toBe('quarantine'); // 未验证不得安装
      reg.verify(id, { built: true });
      reg.setStatus(id, 'installed');
      expect(reg.get(id)!.status).toBe('installed');
      reg.setStatus(id, 'quarantine'); // 撤销（篡改检测）仍允许
      expect(reg.get(id)!.status).toBe('quarantine');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
