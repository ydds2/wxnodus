// tests/help-keys.test.ts — UI 重设计 P0-4：/help keys TUI 本地拦截（注册表生成 pager 总览）+ 内核委托不变
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionCommands } from '../src/wxnodus-ui/commands/slash/conversation.js'
import { findEntry } from '../src/wxnodus-ui/runtime/overlayStack.js'
import { getOverlayState, resetOverlayState } from '../src/wxnodus-ui/runtime/promptStore.js'
import { keymapDocs, SCOPE_LABEL } from '../src/wxnodus-ui/keymap/registry.js'

const helpCmd = sessionCommands.find(c => c.name === 'help')

const makeCtx = (overrides: Record<string, unknown> = {}) => ({
  sid: 'sess-test',
  transcript: { sys: vi.fn() },
  gateway: { rpc: vi.fn(() => Promise.resolve({ ok: true, output: '内核 /help 输出' })) },
  guarded: (fn: (r: unknown) => void) => (r: unknown) => fn(r),
  ...overrides
})

afterEach(() => resetOverlayState())

describe('/help keys（TUI 本地拦截）', () => {
  it('help 命令存在且 keys/keymap 子命令本地生成 pager 总览', () => {
    expect(helpCmd).toBeDefined()
  })

  it('/help keys → pager 内容来自注册表（含全部分组头与动作名）', () => {
    const ctx = makeCtx()
    const result = helpCmd!.run('keys', ctx as any)

    expect(result).toBeUndefined() // 本地处理，不派发内核
    expect(ctx.gateway.rpc).not.toHaveBeenCalled()

    const pager = findEntry(getOverlayState(), 'pager')
    expect(pager).not.toBeNull()
    const text = pager!.pager.lines.join('\n')

    for (const scope of ['global', 'prompt', 'vim', 'pager', 'panel'] as const) {
      expect(text).toContain(SCOPE_LABEL[scope])
    }
    expect(text).toContain('palette.toggle')
    expect(text).toContain('pagerClose')
  })

  it('/help keymap 别名同 keys', () => {
    helpCmd!.run('keymap', makeCtx() as any)
    expect(findEntry(getOverlayState(), 'pager')).not.toBeNull()
  })

  it('其余参数（如 /help model）委托内核命令面——既有行为不变', async () => {
    const ctx = makeCtx()
    const rpcSpy = ctx.gateway.rpc as ReturnType<typeof vi.fn>

    await helpCmd!.run('model', ctx as any)

    expect(rpcSpy).toHaveBeenCalledWith('command.dispatch', { name: 'help', arg: 'model', session_id: 'sess-test' })
    expect(ctx.transcript.sys).toHaveBeenCalledWith('内核 /help 输出')
    expect(findEntry(getOverlayState(), 'pager')).toBeNull()
  })
})

describe('keymapDocs（注册表文档与拦截内容同源）', () => {
  it('Ctrl+P 别名已登记（VS Code 同款命令面板键）', () => {
    const text = keymapDocs().join('\n')
    expect(text).toContain('ctrl+k/ctrl+p')
  })
})
