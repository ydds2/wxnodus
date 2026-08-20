// tests/build-generate.test.ts — Spec v2 逐模块生成引擎（2026-08-19 复杂需求构造能力）
// 覆盖：生成输出三重校验（路径/尺寸/数量）纯函数 + mock fetch 端到端逐模块生成
//       + 入口契约缺失诚实失败 + 模块 DAG 拓扑落盘
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateGeneratedFiles, generateProject } from '../src/build/generate.js'
import { validateSpec } from '../src/build/spec.js'
import { topoSort } from '../src/build/plan.js'
import type { Spec } from '../src/build/spec.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wx-gen-')); dirs.push(d); return d }
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } })

describe('validateGeneratedFiles（三重校验纯函数）', () => {
  it('合法文件批通过', () => {
    const r = validateGeneratedFiles([
      { path: 'server/index.js', content: 'require("node:http")' },
      { path: 'server/routes/auth.js', content: 'module.exports = {}' },
    ])
    expect(r.ok).toBe(true)
  })

  it('路径穿越/绝对路径/非法扩展名拒绝', () => {
    expect(validateGeneratedFiles([{ path: '../evil.js', content: 'x' }]).ok).toBe(false)
    expect(validateGeneratedFiles([{ path: 'C:/abs.js', content: 'x' }]).ok).toBe(false)
    expect(validateGeneratedFiles([{ path: 'server/a/../../b.js', content: 'x' }]).ok).toBe(false)
    expect(validateGeneratedFiles([{ path: 'server/NoExt', content: 'x' }]).ok).toBe(false)
    expect(validateGeneratedFiles([{ path: 'server/UPPER.js', content: 'x' }]).ok).toBe(false)
  })

  it('重复路径 / 空数组 / 超数量 / 超尺寸拒绝', () => {
    expect(validateGeneratedFiles([
      { path: 'a.js', content: '1' },
      { path: 'a.js', content: '2' },
    ]).ok).toBe(false)
    expect(validateGeneratedFiles([]).ok).toBe(false)
    expect(validateGeneratedFiles(Array.from({ length: 13 }, (_, i) => ({ path: `f${i}.js`, content: 'x' }))).ok).toBe(false)
    expect(validateGeneratedFiles([{ path: 'big.js', content: 'x'.repeat(70 * 1024) }]).ok).toBe(false)
  })
})

describe('Spec v2 modules 结构校验', () => {
  const base: Spec = { title: '商城', summary: '多模块商城', scaffold: 'generic', acceptance: ['下单成功', '库存扣减', '订单可查'] }

  it('合法分解通过；依赖拓扑排序正确', () => {
    const spec: Spec = { ...base, modules: [
      { name: 'auth', deps: [], desc: '登录注册', files: [{ path: 'server/auth/check.js', desc: '鉴权' }] },
      { name: 'orders', deps: ['auth'], desc: '订单', files: [{ path: 'server/index.js', desc: '入口' }] },
    ] }
    expect(validateSpec(spec).ok).toBe(true)
    expect(topoSort(spec.modules!.map(m => ({ name: m.name, deps: m.deps })))).toEqual(['auth', 'orders'])
  })

  it('自依赖/未知依赖/环/非法路径/超限拒绝', () => {
    expect(validateSpec({ ...base, modules: [{ name: 'a', deps: ['a'], desc: 'x', files: [{ path: 'server/index.js', desc: 'x' }] }] }).ok).toBe(false)
    expect(validateSpec({ ...base, modules: [{ name: 'a', deps: ['ghost'], desc: 'x', files: [{ path: 'server/index.js', desc: 'x' }] }] }).ok).toBe(false)
    expect(validateSpec({ ...base, modules: [
      { name: 'a', deps: ['b'], desc: 'x', files: [{ path: 'server/index.js', desc: 'x' }] },
      { name: 'b', deps: ['a'], desc: 'y', files: [{ path: 'server/b.js', desc: 'y' }] },
    ] }).ok).toBe(false)
    expect(validateSpec({ ...base, modules: [{ name: 'a', deps: [], desc: 'x', files: [{ path: '../evil.js', desc: 'x' }] }] }).ok).toBe(false)
    expect(validateSpec({ ...base, modules: Array.from({ length: 9 }, (_, i) => ({ name: `m${i}`, deps: [], desc: 'x', files: [{ path: `server/m${i}.js`, desc: 'x' }] })) }).ok).toBe(false)
    expect(validateSpec({ ...base, modules: [] }).ok).toBe(false)
  })
})

describe('generateProject — mock fetch 端到端逐模块生成', () => {
  const spec: Spec = {
    title: '多模块服务', summary: '认证 + 订单两个模块', scaffold: 'generic',
    acceptance: ['健康探活通过', '鉴权中间件存在', '订单模块引用鉴权'],
    modules: [
      { name: 'auth', deps: [], desc: '登录鉴权', files: [{ path: 'server/auth/check.js', desc: '鉴权中间件' }] },
      { name: 'orders', deps: ['auth'], desc: '订单与入口', files: [{ path: 'server/index.js', desc: 'HTTP 入口含 /api/health' }] },
    ],
  }
  const plan = { modules: spec.modules!.map(m => ({ name: m.name, deps: m.deps, desc: m.desc })), order: ['auth', 'orders'], milestones: ['M1 auth', 'M2 orders'] }
  const deps = { baseURL: 'https://api.example.com/v1', model: 'test-model', key: 'k' }

  const mockFetchByModule = () => {
    return vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const user = String(body?.messages?.[1]?.content ?? '')
      if (user.includes('本模块：auth')) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [{ path: 'server/auth/check.js', content: '// auth middleware\nmodule.exports = function check(req, res, next) { next(); };\n' }] }) } }] }) }
      }
      if (user.includes('本模块：orders')) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [{ path: 'server/index.js', content: 'const http = require("node:http");\nconst check = require("./auth/check.js");\nconst s = http.createServer((req,res)=>{ res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({ok:true})); });\nconst PORT = process.env.PORT || 4321;\ns.listen(PORT, ()=>console.log("listening on "+s.address().port));\n' }] }) } }] }) }
      }
      return { ok: false, status: 500, json: async () => ({}) }
    }))
  }

  it('拓扑序逐模块生成落盘：文件/plan/healthcheck/README 齐全', async () => {
    mockFetchByModule()
    const dir = tmp()
    const notices: string[] = []
    const r = await generateProject({ spec, plan, projectDir: dir, deps, progress: s => notices.push(s) })
    expect(r.ok).toBe(true)
    expect(r.moduleCount).toBe(2)
    expect(existsSync(join(dir, 'server', 'auth', 'check.js'))).toBe(true)
    expect(existsSync(join(dir, 'server', 'index.js'))).toBe(true)
    expect(existsSync(join(dir, 'healthcheck.js'))).toBe(true)
    expect(readFileSync(join(dir, 'server', 'index.js'), 'utf8')).toContain('./auth/check.js')
    expect(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')).order).toEqual(['auth', 'orders'])
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('auth')
    expect(notices).toEqual(['生成模块 auth（1/2）', '生成模块 orders（2/2）'])
  })

  it('入口契约缺失 → 如实失败（绝不假交付）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ files: [{ path: 'server/lib/util.js', content: 'module.exports = {}' }] }) } }] }) })))
    const dir = tmp()
    const r = await generateProject({ spec, plan, projectDir: dir, deps })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('缺入口')
  })

  it('生成输出 JSON 非法 → 模块失败诚实报错（不落半成品）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) })))
    const dir = tmp()
    const r = await generateProject({ spec, plan, projectDir: dir, deps })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('auth 生成失败')
    expect(existsSync(join(dir, 'server'))).toBe(false)
  })
})
