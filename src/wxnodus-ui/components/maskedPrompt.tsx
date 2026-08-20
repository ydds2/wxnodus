// src/wxnodus-ui/components/maskedPrompt.tsx — 掩码输入提示（sudo/secret 密码不回显）
import { Box, Text } from '@wxnodus/ink'
import { useState } from 'react'

import type { Theme } from '../theme.js'

import { TextInput } from './textInput.js'
import { icon as glyph } from '../glyphs.js'

export function MaskedPrompt({ cols = 80, icon, label, onCancel, onSubmit, sub, t }: MaskedPromptProps) {
  const [value, setValue] = useState('')

  return (
    <Box flexDirection="column">
      <Text bold color={t.color.warn}>
        {icon} {label}
      </Text>

      {sub && <Text color={t.color.muted}> {sub}</Text>}

      <Box>
        <Text color={t.color.label}>{'> '}</Text>
        <TextInput columns={Math.max(20, cols - 6)} mask="*" onChange={setValue} onSubmit={onSubmit} value={value} />
      </Box>

      {/* A22 鼠标化：提交按钮——未输入时不可点（防误提交空值），Enter 仍可提交 */}
      <Box marginTop={1}>
        <Box onClick={() => value.trim().length > 0 && onSubmit(value)}>
          <Text
            bold={value.trim().length > 0}
            color={value.trim().length > 0 ? t.color.warn : t.color.muted}
            inverse={value.trim().length > 0}
          >
            {value.trim().length > 0 ? `${glyph('submit')} 提交` : `${glyph('submit')} 提交（尚未输入）`}
          </Text>
        </Box>
        {/* A24：取消按钮（此前仅 Esc 可取消） */}
        {onCancel ? (
          <>
            <Text>{'   '}</Text>
            <Box onClick={onCancel}>
              <Text color={t.color.muted}>Esc 取消</Text>
            </Box>
          </>
        ) : null}
      </Box>
    </Box>
  )
}

interface MaskedPromptProps {
  cols?: number
  icon: string
  label: string
  /** A24：可点击取消按钮（Esc 之外的第二出口） */
  onCancel?: () => void
  onSubmit: (v: string) => void
  sub?: string
  t: Theme
}
