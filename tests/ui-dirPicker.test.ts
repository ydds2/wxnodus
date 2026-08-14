// tests/ui-dirPicker.test.ts — A24 目录选择器：路径纯函数 + dir.list/cwd.set RPC
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandBus } from '../src/app/CommandBus.js'
import { createTuiPresentationAdapter } from '../src/presentation/tui/tuiPresentationAdapter.js'
import { createEventBus } from '../src/kernel/events.js'
import { createMemory } from '../src/kernel/memory.js'
import { openDB, closeDB } from '../src/store/db.js'
import { basenameOf, joinPath, parentOf } from '../src/wxnodus-ui/components/dirPicker.js'
import { GatewayClient } from '../src/wxnodus-ui/wxGateway.js'

let dir: string
let db: ReturnType<typeof openDB>
const origCwd = process.cwd()

describe('路径纯函数（parentOf/joinPath/basenameOf）', () => {
  it('POSIX 路径', () => {
    expect(parentOf('/a/b/c')).toBe('/a/b')
    expect(parentOf('/a/b')).toBe('/a')
    expect(parentOf('/a')).toBeNull() // POSIX 根不能上
    expect(joinPath('/a/b', 'c')).toBe('/a/b/c')
    expect(basenameOf('/a/b/c')).toBe('c')
  })

  it('Windows 路径（盘符根/UNC 安全）', () => {
    expect(parentOf('C:\\Users\\me\\proj')).toBe('C:\\Users\\me')
    expect(parentOf('C:\\Users\\me')).toBe('C:\\Users')
    expect(parentOf('C:\\Users')).toBe('C:\\') // 盘符根
    expect(parentOf('C:\\')).toBeNull()
    expect(joinPath('C:\\proj', 'src')).toBe('C:\\proj/src')
    expect(basenameOf('C:\\a\\b')).toBe('b')
  })

  it('尾斜杠容错', () => {
    expect(parentOf('/a/b/')).toBe('/a')
    expect(basenameOf('/a/b/')).toBe('b')
  })
})

describe('dir.list RPC（真实目录浏览）', () => {
  let gw: GatewayClient

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wx-dir-'))
    db = openDB(dir)
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'file.txt'), 'x', 'utf8')
    const bus = createEventBus(dir)
    const agent = {
      run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
      abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, steer: () => true,
      setCwd: () => {},
    }
    gw = new GatewayClient({
      dataDir: dir, cwd: origCwd, db, mem: createMemory(db), config: { get: () => ({}) }, bus,
      settings: { model: 'mock' }, commandBus: createCommandBus(), adapter: createTuiPresentationAdapter({ db, agent: agent as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)
  })

  afterEach(() => {
    closeDB(db)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows WAL 延迟解锁 */ }
  })

  it('列出子目录与文件（isDir 标记 + 目录优先排序）', async () => {
    const r = (await gw.request<any>('dir.list', { path: dir })) as any

    expect(r.ok).toBe(true)
    expect(r.path).toBe(dir)
    const sub = r.entries.find((e: any) => e.name === 'sub')
    const file = r.entries.find((e: any) => e.name === 'file.txt')
    expect(sub?.isDir).toBe(true)
    expect(file?.isDir).toBe(false)
    // 目录排在文件前
    expect(r.entries[0]!.isDir).toBe(true)
  })

  it('非目录路径 → ok:false（不崩溃）', async () => {
    const r = (await gw.request<any>('dir.list', { path: join(dir, 'file.txt') })) as any
    expect(r.ok).toBe(false)
  })
})

describe('cwd.set RPC（运行时切换工作目录）', () => {
  it('切换成功：kernel.cwd 更新 + agent.setCwd 被调用 + 重发 session.info', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wx-cwdset-'))
    db = openDB(dir)
    const target = join(dir, 'target')
    mkdirSync(target, { recursive: true })
    const bus = createEventBus(dir)
    const setCwdCalls: string[] = []
    const agent = {
      run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
      abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, steer: () => true,
      setCwd: (p: string) => setCwdCalls.push(p),
    }
    const kernel: any = {
      dataDir: dir, cwd: origCwd, db, mem: createMemory(db), config: { get: () => ({}) }, bus,
      settings: { model: 'mock' }, commandBus: createCommandBus(), adapter: createTuiPresentationAdapter({ db, agent: agent as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    }
    const gw = new GatewayClient(kernel)
    const events: any[] = []
    gw.on('event', e => events.push(e))
    gw.drain() // 订阅开启：session.info/notification 直发

    try {
      const r = (await gw.request<any>('cwd.set', { path: target })) as any
      expect(r.ok).toBe(true)
      expect(r.cwd).toBe(target)
      expect(kernel.cwd).toBe(target)
      expect(setCwdCalls).toEqual([target])
      expect(events.some(e => e.type === 'session.info')).toBe(true)
      expect(events.some(e => e.type === 'notification.show' && e.payload?.text.includes('已切换工作目录'))).toBe(true)
    } finally {
      process.chdir(origCwd)
      closeDB(db)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  })

  it('路径不是目录 → ok:false（不切换）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wx-cwdfail-'))
    db = openDB(dir)
    writeFileSync(join(dir, 'f.txt'), 'x', 'utf8')
    const bus = createEventBus(dir)
    const agent = {
      run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
      abort() {}, setMode() {}, getMode: () => 'smart', setSessionId() {}, steer: () => true,
      setCwd: () => {},
    }
    const gw = new GatewayClient({
      dataDir: dir, cwd: origCwd, db, mem: createMemory(db), config: { get: () => ({}) }, bus,
      settings: { model: 'mock' }, commandBus: createCommandBus(), adapter: createTuiPresentationAdapter({ db, agent: agent as never }),
      applyModel() {}, setMode() {}, setTheme() {}, setThinking() {}, requestExit() {},
    } as any)

    const r = (await gw.request<any>('cwd.set', { path: join(dir, 'f.txt') })) as any
    expect(r.ok).toBe(false)
    closeDB(db)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
})
