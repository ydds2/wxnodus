// 临时诊断（勿提交）：hermes-ink 渲染管线判别
import { EventEmitter } from 'events'
import React from 'react'
import { describe, expect, it } from 'vitest'
import Ink from '../packages/hermes-ink/src/ink/ink.js'
import Box from '../packages/hermes-ink/src/ink/components/Box.js'
import Text from '../packages/hermes-ink/src/ink/components/Text.js'

class FakeTty extends EventEmitter {
  chunks: string[] = []
  columns = 40
  rows = 8
  isTTY = true
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    cb?.()
    return true
  }
}

describe('hermes-ink 渲染管线（临时判别）', () => {
  it('Box+Text 直构 Ink → chunks 含文本', async () => {
    const stdout = new FakeTty(); const stdin = new FakeTty(); const stderr = new FakeTty()
    const ink = new Ink({ stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false } as never)
    ink.render(React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Text, null, 'PIPELINE_OK 你好')))
    await new Promise(r => setTimeout(r, 300))
    const joined = stdout.chunks.join('')
    console.log('CHUNKS_LEN', stdout.chunks.length, 'HAS_TEXT', joined.includes('PIPELINE_OK'))
    expect(joined).toContain('PIPELINE_OK')
  }, 8000)
})

// ── 版本矩阵回归（2026-08-29 整屏空白事故：react ^19.2.0 漂到 19.2.8 与
// react-reconciler 0.33 组合下 reconcile work 静默不执行——首帧永不画出）──
// hermes-ink 的渲染管线依赖 react 19.2.7 + react-reconciler 0.33.0 精确配对
// （上游 hermes-agent 验证矩阵）。任何一侧漂移都可能静默破坏渲染——钉死断言。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

describe('hermes-ink 渲染矩阵钉死（react/reconciler 配对）', () => {
  it('react 恒 19.2.7（root 解析）', () => {
    const req = createRequire(import.meta.url)
    const version = JSON.parse(readFileSync(req.resolve('react/package.json'), 'utf8')).version as string
    expect(version).toBe('19.2.7')
  })

  it('hermes-ink 解析的 react-reconciler 恒 0.33.0', () => {
    const req = createRequire(new URL('../packages/hermes-ink/src/ink/ink.tsx', import.meta.url))
    const version = JSON.parse(readFileSync(req.resolve('react-reconciler/package.json'), 'utf8')).version as string
    expect(version).toBe('0.33.0')
  })
})
