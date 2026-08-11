import { Box, Text } from '@wxnodus/ink'
import { useState } from 'react'

import type { Theme } from '../theme.js'

import { TextInput } from './textInput.js'

export function MaskedPrompt({ cols = 80, icon, label, onSubmit, sub, t }: MaskedPromptProps) {
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
            {value.trim().length > 0 ? '⏎ 提交' : '⏎ 提交（尚未输入）'}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

interface MaskedPromptProps {
  cols?: number
  icon: string
  label: string
  onSubmit: (v: string) => void
  sub?: string
  t: Theme
}
