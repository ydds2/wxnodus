// tests/kernel-bundle.test.ts — 场景整合包（Modpack 对标：清单规整/一键安装/离线导出/场景应用）
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createBundle, editBundle, exportBundle, importBundle, installBundle, listBundles, loadBundle, useBundle, validateExtractedTree } from '../src/kernel/bundle.js'
import type { MarketDeps } from '../src/kernel/market.js'
import type { BundleManifest } from '../src/kernel/bundle.js'

const dir = mkdtempSync(join(tmpdir(), 'wxn-bundle-'))
const dataDir = join(dir, 'data')
const cwd = join(dir, 'proj')
beforeAll(() => { mkdirSync(dataDir, { recursive: true }); mkdirSync(cwd, { recursive: true }) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const okDeps: MarketDeps = {
  safety: async () => ({ ok: true }),
  fetchImpl: async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/latest')) return new Response(JSON.stringify({ version: '1.0.0', dist: { tarball: `${url}/x.tgz` } }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ objects: [] }), { status: 200 })
  },
}

describe('整合包清单 CRUD', () => {
  it('create/load/list 往返；名称非法/重复诚实报错', () => {
    const c = createBundle(dataDir, 'FrontEnd', '前端场景')
    expect(c.ok).toBe(true)
    const dup = createBundle(dataDir, 'frontend', 'x')
    expect(dup.ok).toBe(false)
    expect(dup.message).toContain('已存在')
    const bad = createBundle(dataDir, '9bad', 'x')
    expect(bad.ok).toBe(false)
    expect(loadBundle(dataDir, 'frontend').ok).toBe(true)
    expect(listBundles(dataDir)).toHaveLength(1)
    const broken = loadBundle(dataDir, 'nope')
    expect(broken.ok).toBe(false)
  })

  it('add/remove：去重、移除、未找到诚实提示', () => {
    const a1 = editBundle(dataDir, 'frontend', 'skills', 'github:acme/react-skill', 'add')
    expect(a1.ok).toBe(true)
    editBundle(dataDir, 'frontend', 'skills', 'github:acme/react-skill', 'add') // 去重
    editBundle(dataDir, 'frontend', 'mcps', 'npm:mcp-fs', 'add')
    editBundle(dataDir, 'frontend', 'plugins', 'npm:any-plugin', 'add')
    const m = loadBundle(dataDir, 'frontend').manifest!
    expect(m.skills).toEqual(['github:acme/react-skill'])
    expect(m.mcps).toEqual(['npm:mcp-fs'])
    const rm = editBundle(dataDir, 'frontend', 'skills', 'github:acme/react-skill', 'remove')
    expect(rm.ok).toBe(true)
    expect(loadBundle(dataDir, 'frontend').manifest!.skills).toHaveLength(0)
    const miss = editBundle(dataDir, 'frontend', 'skills', 'x', 'remove')
    expect(miss.message).toContain('未找到')
  })
})

describe('整合包安装/导出/应用', () => {
  it('installBundle：mcp 落 .mcp.json、非法 skill 引用诚实报错、plugin 指向 /plugin 管线', async () => {
    editBundle(dataDir, 'frontend', 'skills', 'bad-ref', 'add')
    const m = loadBundle(dataDir, 'frontend').manifest! // editBundle 之后再加载（清单已含 bad-ref）
    const reports = await installBundle(m, dataDir, cwd, okDeps)
    // mcp 成功
    expect(reports.find(r => r.item === 'mcp:mcp-fs')!.ok).toBe(true)
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(true)
    // plugin 提示走 /plugin
    expect(reports.find(r => r.item.includes('plugin'))!.message).toContain('/plugin install')
    // 非法 skill 引用
    expect(reports.find(r => r.item.includes('bad-ref'))!.ok).toBe(false)
  })

  it('useBundle：settings 并入项目配置（场景生产会话）+ MCP 幂等', async () => {
    const m = loadBundle(dataDir, 'frontend').manifest!
    m.config = { settings: { vimMode: true, bashOutputCap: 8000 }, mode: 'smart' }
    const u = await useBundle(m, dataDir, cwd, okDeps)
    expect(u.ok).toBe(true)
    const proj = JSON.parse(readFileSync(join(cwd, '.wxnodus', 'config.json'), 'utf8'))
    expect(proj.settings.vimMode).toBe(true)
    expect(proj.settings.bashOutputCap).toBe(8000)
    const mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers['mcp-fs']).toBeDefined()
  })

  it('exportBundle：tar.gz 含清单 + vendored 已安装技能（离线分发）', () => {
    // 预置一个已安装技能
    mkdirSync(join(dataDir, 'skills', 'react-skill'), { recursive: true })
    writeFileSync(join(dataDir, 'skills', 'react-skill', 'SKILL.md'), '---\nname: react-skill\n---\n', 'utf8')
    editBundle(dataDir, 'frontend', 'skills', 'github:acme/react-skill', 'add')
    const r = exportBundle(dataDir, 'frontend', dataDir)
    expect(r.ok).toBe(true)
    expect(existsSync(r.path!)).toBe(true)
    // 解包验证内容
    const t = spawnSync('tar', ['-xzf', 'frontend-1.0.0.bundle.tgz'], { cwd: dataDir, timeout: 30000 })
    expect(t.status).toBe(0)
    // 解到 dataDir 后检查 bundle.json
    expect(existsSync(join(dataDir, 'frontend', 'bundle.json'))).toBe(true)
    expect(existsSync(join(dataDir, 'frontend', 'vendored', 'react-skill', 'SKILL.md'))).toBe(true)
    rmSync(join(dataDir, 'frontend'), { recursive: true, force: true })
  })
})

describe('N-1~N-8：bundle 修复闭环（import/name 校验/rename 加固/幂等跳过/deferred/use 全量）', () => {
  const mkSkill = (dir: string, name: string) => {
    mkdirSync(join(dir, 'skills', name), { recursive: true });
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8');
  };

  it('N-1 importBundle：export→import 往返（清单 + vendored 技能落位）', () => {
    const b = mkdtempSync(join(tmpdir(), 'wx-imp-'));
    try {
      const bd = join(b, 'data'); mkdirSync(bd, { recursive: true });
      createBundle(bd, 'frontend', '前端场景');
      mkSkill(bd, 'react-skill');
      editBundle(bd, 'frontend', 'skills', 'github:acme/react-skill', 'add');
      const ex = exportBundle(bd, 'frontend', b);
      expect(ex.ok).toBe(true);
      // 模拟另一台机器：清空清单与技能
      rmSync(join(bd, 'bundles'), { recursive: true, force: true });
      rmSync(join(bd, 'skills'), { recursive: true, force: true });
      const im = importBundle(ex.path!, bd);
      expect(im.ok).toBe(true);
      expect(loadBundle(bd, 'frontend').ok).toBe(true);
      expect(existsSync(join(bd, 'skills', 'react-skill', 'SKILL.md'))).toBe(true);
    } finally { rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  it('N-1 importBundle：同名拒绝 / tgz 不存在诚实报错', () => {
    const b = mkdtempSync(join(tmpdir(), 'wx-imp2-'));
    try {
      const bd = join(b, 'data'); mkdirSync(bd, { recursive: true });
      createBundle(bd, 'frontend', 'x');
      mkSkill(bd, 'react-skill');
      editBundle(bd, 'frontend', 'skills', 'github:acme/react-skill', 'add');
      const ex = exportBundle(bd, 'frontend', b);
      expect(ex.ok).toBe(true);
      const again = importBundle(ex.path!, bd);
      expect(again.ok).toBe(false);
      expect(again.message).toContain('已存在');
      const miss = importBundle(join(b, 'nope.tgz'), bd);
      expect(miss.ok).toBe(false);
      expect(miss.message).toContain('文件不存在');
    } finally { rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  it('N-2 loadBundle：name 非法（路径穿越）拒绝', () => {
    const b = mkdtempSync(join(tmpdir(), 'wx-imp3-'));
    try {
      const bd = join(b, 'data'); mkdirSync(join(bd, 'bundles'), { recursive: true });
      writeFileSync(join(bd, 'bundles', 'evil.bundle.json'), JSON.stringify({ name: '../../evil', version: '1.0.0', skills: [], mcps: [], plugins: [] }), 'utf8');
      const r = loadBundle(bd, 'evil');
      expect(r.ok).toBe(false);
      expect(r.message).toContain('损坏');
    } finally { rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  it('N-2 importBundle：manifest name 穿越拒绝（无任何越界写入）', () => {
    const b = mkdtempSync(join(tmpdir(), 'wx-imp4-'));
    try {
      const bd = join(b, 'data'); mkdirSync(bd, { recursive: true });
      const evil = join(b, 'evil'); mkdirSync(evil, { recursive: true });
      writeFileSync(join(evil, 'bundle.json'), JSON.stringify({ name: '../../evil', version: '1.0.0', skills: [], mcps: [], plugins: [] }), 'utf8');
      const tgz = join(b, 'evil.bundle.tgz');
      const t = spawnSync('tar', ['-czf', 'evil.bundle.tgz', 'evil'], { cwd: b, timeout: 30000 });
      expect(t.status).toBe(0);
      const r = importBundle(tgz, bd);
      expect(r.ok).toBe(false);
      expect(existsSync(join(bd, 'bundles', 'evil.bundle.json'))).toBe(false);
    } finally { rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  it('N-1 validateExtractedTree：junction 逃逸拒绝 / 正常树通过', () => {
    const b = mkdtempSync(join(tmpdir(), 'wx-imp5-'));
    try {
      const outside = join(b, 'outside'); mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'secret.txt'), 'x', 'utf8');
      const root = join(b, 'root'); mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'a.txt'), 'a', 'utf8');
      expect(validateExtractedTree(root).ok).toBe(true);
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      symlinkSync(outside, join(root, 'escape'), linkType);
      expect(validateExtractedTree(root).ok).toBe(false);
    } finally { rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  it('N-4/N-7 installBundle：plugin deferred 标记 + 本地已存在技能跳过网络', async () => {
    const b = mkdtempSync(join(tmpdir(), 'wx-imp6-'));
    try {
      const bd = join(b, 'data'); mkdirSync(bd, { recursive: true });
      mkSkill(bd, 'acme-skill');
      let calls = 0;
      const counting: MarketDeps = {
        safety: async () => ({ ok: true }),
        fetchImpl: async (input: string | URL | Request) => {
          calls += 1;
          const url = String(input);
          if (url.includes('/latest')) return new Response(JSON.stringify({ version: '1.0.0', dist: { tarball: `${url}/x.tgz` } }), { status: 200, headers: { 'content-type': 'application/json' } });
          return new Response(JSON.stringify({ objects: [] }), { status: 200 });
        },
      };
      const m: BundleManifest = { name: 'frontend', version: '1.0.0', description: 'x', skills: ['npm:acme-skill'], mcps: [], plugins: ['npm:any-plugin'] };
      const reports = await installBundle(m, bd, b, counting);
      const skill = reports.find(r => r.item.includes('acme-skill'))!;
      expect(skill.ok).toBe(true);
      expect(skill.message).toContain('已存在');
      expect(calls).toBe(0); // 本地副本跳过——零网络
      const plugin = reports.find(r => r.item.includes('plugin'))!;
      expect(plugin.ok).toBe(true);
      expect(plugin.deferred).toBe(true);
    } finally { rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  it('N-5 useBundle：全量安装（skills 透传证明——本地已存在走跳过，仅 MCP 走网络一次）', async () => {
    const b = mkdtempSync(join(tmpdir(), 'wx-imp7-'));
    try {
      const bd = join(b, 'data'); mkdirSync(bd, { recursive: true });
      const proj = join(b, 'proj'); mkdirSync(proj, { recursive: true });
      mkSkill(bd, 'acme-skill');
      let calls = 0;
      const counting: MarketDeps = {
        safety: async () => ({ ok: true }),
        fetchImpl: async (input: string | URL | Request) => {
          calls += 1;
          return new Response(JSON.stringify({ version: '1.0.0', dist: { tarball: `${String(input)}/x.tgz` } }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      };
      const m: BundleManifest = { name: 'frontend', version: '1.0.0', description: 'x', skills: ['npm:acme-skill'], mcps: ['npm:mcp-fs'], plugins: [], config: { settings: { vimMode: true } } };
      const u = await useBundle(m, bd, proj, counting);
      expect(u.ok).toBe(true);
      expect(calls).toBe(1); // 仅 MCP；技能本地已存在跳过 ⇒ 证明 skills 已透传给 installBundle
      expect(u.message).toContain('✅');
      const projCfg = JSON.parse(readFileSync(join(proj, '.wxnodus', 'config.json'), 'utf8'));
      expect(projCfg.settings.vimMode).toBe(true);
      expect(existsSync(join(proj, '.mcp.json'))).toBe(true);
    } finally { rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  it('N-3 exportBundle：重复导出覆盖旧 tgz 不抛异常', () => {
    const b = mkdtempSync(join(tmpdir(), 'wx-imp8-'));
    try {
      const bd = join(b, 'data'); mkdirSync(bd, { recursive: true });
      createBundle(bd, 'frontend', 'x');
      const e1 = exportBundle(bd, 'frontend', b);
      expect(e1.ok).toBe(true);
      const e2 = exportBundle(bd, 'frontend', b);
      expect(e2.ok).toBe(true);
      expect(existsSync(e2.path!)).toBe(true);
    } finally { rmSync(b, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });
});
