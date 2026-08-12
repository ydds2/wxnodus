import { Box, Text, useInput } from '@wxnodus/ink'
import { useState } from 'react'
import { wrapAnsi } from '@wxnodus/ink'

import { isMac } from '../lib/platform.js'
import type { Theme } from '../theme.js'
import type { ApprovalReq, ClarifyReq, ConfirmReq } from '../types.js'

import { TextInput } from './textInput.js'

const APPROVAL_OPTS = ['once', 'session', 'always', 'deny'] as const
// tirith warning present → backend downgrades "always" to session scope, so drop it.
const APPROVAL_OPTS_NO_ALWAYS = APPROVAL_OPTS.filter(o => o !== 'always')
const LABELS = { always: '总是允许', deny: '拒绝', once: '允许一次', session: '本会话允许' } as const
const CMD_PREVIEW_LINES = 10

type ApprovalChoice = 'always' | 'deny' | 'once' | 'session'

type ApprovalKey = {
  downArrow?: boolean
  escape?: boolean
  return?: boolean
  upArrow?: boolean
}

type ApprovalAction = { kind: 'choose'; choice: ApprovalChoice } | { kind: 'move'; delta: -1 | 1 } | { kind: 'noop' }

/**
 * Pure key-dispatch for the approval prompt — exported so the regression
 * matrix (Esc, Ctrl+C-equivalent, number keys, Enter, ↑↓) is testable
 * without mounting React + Ink + a fake stdin.  The component just maps the
 * action onto its own state setters.
 *
 * Esc and number keys both terminate the prompt; Esc maps to deny (parity
 * with the global Ctrl+C handler that already calls cancelOverlayFromCtrlC
 * for approvals).  Numbers 1..opts.length pick the labelled choice.  Enter
 * confirms the current selection.  ↑/↓ moves the selection within bounds.
 */
export function approvalAction(
  ch: string,
  key: ApprovalKey,
  sel: number,
  opts: readonly ApprovalChoice[] = APPROVAL_OPTS
): ApprovalAction {
  if (key.escape) {
    return { kind: 'choose', choice: 'deny' }
  }

  const n = parseInt(ch, 10)

  if (n >= 1 && n <= opts.length) {
    return { kind: 'choose', choice: opts[n - 1]! }
  }

  if (key.return) {
    return { kind: 'choose', choice: opts[sel]! }
  }

  if (key.upArrow && sel > 0) {
    return { kind: 'move', delta: -1 }
  }

  if (key.downArrow && sel < opts.length - 1) {
    return { kind: 'move', delta: 1 }
  }

  return { kind: 'noop' }
}

export function ApprovalPrompt({ cols = 80, onChoice, req, t }: ApprovalPromptProps) {
  const [sel, setSel] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const opts = req.allowPermanent === false ? APPROVAL_OPTS_NO_ALWAYS : APPROVAL_OPTS

  useInput((ch, key) => {
    const action = approvalAction(ch, key, sel, opts)

    if (action.kind === 'choose') {
      onChoice(action.choice)
    } else if (action.kind === 'move') {
      setSel(s => s + action.delta)
    }
  })

  // A2 修复：审批前必须可完整审阅——长命令逐行硬折行（参考同款 wrapAnsi），
  // 超长部分才截断提示（"…+N more lines"）
  const innerWidth = Math.max(20, cols - 6)
  const rawLines = (req.description || req.command).split('\n').flatMap(line => {
    const wrapped = wrapAnsi(line, innerWidth, { hard: true, trim: false })
    return wrapped.split('\n')
  })
  // A24：点击「…+N 行省略」展开全文（审批审阅最需要——不再被截断卡住）
  const shown = expanded ? rawLines : rawLines.slice(0, CMD_PREVIEW_LINES)
  const overflow = rawLines.length - shown.length

  return (
    <Box borderColor={t.color.warn} borderStyle="double" flexDirection="column" paddingX={1}>
      <Text bold color={t.color.warn}>
        ⚠ 需要批准 · {req.tool ?? req.command}
      </Text>
      {req.icon && req.category ? (
        <Text color={t.color.muted}>
          {req.icon} {req.category}
        </Text>
      ) : null}

      <Box flexDirection="column" paddingLeft={1}>
        {shown.map((line, i) => (
          <Text color={t.color.text} key={i} wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}

        {overflow > 0 ? (
          // A24：点击展开全文（审批审阅不被截断卡住；再点收起）
          <Box onClick={() => setExpanded(v => !v)}>
            <Text color={t.color.muted}>
              {expanded ? '▾ 收起（点击折叠）' : `… +${overflow} 行省略（点击展开全文）`}
            </Text>
          </Box>
        ) : null}
      </Box>

      <Text />

      {opts.map((o, i) => (
        // A22 鼠标化：点击选项行 = 选择该许可（与数字键 1-4 同语义）
        <Box key={o} onClick={() => onChoice(o)}>
          <Text bold={sel === i} color={sel === i ? t.color.warn : t.color.muted} inverse={sel === i}>
            {sel === i ? '▸ ' : '  '}
            {i + 1}. {LABELS[o]}
          </Text>
        </Box>
      ))}

      <Text color={t.color.muted}>
        ↑/↓ 选择 · Enter 确认 · 1-{opts.length} 快捷 · 鼠标点击直接选择 · Esc/Ctrl+C 拒绝
      </Text>
    </Box>
  )
}

export function ClarifyPrompt({ cols = 80, onAnswer, onCancel, req, t }: ClarifyPromptProps) {
  const [sel, setSel] = useState(0)
  const [custom, setCustom] = useState('')
  const [typing, setTyping] = useState(false)
  const choices = req.choices ?? []

  const heading = (
    <Text bold>
      <Text color={t.color.accent}>提问</Text>
      <Text color={t.color.text}> {req.question}</Text>
    </Text>
  )

  useInput((ch, key) => {
    if (key.escape) {
      typing && choices.length ? setTyping(false) : onCancel()

      return
    }

    if (typing || !choices.length) {
      return
    }

    if (key.upArrow && sel > 0) {
      setSel(s => s - 1)
    }

    if (key.downArrow && sel < choices.length) {
      setSel(s => s + 1)
    }

    if (key.return) {
      sel === choices.length ? setTyping(true) : choices[sel] && onAnswer(choices[sel]!)
    }

    const n = parseInt(ch)

    if (n >= 1 && n <= choices.length) {
      onAnswer(choices[n - 1]!)
    }
  })

  if (typing || !choices.length) {
    return (
      <Box flexDirection="column">
        {heading}

        <Box>
          <Text color={t.color.label}>{'> '}</Text>
          <TextInput columns={Math.max(20, cols - 6)} onChange={setCustom} onSubmit={onAnswer} value={custom} />
        </Box>

        {/* A24：输入模式提交/返回按钮（此前仅 Enter/Esc） */}
        <Box flexDirection="row" marginTop={1}>
          <Box onClick={() => custom.trim() && onAnswer(custom)}>
            <Text bold color={custom.trim() ? t.color.warn : t.color.muted} inverse={custom.trim().length > 0}>
              {custom.trim() ? '⏎ 提交' : '⏎ 提交（空）'}
            </Text>
          </Box>
          {choices.length ? (
            <>
              <Text>{'   '}</Text>
              <Box onClick={() => setTyping(false)}>
                <Text color={t.color.muted}>Esc 返回选项</Text>
              </Box>
            </>
          ) : null}
        </Box>

        <Text color={t.color.muted}>
          Enter send · Esc {choices.length ? 'back' : 'cancel'} ·{' '}
          {isMac ? 'Cmd+C copy · Cmd+V paste · Ctrl+C cancel' : 'Ctrl+C cancel'}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {heading}

      {[...choices, 'Other (type your answer)'].map((c, i) => (
        // A22 鼠标化：点击选项 = 直接作答；Other 行 = 进入自定义输入
        <Box
          key={i}
          onClick={() => {
            i === choices.length ? setTyping(true) : choices[i] && onAnswer(choices[i]!)
          }}
        >
          <Text bold={sel === i} color={sel === i ? t.color.label : t.color.muted} inverse={sel === i}>
            {sel === i ? '▸ ' : '  '}
            {i + 1}. {c}
          </Text>
        </Box>
      ))}

      <Text color={t.color.muted}>↑/↓ 选择 · Enter 确认 · 1-{choices.length} 快捷 · 鼠标点击作答 · Esc/Ctrl+C 取消</Text>
    </Box>
  )
}

export function ConfirmPrompt({ onCancel, onConfirm, req, t }: ConfirmPromptProps) {
  const [sel, setSel] = useState(0)

  useInput((ch, key) => {
    const lower = ch.toLowerCase()

    if (key.escape || (key.ctrl && lower === 'c') || lower === 'n') {
      return onCancel()
    }

    if (lower === 'y') {
      return onConfirm()
    }

    if (key.upArrow) {
      setSel(0)
    }

    if (key.downArrow) {
      setSel(1)
    }

    if (key.return) {
      sel === 0 ? onCancel() : onConfirm()
    }
  })

  const accent = req.danger ? t.color.error : t.color.warn

  const rows = [
    { color: t.color.text, label: req.cancelLabel ?? 'No' },
    { color: req.danger ? t.color.error : t.color.text, label: req.confirmLabel ?? 'Yes' }
  ]

  return (
    <Box borderColor={accent} borderStyle="double" flexDirection="column" paddingX={1}>
      <Text bold color={accent}>
        {req.danger ? '⚠' : '?'} {req.title}
      </Text>

      {req.detail ? (
        <Box paddingLeft={1}>
          <Text color={t.color.text} wrap="truncate-end">
            {req.detail}
          </Text>
        </Box>
      ) : null}

      <Text />

      {rows.map((row, i) => (
        // A22 鼠标化：点击行 = 确认/取消（0 行取消，1 行确认）
        <Box key={row.label} onClick={() => (i === 0 ? onCancel() : onConfirm())}>
          <Text color={sel === i ? accent : t.color.muted}>{sel === i ? '▸ ' : '  '}</Text>
          <Text color={sel === i ? row.color : t.color.muted}>{row.label}</Text>
        </Box>
      ))}

      <Text color={t.color.muted}>↑/↓ 选择 · Enter 确认 · Y/N 快捷 · 鼠标点击选择 · Esc 取消</Text>
    </Box>
  )
}

interface ApprovalPromptProps {
  cols?: number
  onChoice: (s: string) => void
  req: ApprovalReq
  t: Theme
}

interface ClarifyPromptProps {
  cols?: number
  onAnswer: (s: string) => void
  onCancel: () => void
  req: ClarifyReq
  t: Theme
}

interface ConfirmPromptProps {
  onCancel: () => void
  onConfirm: () => void
  req: ConfirmReq
  t: Theme
}
