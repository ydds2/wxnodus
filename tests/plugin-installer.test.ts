// tests/plugin-installer.test.ts — /plugin install 第三方插件接收（S-02 接收侧，2026-08-18）
// 契约：目录/zip/URL 三源安装；包结构校验；可选 sha256 完整性校验；原子落位；启用失败回滚；
//       同名拒装；诚实提示未校验哈希。SSRF 由 ctx.download（checkUrlSafety）承担——不在此重复。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPluginPackage } from '../src/application/extensions/pluginInstaller.js';
import { buildZip } from '../src/application/release/zipArchive.js';

let root: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-plugin-inst-'));
  dataDir = join(root, 'data');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const manifest = (name: string, version = '1.0.0') => JSON.stringify({
  name, version, description: '测试插件',
  tools: [{ name: `${name}_hello`, description: '打招呼', parameters: { name: { type: 'string' } } }],
});
const indexJs = `export const tools = { hello: async () => 'hi' };\n`;

/** 写一个含两文件的本地插件源目录，返回其路径 */
const writeSourceDir = (name: string, manifestText: string, js = indexJs): string => {
  const src = join(root, `src-${name}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'plugin.json'), manifestText);
  writeFileSync(join(src, 'index.js'), js);
  return src;
};

const noEnable = { enable: undefined } as const;
const failEnable = { enable: async () => ({ ok: false, detail: 'SANDBOX_GATE_FAILED: probe 失败' }) } as const;
const okEnable = (calls: Array<string>) => ({ enable: async (dir: string) => { calls.push(dir); return { ok: true }; } } as const);

describe('/plugin install 第三方接收', () => {
  it('本地目录安装：落位 + 返回报告', async () => {
    const src = writeSourceDir('alpha', manifest('alpha'));
    const r = await installPluginPackage({ source: src, dataDir, ...noEnable });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe('alpha');
    expect(r.toolCount).toBe(1);
    expect(r.sourceSha256).toBeNull();
    expect(r.sha256Verified).toBe(false);
    expect(r.note).toContain('未校验');
    expect(existsSync(join(dataDir, 'plugins', 'alpha', 'plugin.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'plugins', 'alpha', 'index.js'))).toBe(true);
  });

  it('本地 zip（根级布局）安装：sha256 计算返回', async () => {
    const zip = buildZip([
      { path: 'plugin.json', content: Buffer.from(manifest('beta')) },
      { path: 'index.js', content: Buffer.from(indexJs) },
    ]);
    const zipPath = join(root, 'beta.zip');
    writeFileSync(zipPath, zip);
    const r = await installPluginPackage({ source: zipPath, dataDir, ...noEnable });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dataDir, 'plugins', 'beta', 'index.js'))).toBe(true);
  });

  it('zip 单层目录布局：前缀剥离后安装', async () => {
    const zip = buildZip([
      { path: 'gamma-1.0/plugin.json', content: Buffer.from(manifest('gamma')) },
      { path: 'gamma-1.0/index.js', content: Buffer.from(indexJs) },
    ]);
    const zipPath = join(root, 'gamma.zip');
    writeFileSync(zipPath, zip);
    const r = await installPluginPackage({ source: zipPath, dataDir, ...noEnable });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe('gamma');
    expect(existsSync(join(dataDir, 'plugins', 'gamma', 'plugin.json'))).toBe(true);
  });

  it('URL 来源：download 回调被调用并安装', async () => {
    const zip = buildZip([{ path: 'plugin.json', content: Buffer.from(manifest('delta')) }, { path: 'index.js', content: Buffer.from(indexJs) }]);
    const zipPath = join(root, 'delta.zip');
    writeFileSync(zipPath, zip);
    const calls: string[] = [];
    const r = await installPluginPackage({
      source: 'https://third.party/delta.zip', dataDir,
      download: async (url) => { calls.push(url); return { filePath: zipPath, bytes: zip.length }; },
      ...noEnable,
    });
    expect(calls).toEqual(['https://third.party/delta.zip']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe('delta');
  });

  it('包缺 plugin.json → 拒绝', async () => {
    const zip = buildZip([{ path: 'index.js', content: Buffer.from(indexJs) }]);
    const zipPath = join(root, 'bad.zip');
    writeFileSync(zipPath, zip);
    const r = await installPluginPackage({ source: zipPath, dataDir, ...noEnable });
    expect(r).toMatchObject({ ok: false, code: 'PLUGIN_INSTALL_BAD_PACKAGE' });
  });

  it('损坏 plugin.json → 拒绝（不落位）', async () => {
    const src = writeSourceDir('broken', '{{ 损坏');
    const r = await installPluginPackage({ source: src, dataDir, ...noEnable });
    expect(r).toMatchObject({ ok: false, code: 'PLUGIN_MANIFEST_INVALID' });
    expect(existsSync(join(dataDir, 'plugins', 'broken'))).toBe(false);
  });

  it('--sha256 相符 → 校验通过；不符 → 拒绝', async () => {
    const zip = buildZip([{ path: 'plugin.json', content: Buffer.from(manifest('sec')) }, { path: 'index.js', content: Buffer.from(indexJs) }]);
    const zipPath = join(root, 'sec.zip');
    writeFileSync(zipPath, zip);
    const { createHash } = await import('node:crypto');
    const good = createHash('sha256').update(zip).digest('hex');
    const okR = await installPluginPackage({ source: zipPath, dataDir, expectedSha256: good, ...noEnable });
    expect(okR.ok).toBe(true);
    if (okR.ok) expect(okR.sha256Verified).toBe(true);
    rmSync(join(dataDir, 'plugins'), { recursive: true, force: true });
    const badR = await installPluginPackage({ source: zipPath, dataDir, expectedSha256: 'f'.repeat(64), ...noEnable });
    expect(badR).toMatchObject({ ok: false, code: 'PLUGIN_INSTALL_SHA256_MISMATCH' });
    expect(existsSync(join(dataDir, 'plugins', 'sec'))).toBe(false);
  });

  it('同名已装 → 拒绝（提示先 uninstall）', async () => {
    const src = writeSourceDir('dup', manifest('dup'));
    await installPluginPackage({ source: src, dataDir, ...noEnable });
    const r = await installPluginPackage({ source: src, dataDir, ...noEnable });
    expect(r).toMatchObject({ ok: false, code: 'PLUGIN_ALREADY_INSTALLED' });
  });

  it('启用失败 → 回滚落位（绝不残留半装插件）', async () => {
    const src = writeSourceDir('rollback', manifest('rollback'));
    const r = await installPluginPackage({ source: src, dataDir, ...failEnable });
    expect(r).toMatchObject({ ok: false, code: 'PLUGIN_INSTALL_ENABLE_FAILED' });
    expect(existsSync(join(dataDir, 'plugins', 'rollback'))).toBe(false);
  });

  it('启用成功 → enabled=true 且 enable 收到落位目录', async () => {
    const src = writeSourceDir('ena', manifest('ena'));
    const calls: string[] = [];
    const r = await installPluginPackage({ source: src, dataDir, ...okEnable(calls) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.enabled).toBe(true);
    expect(calls).toEqual([join(dataDir, 'plugins', 'ena')]);
  });
});
