// tests/kernel-sandbox-failclosed.test.ts — 评估轮（2026-08-18）：本地 bash 沙盒探测失败 fail-open → fail-closed
// 沙盒请求但不可用 → 默认拒绝执行（绝不静默降级裸跑）；settings.sandbox.failOpen=true 为显式逃生门
import { describe, expect, it, vi } from 'vitest'

// mock 必须顶置（hoisted）——bash 工具动态 import osSandbox 走同一模块解析
vi.mock('../src/kernel/osSandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kernel/osSandbox.js')>()
  return {
    ...actual,
    tryOsSandboxLaunch: vi.fn(async (opts: { settings?: Record<string, any> }) => {
      const p = String((opts.settings?.sandbox as { profile?: string } | undefined)?.profile ?? 'off')
      if (p === 'off' || p === '') return { result: null, reason: 'off' as const }
      return {
        result: null,
        reason: 'probe-failed' as const,
        note: 'OS 沙盒不可用（mock 探测失败）——旧行为会按普通方式执行（未沙盒）',
      }
    }),
  }
})

import { classifySandboxOutcome } from '../src/kernel/osSandbox.js'
import { resolveSandboxFailOpen } from '../src/kernel/winSandbox.js'
import { coreTools, type ToolCtx } from '../src/kernel/tools.js'

const ctx = (settings: Record<string, any>): ToolCtx => ({
  dataDir: '.tmp-fc',
  cwd: '.',
  sessionId: 't',
  getSettings: () => settings,
  bus: { emit: () => {}, on: () => {} } as any,
  signal: undefined,
})

describe('沙盒 fail-closed 决策（纯函数）', () => {
  it('resolveSandboxFailOpen：默认 false；对象 true 才真；字符串形式/缺失 → false', () => {
    expect(resolveSandboxFailOpen(undefined)).toBe(false)
    expect(resolveSandboxFailOpen({})).toBe(false)
    expect(resolveSandboxFailOpen({ sandbox: { profile: 'L2' } })).toBe(false)
    expect(resolveSandboxFailOpen({ sandbox: { profile: 'L2', failOpen: true } })).toBe(true)
    expect(resolveSandboxFailOpen({ sandbox: 'L0' })).toBe(false)
  })

  it('classifySandboxOutcome：结果在 → sandboxed；off/无 reason → plain', () => {
    expect(classifySandboxOutcome({ result: { code: 0, outPath: 'a', errPath: 'b', outTotal: 0, errTotal: 0 } }, {}).action).toBe('sandboxed')
    expect(classifySandboxOutcome({ result: null, reason: 'off' }, {}).action).toBe('plain')
    expect(classifySandboxOutcome({ result: null }, {}).action).toBe('plain')
  })

  it('探测失败/平台不支持/启动失败 → 默认 refuse（fail-closed）', () => {
    for (const reason of ['probe-failed', 'not-win32', 'not-posix', 'launch-failed'] as const) {
      expect(classifySandboxOutcome({ result: null, reason }, {}).action).toBe('refuse')
    }
  })

  it('failOpen=true → plain 且标注未沙盒；字符串 settings.sandbox 无 failOpen 位 → refuse', () => {
    const r = classifySandboxOutcome({ result: null, reason: 'probe-failed', note: 'OS 沙盒不可用（x）' }, { sandbox: { profile: 'L2', failOpen: true } })
    expect(r.action).toBe('plain')
    expect(r.note).toContain('failOpen 显式降级')
    expect(classifySandboxOutcome({ result: null, reason: 'probe-failed' }, { sandbox: 'L2' }).action).toBe('refuse')
  })

  it('用户中止透传原文（不套沙盒框架）', () => {
    const r = classifySandboxOutcome({ result: null, reason: 'launch-failed', note: '已中断（用户中止）' }, {})
    expect(r.action).toBe('refuse')
    expect(r.note).toBe('已中断（用户中止）')
  })
})

describe('bash 工具 fail-closed 接线（mock 探测失败）', () => {
  it('沙盒开启但探测失败 → 拒绝执行（fail-closed），错误含逃生门指引', async () => {
    const out = await coreTools()['bash']!.run({ command: 'echo hello' }, ctx({ sandbox: { profile: 'L2' } }))
    expect(out).toContain('fail-closed')
    expect(out).toContain('拒绝执行')
    expect(out).toContain('failOpen')
    expect(out).toContain('OS 沙盒不可用')
  })

  it('failOpen=true → 显式降级普通执行（诚实标注未沙盒）', async () => {
    const out = await coreTools()['bash']!.run({ command: 'echo hello' }, ctx({ sandbox: { profile: 'L2', failOpen: true } }))
    expect(out).not.toContain('fail-closed')
    // 普通路径真实 spawn powershell——Windows 下应回显 hello（非 Windows 平台此测试仍应执行 bash -c）
    expect(out).toContain('hello')
  })

  it('沙盒未开启（profile off）→ 普通路径不受影响', async () => {
    const out = await coreTools()['bash']!.run({ command: 'echo hello' }, ctx({}))
    expect(out).not.toContain('fail-closed')
    expect(out).toContain('hello')
  })
})
