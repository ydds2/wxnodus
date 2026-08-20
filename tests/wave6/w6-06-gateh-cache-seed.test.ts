// tests/wave6/w6-06-gateh-cache-seed.test.ts — W6-06 契约：Gate H clean-install 缓存注入
// 缺口（实盘发现）：clean-install 硬编码全新空 npm 缓存 + --offline——任何机器上都只能
// ENOTCACHED blocked，airgap 步骤机制不完整。契约：
// ① seedNpmCache 把预热缓存复制进 stage（缺失 seed 诚实 ok:false）；
// ② defaultCleanInstall 在 npm install --offline 前注入缓存（源锚点）；
// ③ run-gate-h CLI 支持 --cache-seed 透传（源锚点）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { offlineRegistryFor, seedNpmCache } from '../../src/release/gateHRunner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) { try { close(); } catch { /* 已清理 */ } } });
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe('W6-06 Gate H 缓存注入（airgap clean-install 可完成）', () => {
  it('seedNpmCache：预热缓存复制进 stage（_cacache 结构保留）；缺失 seed 诚实失败', () => {
    const stage = tmp('w6-seed-stage-');
    const seed = tmp('w6-seed-');
    mkdirSync(join(seed, '_cacache', 'content-v2'), { recursive: true });
    writeFileSync(join(seed, '_cacache', 'content-v2', 'index'), '{"version":2}');
    mkdirSync(join(seed, '_cacache', 'index-v5'), { recursive: true });
    writeFileSync(join(seed, '_cacache', 'index-v5', 'marker'), 'x');
    const ok = seedNpmCache(join(stage, 'npm-cache'), seed);
    expect(ok.ok).toBe(true);
    expect(existsSync(join(stage, 'npm-cache', '_cacache', 'index-v5', 'marker'))).toBe(true);
    const missing = seedNpmCache(join(stage, 'npm-cache-2'), join(stage, 'no-such-seed'));
    expect(missing.ok).toBe(false);
  });

  it('源锚点：defaultCleanInstall 在 npm install --offline 前注入 cacheSeed', () => {
    const src = readFileSync(resolve(ROOT, 'src/release/gateHRunner.ts'), 'utf8');
    const block = src.slice(src.indexOf('const defaultCleanInstall'), src.indexOf('const defaultCleanInstall') + 2200);
    expect(block).toContain('cacheSeed');
    expect(block).toContain('seedNpmCache');
    expect(block).toContain("['install'"); // npm install 参数数组（--offline 在其中）
    // 注入发生在 npm install 执行之前
    expect(block.indexOf('seedNpmCache')).toBeLessThan(block.indexOf("['install'"));
  });

  it('源锚点：run-gate-h CLI 支持 --cache-seed 透传', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/run-gate-h.ts'), 'utf8');
    expect(src).toContain('cache-seed');
    expect(src).toContain('cacheSeed');
  });

  // W8-15（实盘缺陷）：seed 由真实 registry 流量构建；干净 HOME 让 npm 回退 npmjs.org →
  // 缓存键空间不匹配 → ENOTCACHED 假阴性。离线安装必须与 seed 同 registry 键空间。
  it('offlineRegistryFor：读 repo registry 配置（http(s) 形）；失败回退 npmjs.org 缺省', () => {
    const registry = offlineRegistryFor(ROOT);
    expect(/^https?:\/\//.test(registry)).toBe(true);
    const fallback = offlineRegistryFor(join(tmp('w8-15-'), 'no-such-repo'));
    expect(fallback).toBe('https://registry.npmjs.org');
  });

  it('源锚点：defaultCleanInstall 注入 npm_config_registry（与 seed 键空间一致）', () => {
    const src = readFileSync(resolve(ROOT, 'src/release/gateHRunner.ts'), 'utf8');
    const block = src.slice(src.indexOf('const defaultCleanInstall'), src.indexOf('const defaultCleanInstall') + 2400);
    expect(block).toContain('npm_config_registry');
    expect(block).toContain('offlineRegistryFor');
  });
});
