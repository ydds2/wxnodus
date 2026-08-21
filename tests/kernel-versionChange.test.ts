// 版本变更检测（升级后首启提示）：变更→文案+落盘；一致/首启→null
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectVersionChange } from '../src/kernel/versionChange.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('detectVersionChange', () => {
  it('首启（无记录）：落盘当前版本，返回 null', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-ver-')); dirs.push(d);
    expect(detectVersionChange(d, '4.0.0-rc.1')).toBeNull();
    expect(JSON.parse(readFileSync(join(d, 'last-version.json'), 'utf8')).version).toBe('4.0.0-rc.1');
  });
  it('版本变更：返回「已更新 x→y」文案 + 落盘新版本', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-ver-')); dirs.push(d);
    detectVersionChange(d, '3.2.0');
    const msg = detectVersionChange(d, '4.0.0-rc.1');
    expect(msg).toContain('已更新 3.2.0 → 4.0.0-rc.1');
    expect(JSON.parse(readFileSync(join(d, 'last-version.json'), 'utf8')).version).toBe('4.0.0-rc.1');
  });
  it('版本一致：null（零输出零打扰）', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-ver-')); dirs.push(d);
    detectVersionChange(d, '4.0.0-rc.1');
    expect(detectVersionChange(d, '4.0.0-rc.1')).toBeNull();
  });
});
