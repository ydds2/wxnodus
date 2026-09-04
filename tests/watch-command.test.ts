// tests/watch-command.test.ts — /watch 常驻屏幕视频流命令契约（2026-09-03 · P0）
// 锁定：registry 三表；start→环缓冲有帧+场景段→OCR 摘要入黑洞记忆；clip 导出 sha256 证据；
// stop 停流；ffmpeg 缺失 → FFMPEG_MISSING 诚实报（绝不冒充视频流）。
// 假 ffmpeg：node 脚本冒充 gdigrab→MJPEG 流（真 JPEG 字节）+ stderr scene_score 元数据。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandBus } from '../src/app/CommandBus.js'
import { createEventBus } from '../src/kernel/events.js'
import { openDB, closeDB } from '../src/store/db.js'
import { createMemory } from '../src/kernel/memory.js'
import { registerCoreHandlers } from '../src/commands/handlers.js'
import { registerExtHandlers } from '../src/commands/handlersExt.js'
import { SLASH, COMMAND_DESC, COMMAND_CAT } from '../src/commands/registry.js'

vi.mock('../src/kernel/computer/ocr.js', () => ({
  ocrWindowsImage: vi.fn(async () => ({ ok: true, text: '测试屏幕文本' })),
  probeWindowsOcr: () => true,
}))

vi.mock('../src/kernel/screenMatch.js', () => ({
  matchTemplate: vi.fn(async () => ({ ok: true, hit: { x: 10, y: 20, score: 0.95, frameW: 640, frameH: 360 } })),
  loadTemplateFile: vi.fn(async () => ({ ok: true, img: { w: 40, h: 30, data: new Uint8Array(1200) } })),
}))

vi.mock('../src/kernel/localVision.js', () => ({
  setLocalVisionCacheDir: vi.fn(),
  describeScreen: vi.fn(async () => ({ ok: true, text: 'VLM 本地描述' })),
  probeLocalVision: () => ({ loaded: true, detail: 'ok' }),
}))

vi.mock('robotjs', () => ({
  getScreenSize: () => ({ width: 1920, height: 1080 }),
  moveMouse: vi.fn(),
  mouseClick: vi.fn(),
  typeString: vi.fn(),
}))

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-watch-')); dirs.push(d); return d }
afterEach(() => {
  delete process.env.WXNODUS_FFMPEG_CMD
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  dirs.length = 0
})

// 1x1 白 JPEG（合法 FFD8…FFD9——cutJpegFrames 帧切分夹具）
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='

const fakeFfmpeg = (d: string): string => {
  const p = join(d, 'fake-ffmpeg.mjs')
  writeFileSync(p, `
import { writeFileSync } from 'node:fs'
const jpg = Buffer.from('${TINY_JPEG_B64}', 'base64')
if (process.argv.some((a) => String(a).startsWith('ddagrab')) && process.env.FAKE_FAIL_DDAGRAB === '1') {
  process.stderr.write('ddagrab unavailable\\n')
  process.exit(1) // 模拟无 Desktop Duplication 支持（Win10 1903 前/无显示器）
}
if (process.argv.includes('pipe:1')) {
  let n = 0
  setInterval(() => {
    try { process.stdout.write(jpg) } catch {}
    n++
    if (n % 10 === 0) process.stderr.write('[Parsed_metadata_1 @ 000] lavfi.scene_score=0.45\\n')
  }, 30) // 常驻流——被 stop() kill 才退出（模拟真实捕捉长驻）
} else {
  const chunks = []
  process.stdin.on('data', (c) => chunks.push(c))
  process.stdin.on('end', () => {
    writeFileSync(process.argv[process.argv.length - 1], Buffer.concat(chunks))
    process.exit(0)
  })
}
`, 'utf8')
  return p
}

const makeBus = async (d: string) => {
  const db = openDB(d)
  const bus = createCommandBus()
  const ctx = {
    dataDir: d, cwd: d, db, mem: createMemory(db), bus: createEventBus(d),
    config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
    agent: { getSessionId: () => 'sW', run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
  } as any
  registerCoreHandlers(bus, ctx)
  registerExtHandlers(bus, ctx)
  return { bus, db, close: () => closeDB(db) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('/watch 常驻屏幕视频流', () => {
  it('registry 三表注册', () => {
    expect(SLASH).toContain('/watch')
    expect(COMMAND_DESC['/watch']).toContain('视频流')
    expect(COMMAND_CAT['/watch']).toBe('❖')
  })

  it('start → 环缓冲有帧 + 场景段 → OCR 摘要入黑洞记忆；stop 停流', async () => {
    const d = tmp()
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    const { bus, close } = await makeBus(d)
    const r = await bus.execute('/watch start --fps 5 --ring 30')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('屏幕视频流已启动')
    await sleep(1500) // 假流 30ms/帧 × 30 帧 + 3 次 scene_score（2s 节流 → ≥1 段）
    const st = (await bus.execute('/watch status')).output
    expect(st).toContain('运行中')
    expect(st).toMatch(/环缓冲 [1-9]\d* 帧/)
    // 段摘要入记忆（OCR 假文本）
    const hole = (await bus.execute('/hole --all 屏幕观察')).output
    expect(hole).toContain('屏幕观察')
    expect(hole).toContain('测试屏幕文本')
    const stop = (await bus.execute('/watch stop')).output
    expect(stop).toContain('已停止')
    close()
  }, 20_000)

  it('clip → 导出回放证据（mp4 文件 + sha256 + 帧数）', async () => {
    const d = tmp()
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    const { bus, close } = await makeBus(d)
    await bus.execute('/watch start --fps 5 --ring 30')
    await sleep(1200)
    const r = await bus.execute('/watch clip 5')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('回放证据已导出')
    const fileM = /文件：(.+)/.exec(r.output ?? '')
    expect(fileM).toBeTruthy()
    const file = fileM![1]!.trim()
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file).length).toBeGreaterThan(0)
    expect(r.output).toMatch(/sha256：[0-9a-f]{64}/)
    await bus.execute('/watch stop')
    close()
  }, 20_000)

  it('ffmpeg 缺失 → FFMPEG_MISSING 诚实报（绝不冒充视频流）', async () => {
    const d = tmp()
    process.env.WXNODUS_FFMPEG_CMD = 'Z:\\nonexistent-ffmpeg.exe'
    const { bus, close } = await makeBus(d)
    const r = await bus.execute('/watch start')
    expect(r.ok).toBe(true) // 命令本身成功执行
    expect(r.output).toContain('ffmpeg 未安装或不在 PATH')
    expect(r.output).toContain('绝不把轮询帧冒充视频流')
    close()
  })

  it('未启动时 stop/clip 诚实指引', async () => {
    const d = tmp()
    const { bus, close } = await makeBus(d)
    expect((await bus.execute('/watch clip 10')).output).toContain('未在捕捉')
    expect((await bus.execute('/watch stop')).output).toContain('未在捕捉')
    close()
  })

  // ── P2.2：捕捉后端（ddagrab Desktop Duplication API ／ gdigrab GDI／ auto 回落）──
  it('backend ddagrab：显式指定 → 启动输出标注 Desktop Duplication', async () => {
    const d = tmp()
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    const { bus, close } = await makeBus(d)
    try {
      const r = (await bus.execute('/watch start --fps 5 --ring 30 --backend ddagrab')).output
      expect(r).toContain('ddagrab')
      expect(r).toContain('Desktop Duplication')
      const st = (await bus.execute('/watch status')).output
      expect(st).toContain('ddagrab')
    } finally {
      try { await bus.execute('/watch stop') } catch { /* 清理 */ }
      close()
    }
  }, 20_000)

  it('backend auto：ddagrab 失败 → 诚实回落 gdigrab（状态如实呈现）', async () => {
    const d = tmp()
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    process.env.FAKE_FAIL_DDAGRAB = '1'
    const { bus, close } = await makeBus(d)
    try {
      const r = (await bus.execute('/watch start --fps 5 --ring 30')).output
      expect(r).toContain('gdigrab')
      const st = (await bus.execute('/watch status')).output
      expect(st).toContain('gdigrab（GDI）')
    } finally {
      try { await bus.execute('/watch stop') } catch { /* 清理 */ }
      delete process.env.FAKE_FAIL_DDAGRAB
      close()
    }
  }, 20_000)

  it('backend ddagrab 显式 + 不可用 → 失败诚实报（不静默换后端）', async () => {
    const d = tmp()
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    process.env.FAKE_FAIL_DDAGRAB = '1'
    const { bus, close } = await makeBus(d)
    try {
      const r = (await bus.execute('/watch start --fps 5 --ring 30 --backend ddagrab')).output
      expect(r).toContain('未产出视频流')
      expect(r).toContain('ddagrab')
    } finally {
      try { await bus.execute('/watch stop') } catch { /* 清理 */ }
      delete process.env.FAKE_FAIL_DDAGRAB
      close()
    }
  }, 20_000)

  // ── P1：MAA 式任务链 ──
  const seedChain = (d: string, action?: Record<string, unknown>, minIntervalMs = 1000) => {
    writeFileSync(join(d, 'tpl.jpg'), 'x', 'utf8')
    writeFileSync(join(d, 'chain.json'), JSON.stringify({
      name: '测试链', minIntervalMs,
      triggers: [{ id: 'btn1', template: 'tpl.jpg', threshold: 0.8, verify: { ocr: '测试' }, ...(action ? { action } : {}) }],
    }), 'utf8')
  }

  it('chain 装载 → 命中记录（黑洞记忆 + trigger 事件 + 观测链不动作）', async () => {
    const d = tmp()
    seedChain(d)
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    const db = openDB(d)
    const bus = createCommandBus()
    const eventBus = createEventBus(d)
    const triggers: Array<Record<string, unknown>> = []
    eventBus.on('system.screen.watch', (e: any) => { const p = e?.payload ?? e; if (p?.kind === 'trigger') triggers.push(p) })
    const ctx = {
      dataDir: d, cwd: d, db, mem: createMemory(db), bus: eventBus,
      config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
      agent: { getSessionId: () => 'sW', run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
    } as any
    registerCoreHandlers(bus, ctx)
    registerExtHandlers(bus, ctx)
    const loaded = (await bus.execute('/watch chain chain.json')).output
    expect(loaded).toContain('屏幕任务链已装载')
    await bus.execute('/watch start --fps 5 --ring 30')
    await sleep(2500) // minIntervalMs=1000 → 至少一轮链匹配
    const hole = (await bus.execute('/hole --all 屏幕任务链命中')).output
    expect(hole).toContain('屏幕任务链命中 btn1')
    expect(hole).toContain('score=0.950')
    expect(triggers.length).toBeGreaterThan(0)
    // 尾部文案（OCR 验证/动作）经直读 DB 断言（/hole 摘要截断）
    const full = (db.prepare(`SELECT content FROM messages WHERE session_id='sW' AND content LIKE '%屏幕任务链命中%'`).all() as Array<{ content: string }>).map(r => r.content).join('\n')
    expect(full).toContain('OCR 验证通过「测试」')
    expect(full).toContain('观测链——不执行动作')
    const st = (await bus.execute('/watch status')).output
    expect(st).toContain('测试链')
    expect(st).toContain('命中')
    await bus.execute('/watch stop')
    closeDB(db)
  }, 20_000)

  it('click 动作 + 审批放行 → robotjs 坐标映射执行；deny → 拒绝不执行', async () => {
    const d = tmp()
    seedChain(d, { kind: 'click' })
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    const robotMod = await import('robotjs') as unknown as Record<string, unknown>
    let robot: { moveMouse: ReturnType<typeof vi.fn>; mouseClick: ReturnType<typeof vi.fn> }
    try { robot = (robotMod.default ?? robotMod) as typeof robot } catch { robot = robotMod as unknown as typeof robot }
    const db = openDB(d)
    const bus = createCommandBus()
    let current: { execute(c: string): Promise<unknown> } | null = null
    const make = (answer: string) => {      const evBus = createEventBus(d)
      const errs: string[] = []
      evBus.on('system.screen.watch', (e: any) => { const p = e?.payload ?? e; if (p?.kind === 'chain-error') errs.push(p.error) })
      return {
        ctx: {
          dataDir: d, cwd: d, db, mem: createMemory(db), bus: evBus,
          config: { get: () => ({}), getKey: () => undefined, setKey: () => {} },
          agent: { getSessionId: () => 'sW', run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
          gateway: { requestApproval: async () => answer },
        } as any,
        errs,
      }
    }
    try {
      // allow 路径
      const busA = createCommandBus()
      current = busA
      const { ctx: ctxA, errs: errsA } = make('allow')
      registerCoreHandlers(busA, ctxA)
      registerExtHandlers(busA, ctxA)
      await busA.execute('/watch chain chain.json')
      await busA.execute('/watch start --fps 5 --ring 30')
      await sleep(2500)
      const contents = () => (db.prepare(`SELECT content FROM messages WHERE session_id='sW' AND content LIKE '%屏幕任务链命中%'`).all() as Array<{ content: string }>).map(r => r.content).join('\n')
      expect(errsA).toEqual([])
      expect(contents()).toContain('动作已执行')
      expect(robot.moveMouse).toHaveBeenCalledWith(30, 60) // 10*1920/640, 20*1080/360
      expect(robot.mouseClick).toHaveBeenCalled()
      await busA.execute('/watch stop')
      // deny 路径（清记忆重来）
      robot.moveMouse.mockClear(); robot.mouseClick.mockClear()
      db.prepare(`DELETE FROM messages WHERE session_id='sW'`).run()
      const busB = createCommandBus()
      const { ctx: ctxB, errs: errsB } = make('deny')
      registerCoreHandlers(busB, ctxB)
      registerExtHandlers(busB, ctxB)
      await busB.execute('/watch chain chain.json')
      await busB.execute('/watch start --fps 5 --ring 30')
      await sleep(2500)
      expect(errsB).toEqual([])
      expect(contents()).toContain('动作被拒绝')
      expect(robot.moveMouse).not.toHaveBeenCalled()
      await busB.execute('/watch stop')
      current = null
    } finally {
      try { if (current) await current.execute('/watch stop') } catch { /* 清理尽力而为 */ }
      closeDB(db)
    }
  }, 30_000)

  it('无审批桥 → fail-closed 仅记录命中；chain off 清除', async () => {
    const d = tmp()
    seedChain(d, { kind: 'type', text: 'x' })
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    const { bus, db, close } = await makeBus(d)
    await bus.execute('/watch chain chain.json')
    await bus.execute('/watch start --fps 5 --ring 30')
    await sleep(2500)
    const full = (db.prepare(`SELECT content FROM messages WHERE session_id='sW' AND content LIKE '%屏幕任务链命中%'`).all() as Array<{ content: string }>).map(r => r.content).join('\n')
    expect(full).toContain('动作待审批：审批桥未装配')
    expect((await bus.execute('/watch chain off')).output).toContain('任务链已清除')
    expect((await bus.execute('/watch status')).output).toContain('未装载')
    await bus.execute('/watch stop')
    close()
  }, 20_000)

  it('任务链格式校验诚实报（空 triggers / 非法 action）', async () => {
    const d = tmp()
    writeFileSync(join(d, 'tpl.jpg'), 'x', 'utf8')
    writeFileSync(join(d, 'bad1.json'), JSON.stringify({ triggers: [] }), 'utf8')
    writeFileSync(join(d, 'bad2.json'), JSON.stringify({ triggers: [{ id: 'a', template: 'tpl.jpg', action: { kind: 'explode' } }] }), 'utf8')
    const { bus, close } = await makeBus(d)
    expect((await bus.execute('/watch chain bad1.json')).output).toContain('格式错误')
    expect((await bus.execute('/watch chain bad2.json')).output).toContain('action.kind 非法')
    expect((await bus.execute('/watch chain missing.json')).output).toContain('装载失败')
    close()
  })

  // ── P2.1：本地视觉档（--tier l2）──
  it('start --tier l2 → 段摘要含 VLM 本地描述；默认 l1 不调用 VLM', async () => {
    const d = tmp()
    process.env.WXNODUS_FFMPEG_CMD = `node ${fakeFfmpeg(d)}`
    const { bus, db, close } = await makeBus(d)
    const r = (await bus.execute('/watch start --fps 5 --ring 30 --tier l2')).output
    expect(r).toContain('l2（OCR + 本地 VLM moondream2）')
    await sleep(1500)
    const full = (db.prepare(`SELECT content FROM messages WHERE session_id='sW' AND content LIKE '%屏幕观察%'`).all() as Array<{ content: string }>).map(x => x.content).join('\n')
    expect(full).toContain('VLM: VLM 本地描述')
    await bus.execute('/watch stop')
    // 默认 l1：VLM 不调用（mock 计数归零后不再增长）
    const { describeScreen } = await import('../src/kernel/localVision.js')
    const before = (describeScreen as ReturnType<typeof vi.fn>).mock.calls.length
    await bus.execute('/watch start --fps 5 --ring 30')
    await sleep(1500)
    expect((describeScreen as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
    await bus.execute('/watch stop')
    close()
  }, 20_000)
})
