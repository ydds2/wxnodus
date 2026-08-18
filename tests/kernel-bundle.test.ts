// tests/kernel-bundle.test.ts — 场景整合包（Modpack 对标：清单规整/一键安装/离线导出/场景应用）
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createBundle, editBundle, exportBundle, installBundle, listBundles, loadBundle, useBundle } from '../src/kernel/bundle.js'
import type { MarketDeps } from '../src/kernel/market.js'

const dir = mkdtempSync(join(tmpdir(), 'wxn-bundle-'))
const dataDir = join(dir, 'data')
const cwd = join(dir, 'proj')
beforeAll(() => { mkdirSync(dataDir, { recursive: true }); mkdirSync(cwd, { recursive: true }) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const okDeps: MarketDeps = {
  safety: async () => ({ ok: true }),
  fetchImpl: async (url: string) => {
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
