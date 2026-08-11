// tests/commands-merge.test.ts — A22 指令融合：别名化 + 子命令注入 + command_search 目录检索
import { describe, expect, it } from 'vitest'

import { createCommandBus } from '../src/app/CommandBus.js'
import { COMMAND_MERGE, searchCommandCatalog, SLASH } from '../src/commands/registry.js'

// ── 分发重定向（旧命令名全兼容）──
describe('指令融合：分发重定向', () => {
  it('/task → /jobs（参数原样透传）', async () => {
    const bus = createCommandBus()
    bus.register('/jobs', (args) => `jobs:${args.join(',')}`)
    bus.register('/task', (args) => `task:${args.join(',')}`) // 旧命令仍注册（兼容回退）

    expect((await bus.execute('/task list')).output).toBe('jobs:list')
    expect((await bus.execute('/task show 3')).output).toBe('jobs:show,3')
  })

  it('/vision → /img', async () => {
    const bus = createCommandBus()
    bus.register('/img', (args) => `img:${args.join(',')}`)
    bus.register('/vision', (args) => `vision:${args.join(',')}`)

    expect((await bus.execute('/vision a.png')).output).toBe('img:a.png')
  })

  it('/hole <查询> → /memory search <查询>（子命令注入）', async () => {
    const bus = createCommandBus()
    bus.register('/memory', (args) => `memory:${args.join(',')}`)
    bus.register('/hole', (args) => `hole:${args.join(',')}`)

    expect((await bus.execute('/hole 检索 待办')).output).toBe('memory:search,检索,待办')
    expect((await bus.execute('/hole')).output).toBe('memory:search')
  })

  it('/rewind → /checkpoint restore（回滚最近快照）', async () => {
    const bus = createCommandBus()
    bus.register('/checkpoint', (args) => `checkpoint:${args.join(',')}`)
    bus.register('/rewind', (args) => `rewind:${args.join(',')}`)

    expect((await bus.execute('/rewind')).output).toBe('checkpoint:restore')
  })

  it('注入目标未注册时回退旧命令本体（别名化绝不破坏旧命令）', async () => {
    const bus = createCommandBus()
    // 只注册 /hole（不注册 /memory）——注入失败应回退 /hole 本体
    bus.register('/hole', (args) => `hole:${args.join(',')}`)

    expect((await bus.execute('/hole 关键词')).output).toBe('hole:关键词')
  })
})

// ── command_search 目录检索（AI 主动调用数据源）──
describe('command_search 目录检索', () => {
  it('按关键词命中命令并带安全等级', () => {
    const hits = searchCommandCatalog('记忆')

    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(h => h.name === '/memory')).toBe(true)
    for (const h of hits) {
      expect(h.level).toMatch(/🟢|🟡|🟠|🔴/)
    }
  })

  it('命中合并命令时标注去向（/task = /jobs）', () => {
    const hits = searchCommandCatalog('任务')
    const task = hits.find(h => h.name === '/task')

    expect(task).toBeDefined()
    expect(task!.merge).toBe('/jobs')
    expect(hits.some(h => h.name === '/jobs')).toBe(true)
  })

  it('无匹配返回空数组', () => {
    expect(searchCommandCatalog('zzzz不存在的词')).toEqual([])
  })

  it('全目录可检索（SLASH 与 COMMAND_MERGE 一致）', () => {
    for (const merge of Object.keys(COMMAND_MERGE)) {
      expect(SLASH).toContain(merge)
    }
  })

  it('空查询返回目录抽样（模型兜底入口）', () => {
    expect(searchCommandCatalog('').length).toBeGreaterThan(0)
  })
})
