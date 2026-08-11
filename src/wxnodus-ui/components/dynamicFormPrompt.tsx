// src/wxnodus-ui/components/dynamicFormPrompt.tsx — 动态内容表（敏感输入多字段表单）
// 设计：多字段掩码输入——聚焦字段显示掩码 TextInput，↑/↓ 或 Tab 切换字段，
//       每字段 Enter 提交并进入下一字段，最后一个 Enter 提交全部；Esc 取消。
//       值仅经 onSubmit 回调回传（组件状态即清空）——不落盘、不进历史。
import { Box, Text, useInput } from '@wxnodus/ink'
import { useState } from 'react'

import type { Theme } from '../theme.js'

import { TextInput } from './textInput.js'

export interface DynamicFormField {
  name: string
  label?: string
  kind: 'text' | 'password' | 'key'
}

interface DynamicFormPromptProps {
  cols?: number
  fields: DynamicFormField[]
  prompt?: string
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
  t: Theme
}

export function DynamicFormPrompt({ cols = 80, fields, prompt, onSubmit, onCancel, t }: DynamicFormPromptProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [focused, setFocused] = useState(0)
  const width = Math.max(30, cols - 8)

  const setField = (i: number, v: string) => {
    setValues(prev => ({ ...prev, [fields[i]!.name]: v }))
  }

  const advance = () => {
    if (focused + 1 < fields.length) setFocused(focused + 1)
    else onSubmit(values) // 最后一个字段 Enter → 提交全部
  }

  useInput((ch, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow || key.tab && key.shift) {
      setFocused(f => (f > 0 ? f - 1 : 0))
      return
    }
    if (key.downArrow || key.tab) {
      setFocused(f => (f + 1 < fields.length ? f + 1 : f))
      return
    }
    // 其余按键由聚焦字段的 TextInput 处理（ch 输入/Enter 提交）
    void ch
  })

  return (
    <Box flexDirection="column" borderColor={t.color.warn} borderStyle="double" paddingX={1}>
      <Text bold color={t.color.warn}>
        🔐 动态内容表（敏感输入——仅内存，不保存）
      </Text>
      {prompt && <Text color={t.color.muted}> {prompt}</Text>}

      <Box flexDirection="column" paddingLeft={1}>
        {fields.map((f, i) => (
          // A22 鼠标化：点击字段行切换焦点（TextInput 自动聚焦该字段）
          <Box key={f.name} onClick={() => setFocused(i)}>
            <Text bold color={focused === i ? t.color.warn : t.color.muted}>
              {focused === i ? '▸ ' : '  '}
            </Text>
            <Text color={t.color.label}>{f.label || f.name}:</Text>
            {focused === i ? (
              <Box>
                <Text color={t.color.label}>{'> '}</Text>
                <TextInput
                  columns={width}
                  mask="*"
                  onChange={v => setField(i, v)}
                  onSubmit={() => advance()}
                  value={values[f.name] ?? ''}
                />
              </Box>
            ) : (
              <Text color="#666">
                {' '}{values[f.name] ? '•'.repeat(Math.min(String(values[f.name]).length, 24)) : '（空）'}
              </Text>
            )}
          </Box>
        ))}
      </Box>

      {/* A22 鼠标化：提交/取消按钮（提交全部与末字段 Enter 同语义） */}
      <Box flexDirection="row" marginTop={1}>
        <Box onClick={() => onSubmit(values)}>
          <Text bold color={t.color.warn}>
            ⏎ 提交全部
          </Text>
        </Box>
        <Text>{'   '}</Text>
        <Box onClick={onCancel}>
          <Text color={t.color.muted}>Esc 取消</Text>
        </Box>
      </Box>

      <Text color={t.color.muted}>
        字段 {focused + 1}/{fields.length}（{fields[focused]?.label || fields[focused]?.name}）· ↑/↓ 或 Tab 切换 · 鼠标点击字段/按钮 · Enter 提交（末字段=提交全部）· Esc 取消
      </Text>
    </Box>
  )
}
