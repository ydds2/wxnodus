// tests/workspace-slash.test.ts — P1 工作台：/status /doctor TUI 拦截（RPC 取数 + 压栈工作台 + 失败诚实降级）
import { afterEach, describe, expect, it } from 'vitest'
import { sessionCommands } from '../src/wxnodus-ui/commands/slash/conversation.js'
import { findEntry } from '../src/wxnodus-ui/runtime/overlayStack.js'
import { getOverlayState, resetOverlayState } from '../src/wxnodus-ui/runtime/promptStore.js'

const statusCmd = sessionCommands.find(c => c.name === 'status')
const doctorCmd = sessionCommands.find(c => c.name === 'doctor')

const WORKSPACE_DATA = {
  title: '状态工作台（w 切换体检 · Esc 关闭）',
  sections: [{ label: '模型与目录', rows: [{ k: '模型', v: 'deepseek-v4-pro', tone: 'ok' }] }]
}

const makeCtx = (rpcResult: unknown) => {
  const rpcCalls: unknown[][] = []
  const sysCalls: string[] = []
  return {
    sid: 'sess-test',
    transcript: { sys: (text: string) => void sysCalls.push(text) },
    gateway: {
      rpc: (...args: unknown[]) => {
        rpcCalls.push(args)
        return Promise.resolve(rpcResult)
      }
    },
    guarded: (fn: (r: unknown) => void) => (r: unknown) => fn(r),
    rpcCalls,
    sysCalls
  }
}

afterEach(() => resetOverlayState())

describe('/status /doctor 工作台拦截', () => {
  it('两个命令均存在', () => {
    expect(statusCmd).toBeDefined()
    expect(doctorCmd).toBeDefined()
  })

  it('/status → workspace.status RPC → workspace 压栈（status 种）', async () => {
    const ctx = makeCtx(WORKSPACE_DATA)
    await statusCmd!.run('', ctx as any, 'status')

    expect(ctx.rpcCalls[0]![0]).toBe('workspace.status')
    const ws = findEntry(getOverlayState(), 'workspace')
    expect(ws).not.toBeNull()
    expect(ws!.ws).toBe('status')
    expect(ws!.data.title).toContain('状态工作台')
  })

  it('/doctor → workspace.doctor RPC → workspace 压栈（doctor 种）', async () => {
    const ctx = makeCtx({ title: '体检工作台', sections: [{ label: '体检项（真实检测）', rows: [] }] })
    await doctorCmd!.run('', ctx as any, 'doctor')

    expect(ctx.rpcCalls[0]![0]).toBe('workspace.doctor')
    const ws = findEntry(getOverlayState(), 'workspace')
    expect(ws!.ws).toBe('doctor')
  })

  it('RPC 无 sections → 诚实降级（sys 提示 + 不压栈）', async () => {
    const ctx = makeCtx(null)
    await statusCmd!.run('', ctx as any, 'status')

    expect(findEntry(getOverlayState(), 'workspace')).toBeNull()
    expect(ctx.sysCalls[0]).toContain('工作台数据不可用')
  })
})
