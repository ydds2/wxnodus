import { describe, expect, it, afterEach } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GatewayProvider } from '../src/wxnodus-ui/bridge/gatewayProvider.js'
import { PromptZone } from '../src/wxnodus-ui/components/appOverlays.js'
import { HelpHint } from '../src/wxnodus-ui/components/helpHint.js'
import { DEFAULT_THEME } from '../src/wxnodus-ui/theme.js'
import { patchOverlayState, resetOverlayState } from '../src/wxnodus-ui/runtime/promptStore.js'
import { HOTKEYS } from '../src/wxnodus-ui/content/hotkeys.js'
import {
  approvalAction,
  APPROVAL_OPTIONS,
  APPROVAL_OPTIONS_NO_ALWAYS
} from '../src/wxnodus-ui/components/prompts.js'

const fakeGateway = {
  request: async () => null
} as any

const promptProps = {
  cols: 80,
  onApprovalChoice: () => {},
  onClarifyAnswer: () => {},
  onSecretSubmit: () => {},
  onSudoSubmit: () => {},
  onFormSubmit: () => {},
  onFormCancel: () => {}
}

const withGateway = (children: React.ReactNode) => (
  <GatewayProvider value={{ gw: fakeGateway, rpc: fakeGateway.request }}>{children}</GatewayProvider>
)

afterEach(() => {
  resetOverlayState()
})

describe('UI help contract', () => {
  it('does not advertise the removed detail pane shortcut', () => {
    const { lastFrame } = render(<HelpHint t={DEFAULT_THEME} />)
    const frame = lastFrame() ?? ''

    expect(frame).not.toContain('Alt+D')
    expect(frame).not.toContain('右侧详情面板')
    expect(frame).not.toContain('双栏')
    expect(HOTKEYS.some(([, description]) => description.includes('右侧') || description.includes('双栏'))).toBe(false)
  })

  it('keeps Ctrl+D as the exit shortcut in the visible help list', () => {
    expect(HOTKEYS).toContainEqual(['Ctrl+D', '退出'])
  })
})

describe('single-column layout contract', () => {
  // 结构合同：正常 UI 永远是单栏。组件级渲染合同见 PromptZone/StatusRule 用例；
  // 此处在源码层锁定禁入结构（与 tests/meta 的源码级合同同风格），防止双栏骨架回归。
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8')
  const layout = read('src/wxnodus-ui/components/appLayout.tsx')
  const chrome = read('src/wxnodus-ui/components/appChrome.tsx')

  it('has no detail pane or pane layout in the main layout', () => {
    expect(layout).not.toContain('DetailPane')
    expect(layout).not.toContain('paneLayout')
  })

  it('has no row wrapper in the main layout (transcript stays full-width; scrollbar geometry lives inside TranscriptPane)', () => {
    // 历史回归根因：row 包住整个 TranscriptPane 时 BrandBar 占满整行，
    // ScrollBox 被挤成右缘 2 列窄条（「双栏」错觉 + 空 transcript 同一根因）。
    // 主列必须纯 column；滚动条几何 row（flexGrow+flexShrink 双属性）在 TranscriptPane 内部。
    const rows = layout.match(/flexDirection="row" flexGrow=\{1\}>/g)
    expect(rows).toBeNull()
  })

  it('does not repeat the background summary as a status-rule segment or click affordance', () => {
    expect(chrome).not.toContain('bgCount')
    expect(chrome).not.toContain('onBgClick')
    expect(chrome).not.toContain('bg: false')
  })
})

describe('ApprovalPrompt action contract', () => {
  it('fails closed on Escape for both permission scopes', () => {
    expect(approvalAction('', { escape: true }, 0, APPROVAL_OPTIONS)).toEqual({ kind: 'choose', choice: 'deny' })
    expect(approvalAction('', { escape: true }, 0, APPROVAL_OPTIONS_NO_ALWAYS)).toEqual({
      kind: 'choose',
      choice: 'deny'
    })
  })

  it('maps number shortcuts without exposing permanent approval when disabled', () => {
    expect(APPROVAL_OPTIONS_NO_ALWAYS).toEqual(['once', 'session', 'deny'])
    expect(approvalAction('1', {}, 0, APPROVAL_OPTIONS_NO_ALWAYS)).toEqual({ kind: 'choose', choice: 'once' })
    expect(approvalAction('2', {}, 0, APPROVAL_OPTIONS_NO_ALWAYS)).toEqual({ kind: 'choose', choice: 'session' })
    expect(approvalAction('3', {}, 0, APPROVAL_OPTIONS_NO_ALWAYS)).toEqual({ kind: 'choose', choice: 'deny' })
    expect(approvalAction('4', {}, 0, APPROVAL_OPTIONS_NO_ALWAYS)).toEqual({ kind: 'noop' })
  })

  it('moves within bounds and Enter chooses the current selection', () => {
    expect(approvalAction('', { upArrow: true }, 0, APPROVAL_OPTIONS)).toEqual({ kind: 'noop' })
    expect(approvalAction('', { downArrow: true }, 0, APPROVAL_OPTIONS)).toEqual({ kind: 'move', delta: 1 })
    expect(approvalAction('', { downArrow: true }, APPROVAL_OPTIONS.length - 1, APPROVAL_OPTIONS)).toEqual({
      kind: 'noop'
    })
    expect(approvalAction('', { return: true }, 2, APPROVAL_OPTIONS)).toEqual({ kind: 'choose', choice: 'always' })
  })
})

describe('PromptZone precedence contract', () => {
  it('renders only approval when every flow prompt is present', () => {
    patchOverlayState({
      approval: { command: 'npm test', description: '需要批准', allowPermanent: false },
      confirm: { title: '确认操作', onConfirm: () => {} },
      clarify: { choices: ['选项'], question: '请选择', requestId: 'clarify-1' },
      sudo: { requestId: 'sudo-1' },
      secret: { envVar: 'TOKEN', prompt: '输入令牌', requestId: 'secret-1' },
      form: { requestId: 'form-1', prompt: '填写表单', fields: [{ name: 'name', kind: 'text' }] }
    })

    const { lastFrame } = render(withGateway(<PromptZone {...promptProps} />))
    const frame = lastFrame() ?? ''

    expect(frame).toContain('需要批准')
    expect(frame).not.toContain('确认操作')
    expect(frame).not.toContain('请选择')
    expect(frame).not.toContain('需要 sudo 密码')
    expect(frame).not.toContain('输入令牌')
    expect(frame).not.toContain('填写表单')
  })

  it('falls through in the documented order after higher-priority prompts clear', () => {
    patchOverlayState({
      confirm: { title: '确认操作', onConfirm: () => {} },
      clarify: { choices: ['选项'], question: '请选择', requestId: 'clarify-1' },
      sudo: { requestId: 'sudo-1' },
      secret: { envVar: 'TOKEN', prompt: '输入令牌', requestId: 'secret-1' },
      form: { requestId: 'form-1', prompt: '填写表单', fields: [{ name: 'name', kind: 'text' }] }
    })

    const { lastFrame, rerender } = render(withGateway(<PromptZone {...promptProps} />))
    expect(lastFrame()).toContain('确认操作')

    patchOverlayState({ confirm: null })
    rerender(withGateway(<PromptZone {...promptProps} />))
    expect(lastFrame()).toContain('请选择')

    patchOverlayState({ clarify: null })
    rerender(withGateway(<PromptZone {...promptProps} />))
    expect(lastFrame()).toContain('需要 sudo 密码')

    patchOverlayState({ sudo: null })
    rerender(withGateway(<PromptZone {...promptProps} />))
    expect(lastFrame()).toContain('输入令牌')

    patchOverlayState({ secret: null })
    rerender(withGateway(<PromptZone {...promptProps} />))
    expect(lastFrame()).toContain('填写表单')
  })
})
