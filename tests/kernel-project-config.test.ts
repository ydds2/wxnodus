// tests/kernel-project-config.test.ts — B-05 配置分层（gemini 四层对标：全局 settings ← 项目 .wxnodus/config.json 键级覆盖）
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layeredSettings, projectConfigPath, readProjectConfig, settingsLayers } from '../src/kernel/projectConfig.js'

const dir = mkdtempSync(join(tmpdir(), 'wxn-projcfg-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('项目配置读取', () => {
  it('缺失 → cfg null；合法 JSON → settings；非法 JSON → error 诊断', () => {
    expect(readProjectConfig(dir).cfg).toBeNull()
    const wxn = join(dir, '.wxnodus')
    mkdirSync(wxn, { recursive: true })
    writeFileSync(join(wxn, 'config.json'), JSON.stringify({ settings: { bashOutputCap: 8000 } }), 'utf8')
    const ok = readProjectConfig(dir)
    expect(ok.cfg?.settings?.bashOutputCap).toBe(8000)
    writeFileSync(join(wxn, 'config.json'), '{not-json', 'utf8')
    const bad = readProjectConfig(dir)
    expect(bad.cfg).toBeNull()
    expect(bad.error).toBeTruthy()
    writeFileSync(join(wxn, 'config.json'), JSON.stringify({ settings: { vimMode: true } }), 'utf8')
    expect(readProjectConfig(dir).cfg?.settings?.vimMode).toBe(true) // mtime 缓存失效后读到新值
  })

  it('layeredSettings：无项目文件 → 原引用零拷贝；有项目 → 键级覆盖（不深合并）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wxn-projcfg-e-'))
    const g = { vimMode: false, bashOutputCap: 20000, nested: { a: 1 } }
    expect(layeredSettings(g, empty)).toBe(g) // 引用相同
    const p = mkdtempSync(join(tmpdir(), 'wxn-projcfg-p-'))
    mkdirSync(join(p, '.wxnodus'), { recursive: true })
    writeFileSync(projectConfigPath(p), JSON.stringify({ settings: { vimMode: true, nested: { b: 2 } } }), 'utf8')
    const m = layeredSettings(g, p)!
    expect(m.vimMode).toBe(true) // 项目覆盖
    expect(m.bashOutputCap).toBe(20000) // 全局保留
    expect(m.nested).toEqual({ b: 2 }) // 浅合并：整个键替换
    rmSync(empty, { recursive: true, force: true })
    rmSync(p, { recursive: true, force: true })
  })

  it('settings 非对象（字符串等）→ 忽略项目段', () => {
    const p = mkdtempSync(join(tmpdir(), 'wxn-projcfg-s-'))
    mkdirSync(join(p, '.wxnodus'), { recursive: true })
    writeFileSync(projectConfigPath(p), JSON.stringify({ settings: 'off' }), 'utf8')
    const g = { vimMode: false }
    expect(layeredSettings(g, p)).toBe(g)
    rmSync(p, { recursive: true, force: true })
  })

  it('settingsLayers 诊断三态：未配置/已加载/解析失败', () => {
    expect(settingsLayers(dir).projectLoaded).toBe(true)
    const empty = mkdtempSync(join(tmpdir(), 'wxn-projcfg-d-'))
    expect(settingsLayers(empty).projectLoaded).toBe(false)
    rmSync(empty, { recursive: true, force: true })
  })
})
