// tests/kernel-plan-mode.test.ts — 计划模式零副作用硬闸（原型 06 · G1 内核保证）：
// plan 模式：工具面为空 + executeTool 拦截（即使模型幻觉出 tool_call 也不执行）
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ModelCall, type ToolCallMsg } from '../src/kernel/agent.js'
import { createPipelineAgent } from './support/createPipelineAgent.js'
import { openDB, closeDB } from '../src/store/db.js'
import { createEventBus } from '../src/kernel/events.js'
import { createMemory } from '../src/kernel/memory.js'

let db: ReturnType<typeof openDB>
let bus: ReturnType<typeof createEventBus>
let mem: ReturnType<typeof createMemory>
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-plan-'))
  db = openDB(dir)
  bus = createEventBus(dir)
  mem = createMemory(db)
})
afterAll(() => {
  try { closeDB(db); } catch { /* 已关 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
})

describe('计划模式（原型 06 · 批准前零副作用）', () => {
  it('零工具面：模型请求不带任何工具（提案回合）', async () => {
    const seen: unknown[] = []
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 'plan-t1',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      mode: 'plan',
      callModel: async (req): Promise<ModelCall | ToolCallMsg> => {
        seen.push(req.tools)
        return { type: 'text', content: '计划：1 盘点 2 设计 3 迁移' }
      },
    })
    const r = await agent.run('重构状态管理')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('计划')
    expect(seen[0]).toEqual([]) // 工具面为空
  })

  it('硬闸：模型幻觉出 tool_call → executeTool 拦截（零执行 + 拦截回填引导提案）', async () => {
    const toolEvents: string[] = []
    bus.on('agent.tool', e => toolEvents.push(`${e.payload.name}:${e.payload.phase}`))
    let calls = 0
    const agent = createPipelineAgent({
      db, bus, mem, sessionId: 'plan-t2',
      config: { settings: { apiKeyEnc: null as any, baseURL: 'https://mock', model: 'mock' } } as any,
      mode: 'plan',
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        calls++;
        return calls === 1
          ? { type: 'tool_call', name: 'fs_write', args: { path: 'x.txt', content: 'y' } } as ToolCallMsg
          : { type: 'text', content: '计划：先写入 x.txt 再验证' } as ModelCall;
      },
    })
    const r = await agent.run('写文件前先给计划')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('计划')
    // 零执行：无 start/complete 事件（拦截发生在事件发射之前）
    expect(toolEvents).toHaveLength(0)
  })
})
