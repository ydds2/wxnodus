// tests/ui-background.test.ts — A24 后台活动：background.status RPC + agent.goal 事件映射 + store
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCommandBus } from '../src/app/CommandBus.js'
import { createEventBus } from '../src/kernel/events.js'
import { createMemory } from '../src/kernel/memory.js'
import { openDB, closeDB } from '../src/store/db.js'
import { bgActiveCount, buildBgState, getBgState, patchBgState } from '../src/wxnodus-ui/runtime/backgroundStore.js'
import { GatewayClient } from '../src/wxnodus-ui/wxGateway.js'

let dir: string
let db: ReturnType<typeof openDB>

function makeGateway(extra: Record<string, any> = {}) {
  const bus = createEventBus(dir)
  const agent = {
    run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }),
    abort() {},
    setMode() {},
    getMode: () => 'smart',
    setSessionId() {},
    steer: () => true,
    setCwd() {},
  }
  const kernel = {
    dataDir: dir,
    cwd: process.cwd(),
    db,
    mem: createMemory(db),
    config: { get: () => ({}) },
    bus,
    settings: { model: 'mock' },
    commandBus: createCommandBus(),
    agent,
    applyModel() {},
    setMode() {},
    setTheme() {},
    setThinking() {},
    requestExit() {},
    // A24：后台数据源（stub——真实 TermManager/TaskRunner 形状）
    term: {
      list: () => [
        { id: 't1', shell: 'cmd', cwd: process.cwd(), status: 'running', exitCode: null, startedAt: 1 },
        { id: 't2', shell: 'bash', cwd: process.cwd(), status: 'exited', exitCode: 0, startedAt: 2 },
      ],
    },
    taskRunner: {
      list: () => [
        { id: 'j1', goal: '后台目标', status: 'running', kind: 'shell', created_at: 1, done_at: null, exit_code: null },
        { id: 'j2', goal: '已完成', status: 'success', kind: 'agent', created_at: 2, done_at: 3, exit_code: 0 },
      ],
    },
    ...extra,
  }
  return new GatewayClient(kernel as any)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-bg-'))
  db = openDB(dir)
})

afterEach(() => {
  closeDB(db)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows WAL 延迟解锁 */ }
})

describe('background.status RPC', () => {
  it('返回终端/任务/定时快照（stub term/taskRunner + 真实 cron 表）', async () => {
    // 真实 cron 表插一行（调度器由 cli 维护，gateway 只读查询）
    db.prepare(`INSERT INTO cron_jobs (schedule, action, enabled) VALUES (?, ?, 1)`).run('every 10m', '跑一次体检')
    const gw = makeGateway()
    const r = (await gw.request<any>('background.status')) as any

    expect(r.terms).toHaveLength(2)
    expect(r.terms[0]).toMatchObject({ id: 't1', status: 'running', shell: 'cmd' })
    expect(r.terms[1]).toMatchObject({ id: 't2', status: 'exited', exitCode: 0 })
    expect(r.jobs).toHaveLength(2)
    expect(r.jobs[0]).toMatchObject({ id: 'j1', status: 'running', goal: '后台目标' })
    expect(r.cron).toHaveLength(1)
    expect(r.cron[0]).toMatchObject({ schedule: 'every 10m', enabled: true })
  })

  it('term/taskRunner 未装配时按空列表（不抛错）', async () => {
    const gw = makeGateway({ term: undefined, taskRunner: undefined })
    const r = (await gw.request<any>('background.status')) as any

    expect(r.terms).toEqual([])
    expect(r.jobs).toEqual([])
  })
})

describe('agent.goal 事件映射（gateway）', () => {
  it('发 status.update {kind:goal} + background.goal 事件（激活 eventAdapter 死代码分支）', async () => {
    const bus = createEventBus(dir)
    const gw = makeGateway({ bus })
    const events: any[] = []
    gw.on('event', e => events.push(e))
    gw.start() // attachBus：内核事件 → GatewayEvent 映射
    gw.drain() // 订阅开启：后续事件直发而非缓冲

    bus.emit('agent.goal', { round: 3, maxRounds: 10, done: false, text: '正在推进' })
    bus.emit('agent.goal', { round: 5, maxRounds: 10, done: true, text: '完成' })

    const status = events.filter(e => e.type === 'status.update' && e.payload?.kind === 'goal')
    expect(status).toHaveLength(2)
    expect(status[0]!.payload.text).toContain('goal 第 3/10 轮')
    expect(status[1]!.payload.text).toContain('✓ goal 完成')

    const bgGoal = events.filter(e => e.type === 'background.goal')
    expect(bgGoal[1]!.payload).toMatchObject({ done: true, round: 5, maxRounds: 10 })
  })
})

describe('kernel jobs 事件 → background.jobs 即时推送（A24 第四类修复）', () => {
  it('jobs.created/complete 触发 background.jobs 快照（不等 5s 轮询）', async () => {
    const bus = createEventBus(dir)
    type JobRow = { id: string; goal: string; status: string; kind: string; created_at: number; done_at: number | null; exit_code: number | null }
    let jobs: JobRow[] = [
      { id: 'j1', goal: '跑测试', status: 'running', kind: 'agent', created_at: 1, done_at: null, exit_code: null },
    ]
    const gw = makeGateway({
      bus,
      taskRunner: { list: () => jobs },
    })
    const events: any[] = []
    gw.on('event', e => events.push(e))
    gw.start()
    gw.drain()

    bus.emit('jobs.created', { id: 'j2', kind: 'shell', parent_id: '', goal: '编译' })
    const snap1 = events.filter(e => e.type === 'background.jobs')
    expect(snap1).toHaveLength(1)
    expect(snap1[0]!.payload).toEqual([
      { id: 'j1', goal: '跑测试', status: 'running', kind: 'agent', created_at: 1, done_at: null, exit_code: null },
    ])

    events.length = 0
    jobs = [{ id: 'j1', goal: '跑测试', status: 'complete', kind: 'agent', created_at: 1, done_at: 9, exit_code: 0 }]
    bus.emit('jobs.complete', { id: 'j1', kind: 'agent', status: 'complete', exit_code: 0, parent_id: '', duration_ms: 8 })
    const snap2 = events.filter(e => e.type === 'background.jobs')
    expect(snap2).toHaveLength(1)
    expect(snap2[0]!.payload[0]).toMatchObject({ id: 'j1', status: 'complete', exit_code: 0 })
  })
})

describe('backgroundStore（$bgState）', () => {
  it('patchBgState 合并 + bgActiveCount 统计（运行终端/任务/goal）', () => {
    expect(getBgState()).toEqual(buildBgState())
    patchBgState({
      terms: [{ id: 't1', shell: 'cmd', cwd: '.', status: 'running', exitCode: null, startedAt: 1 }],
      jobs: [
        { id: 'j1', goal: 'a', status: 'running', kind: 'shell', created_at: 1, done_at: null, exit_code: null },
        { id: 'j2', goal: 'b', status: 'success', kind: 'shell', created_at: 2, done_at: 3, exit_code: 0 },
      ],
      goal: { active: true, done: false, round: 2, maxRounds: 10, text: '推进中' },
    })

    const s = getBgState()
    expect(s.terms).toHaveLength(1)
    expect(s.goal?.round).toBe(2)
    expect(bgActiveCount(s)).toBe(3) // 1 终端 + 1 任务 + 1 goal
  })

  it('无活动时 bgActiveCount 为 0', () => {
    patchBgState({ terms: [], jobs: [], goal: null })
    expect(bgActiveCount(getBgState())).toBe(0)
  })
})
