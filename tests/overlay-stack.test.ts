// tests/overlay-stack.test.ts — UI 重设计 P0-2：栈式浮层纯函数契约（LIFO / 互斥组 / Esc 出栈 / 流程重置）
import { describe, expect, it } from 'vitest'
import {
  closeKind,
  findEntry,
  flowReset,
  groupOf,
  popTop,
  pushInto,
  toggleInto,
  topEntry,
  updateKind
} from '../src/wxnodus-ui/runtime/overlayStack.js'
import type { OverlayStackState } from '../src/wxnodus-ui/bridge/interfaces.js'

const empty = (): OverlayStackState => ({ stack: [], inline: {}, agentsInitialHistoryIndex: 0 })

describe('pushInto（入栈 + 互斥组）', () => {
  it('顺序入栈（z 序 = 栈序，栈顶最后入栈者）', () => {
    const s = pushInto(pushInto(empty(), { kind: 'modelPicker' }), { kind: 'pager', pager: { lines: ['x'], offset: 0 } })
    expect(s.stack.map(e => e.kind)).toEqual(['modelPicker', 'pager'])
    expect(topEntry(s)?.kind).toBe('pager')
  })

  it('同 kind 入栈 = 替换（栈内任意 kind 至多 1 个）', () => {
    let s = pushInto(empty(), { kind: 'sessions' })
    s = pushInto(s, { kind: 'pager', pager: { lines: [], offset: 0 } })
    s = pushInto(s, { kind: 'pager', pager: { lines: ['y'], offset: 1 } })
    expect(s.stack).toHaveLength(2)
    expect(findEntry(s, 'pager')?.pager.offset).toBe(1)
  })

  it('panel 互斥组：push 新面板替换旧面板（不再同时开两个右侧面板）', () => {
    let s = pushInto(empty(), { kind: 'modelPicker' })
    s = pushInto(s, { kind: 'configPanel' })
    expect(s.stack.map(e => e.kind)).toEqual(['configPanel'])
  })

  it('picker 互斥组：sessions/dirPicker/histSearch/commandPalette 互斥', () => {
    let s = pushInto(empty(), { kind: 'commandPalette' })
    s = pushInto(s, { kind: 'sessions' })
    s = pushInto(s, { kind: 'dirPicker' })
    expect(s.stack.map(e => e.kind)).toEqual(['dirPicker'])
  })

  it('pager/agents 不在互斥组：可叠加于面板之上', () => {
    let s = pushInto(empty(), { kind: 'skillsHub' })
    s = pushInto(s, { kind: 'agents', initialHistoryIndex: 2 })
    s = pushInto(s, { kind: 'pager', pager: { lines: [], offset: 0 } })
    expect(s.stack.map(e => e.kind)).toEqual(['skillsHub', 'agents', 'pager'])
  })

  it('groupOf 归类正确', () => {
    expect(groupOf('modelPicker')).toBe('panel')
    expect(groupOf('histSearch')).toBe('picker')
    expect(groupOf('pager')).toBeNull()
    expect(groupOf('agents')).toBeNull()
  })
})

describe('popTop / closeKind（Esc 统一出栈）', () => {
  it('popTop 出栈顶；空栈返回原引用（no-op）', () => {
    const s = pushInto(empty(), { kind: 'modelPicker' })
    expect(popTop(s).stack).toEqual([])
    const e = empty()
    expect(popTop(e)).toBe(e)
  })

  it('closeKind 按 kind 关闭（即使不在栈顶）；不存在 → no-op', () => {
    let s = pushInto(empty(), { kind: 'modelPicker' })
    s = pushInto(s, { kind: 'pager', pager: { lines: [], offset: 0 } })
    const closed = closeKind(s, 'modelPicker')
    expect(closed.stack.map(e => e.kind)).toEqual(['pager'])
    expect(closeKind(closed, 'sessions')).toBe(closed)
  })
})

describe('toggleInto / updateKind', () => {
  it('toggleInto：存在 → 关；不存在 → 开（Ctrl+K 面板 toggle 语义）', () => {
    const s = pushInto(empty(), { kind: 'commandPalette' })
    expect(toggleInto(s, { kind: 'commandPalette' }).stack).toEqual([])
    expect(toggleInto(empty(), { kind: 'commandPalette' }).stack.map(e => e.kind)).toEqual(['commandPalette'])
  })

  it('updateKind 函数式更新（pager 内部态）；返回 null → 出栈（末页 Enter 关闭语义）', () => {
    let s = pushInto(empty(), { kind: 'pager', pager: { lines: ['a', 'b'], offset: 0 } })
    s = updateKind(s, 'pager', p => ({ ...p, pager: { ...p.pager, offset: 1 } }))
    expect(findEntry(s, 'pager')?.pager.offset).toBe(1)

    const closed = updateKind(s, 'pager', () => null)
    expect(closed.stack).toEqual([])
  })

  it('updateKind 目标不存在 → 原引用返回', () => {
    const e = empty()
    expect(updateKind(e, 'pager', p => p)).toBe(e)
  })
})

describe('flowReset（流程重置保留用户态）', () => {
  it('保留 agents/modelPicker/pluginsHub/sessions/skillsHub；丢弃 pager；清空 inline', () => {
    let s = pushInto(empty(), { kind: 'modelPicker' })
    s = pushInto(s, { kind: 'pager', pager: { lines: [], offset: 0 } })
    s = { ...s, inline: { approval: { requestId: 'a1' } as any, confirm: { title: 't' } as any } }

    const r = flowReset(s)
    expect(r.stack.map(e => e.kind)).toEqual(['modelPicker'])
    expect(r.inline).toEqual({})
  })
})
