// tests/modpack-command.test.ts — /modpack 整合包命令契约（2026-09-03 · P3b）
// 锁定：registry 三表；dry-run 零副作用；目录/zip 插件安装 + MCP 追加；兼容矩阵拒绝；
// sha256 防篡改；重复跳过；export 生成清单；list 注册表。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandBus } from '../src/app/CommandBus.js'
import { createEventBus } from '../src/kernel/events.js'
import { openDB, closeDB } from '../src/store/db.js'
import { createMemory } from '../src/kernel/memory.js'
import { registerCoreHandlers } from '../src/commands/handlers.js'
import { registerExtHandlers } from '../src/commands/handlersExt.js'
import { SLASH, COMMAND_DESC, COMMAND_CAT } from '../src/commands/registry.js'
import { buildZip } from '../src/application/release/zipArchive.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-modpack-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } dirs.length = 0 })

const makeBus = async (d: string) => {
  const db = openDB(d)
  const bus = createCommandBus()
  const ctx = {
    dataDir: d, cwd: d, db, mem: createMemory(db), bus: createEventBus(d),
    config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
    agent: { getSessionId: () => 'sM', run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
  } as any
  registerCoreHandlers(bus, ctx)
  registerExtHandlers(bus, ctx)
  return { bus, close: () => closeDB(db) }
}

/** 造一个含插件目录 + mcp.json + modpack.json 的整合包目录 */
const seedPack = (d: string, opts: { target?: string; sha?: string; zipPlugin?: boolean } = {}) => {
  const pack = join(d, 'pack')
  const pluginDir = join(pack, 'plugins', 'demo')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }), 'utf8')
  writeFileSync(join(pluginDir, 'index.js'), '// demo', 'utf8')
  if (opts.zipPlugin) {
    const zipBuf = buildZip([
      { path: 'plugin.json', content: Buffer.from(JSON.stringify({ name: 'zipped', version: '2.0.0' })) },
      { path: 'index.js', content: Buffer.from('// zipped') },
    ])
    writeFileSync(join(pack, 'zipped-plugin.zip'), zipBuf)
    rmSync(pluginDir, { recursive: true, force: true })
  }
  writeFileSync(join(pack, 'mcp.json'), JSON.stringify({ mcpServers: { 'git-server': { command: 'npx', args: ['-y', 'git-mcp'] } } }), 'utf8')
  const mods: Array<Record<string, unknown>> = []
  if (opts.zipPlugin) {
    mods.push({ kind: 'plugin', id: 'zipped', zip: 'zipped-plugin.zip', ...(opts.sha ? { sha256: opts.sha } : {}) })
  } else {
    mods.push({ kind: 'plugin', id: 'demo', dir: 'plugins/demo' })
  }
  mods.push({ kind: 'mcp', id: 'git-server', command: 'npx', args: ['-y', 'git-mcp'] })
  writeFileSync(join(pack, 'modpack.json'), JSON.stringify({ name: '测试包', version: '1.0.0', ...(opts.target ? { targetWxnodus: opts.target } : {}), mods }), 'utf8')
  return pack
}

describe('/modpack 整合包', () => {
  it('registry 三表注册', () => {
    expect(SLASH).toContain('/modpack')
    expect(COMMAND_DESC['/modpack']).toContain('整合包')
    expect(COMMAND_CAT['/modpack']).toBe('⬡')
  })

  it('dry-run 零副作用（插件不落位/MCP 不写入/注册表不记）', async () => {
    const d = tmp()
    const pack = seedPack(d)
    const { bus, close } = await makeBus(d)
    const r = (await bus.execute(`/modpack install ${pack} --dry-run`)).output
    expect(r).toContain('dry-run')
    expect(r).toContain('将安装插件 demo')
    expect(r).toContain('将添加 MCP git-server')
    expect(existsSync(join(d, 'plugins', 'demo'))).toBe(false)
    expect(existsSync(join(d, 'mcp.json'))).toBe(false)
    expect((await bus.execute('/modpack list')).output).toContain('未安装任何整合包')
    close()
  })

  it('安装：插件原子落位 + MCP 追加 + 注册表记录 + list 可见', async () => {
    const d = tmp()
    const pack = seedPack(d)
    const { bus, close } = await makeBus(d)
    const r = (await bus.execute(`/modpack install ${pack}`)).output
    expect(r).toContain('安装完成')
    expect(r).toContain('✓ 插件 demo 已安装')
    expect(r).toContain('✓ MCP git-server 已添加')
    expect(existsSync(join(d, 'plugins', 'demo', 'plugin.json'))).toBe(true)
    expect(existsSync(join(d, 'plugins', 'demo', 'index.js'))).toBe(true)
    expect(readFileSync(join(d, 'mcp.json'), 'utf8')).toContain('git-server')
    const list = (await bus.execute('/modpack list')).output
    expect(list).toContain('测试包 v1.0.0')
    expect(list).toContain('2 组件')
    close()
  })

  it('兼容矩阵：targetWxnodus 不匹配 → fail-closed 拒绝（不落任何文件）', async () => {
    const d = tmp()
    const pack = seedPack(d, { target: '>=9.0.0' })
    const { bus, close } = await makeBus(d)
    const r = (await bus.execute(`/modpack install ${pack}`)).output
    expect(r).toContain('不兼容')
    expect(r).toContain('targetWxnodus')
    expect(existsSync(join(d, 'plugins', 'demo'))).toBe(false)
    close()
  })

  it('zip 插件来源安装（buildZip 真实 zip）', async () => {
    const d = tmp()
    const pack = seedPack(d, { zipPlugin: true })
    const { bus, close } = await makeBus(d)
    const r = (await bus.execute(`/modpack install ${pack}`)).output
    expect(r).toContain('✓ 插件 zipped 已安装')
    expect(existsSync(join(d, 'plugins', 'zipped', 'plugin.json'))).toBe(true)
    expect(readFileSync(join(d, 'plugins', 'zipped', 'plugin.json'), 'utf8')).toContain('zipped')
    close()
  })

  it('watch 任务链包：安装到 dataDir/watch/packs/<id>（P4 社区分发）', async () => {
    const d = tmp()
    const pack = join(d, 'pack')
    mkdirSync(join(pack, 'templates'), { recursive: true })
    writeFileSync(join(pack, 'chain.json'), JSON.stringify({ name: 'watch链', minIntervalMs: 1000, triggers: [{ id: 't1', template: 'templates/t.png' }] }), 'utf8')
    writeFileSync(join(pack, 'templates', 't.png'), 'x', 'utf8')
    writeFileSync(join(pack, 'modpack.json'), JSON.stringify({ name: '链包', version: '1.0.0', mods: [{ kind: 'watch', id: 'demo-watch', dir: '.' }] }), 'utf8')
    const { bus, close } = await makeBus(d)
    const r = (await bus.execute(`/modpack install ${pack}`)).output
    expect(r).toContain('✓ 任务链包 demo-watch 已安装')
    expect(r).toContain('/watch chain')
    expect(existsSync(join(d, 'watch', 'packs', 'demo-watch', 'chain.json'))).toBe(true)
    expect(existsSync(join(d, 'watch', 'packs', 'demo-watch', 'templates', 't.png'))).toBe(true)
    close()
  })

  it('sha256 防篡改：不匹配拒绝（绝不带病安装）', async () => {
    const d = tmp()
    const pack = seedPack(d, { zipPlugin: true, sha: '0'.repeat(64) })
    const { bus, close } = await makeBus(d)
    const r = (await bus.execute(`/modpack install ${pack}`)).output
    expect(r).toContain('sha256 校验失败')
    expect(existsSync(join(d, 'plugins', 'zipped'))).toBe(false)
    close()
  })

  it('重复安装：插件已存在诚实跳过；--force 覆盖', async () => {
    const d = tmp()
    const pack = seedPack(d)
    const { bus, close } = await makeBus(d)
    await bus.execute(`/modpack install ${pack}`)
    const again = (await bus.execute(`/modpack install ${pack}`)).output
    expect(again).toContain('已存在（--force 覆盖安装）')
    const forced = (await bus.execute(`/modpack install ${pack} --force`)).output
    expect(forced).toContain('✓ 插件 demo 已安装')
    close()
  })

  it('export：从目录生成 modpack.json（plugins + mcp 全收）', async () => {
    const d = tmp()
    const src = join(d, 'src')
    mkdirSync(join(src, 'plugins', 'demo'), { recursive: true })
    writeFileSync(join(src, 'plugins', 'demo', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }), 'utf8')
    writeFileSync(join(src, 'mcp.json'), JSON.stringify({ mcpServers: { 'g': { command: 'npx' } } }), 'utf8')
    const { bus, close } = await makeBus(d)
    const r = (await bus.execute(`/modpack export ${src}`)).output
    expect(r).toContain('整合包已导出')
    const manifest = JSON.parse(readFileSync(join(src, 'modpack.json'), 'utf8'))
    expect(manifest.mods).toHaveLength(2)
    expect(manifest.targetWxnodus).toContain('>=')
    close()
  })
})
