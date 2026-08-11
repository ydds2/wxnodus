import { Text, useInput } from '@wxnodus/ink'

import { Keycap } from './themed.js'
import type { Theme } from '../theme.js'

export function useOverlayKeys({ disabled = false, onBack, onClose }: OverlayKeysOptions) {
  useInput((ch, key) => {
    if (disabled) {
      return
    }

    if (ch === 'q') {
      return onClose()
    }

    if (key.escape) {
      return onBack ? onBack() : onClose()
    }
  })
}

// 键帽 token：按键样式字符（字母/数字/符号组合），不含中文——用于把
// 「↑/↓ select · Enter confirm」解析为「[↑/↓] select · [Enter] confirm」
const KEYCAP_RE = /^[A-Za-z0-9/+,.^↑↓←→\-]+$/

export function OverlayHint({ children, t }: OverlayHintProps) {
  const parts = children.split(' · ')
  return (
    <Text color={t.color.muted} wrap="truncate-end">
      {parts.map((part, i) => {
        const m = part.match(/^(\S+)\s+([\s\S]+)$/)
        const key = m ? m[1]! : part
        const isKeycap = !!m && KEYCAP_RE.test(key) && !/[\u4e00-\u9fa5]/.test(key)
        return (
          <Text key={i}>
            {i > 0 ? ' · ' : ''}
            {isKeycap ? <Keycap k={key} t={t} /> : part}
            {isKeycap ? <Text> {m![2]}</Text> : null}
          </Text>
        )
      })}
    </Text>
  )
}

export const windowOffset = (count: number, selected: number, visible: number) =>
  Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible))

export function windowItems<T>(items: T[], selected: number, visible: number) {
  const offset = windowOffset(items.length, selected, visible)

  return {
    items: items.slice(offset, offset + visible),
    offset
  }
}

interface OverlayHintProps {
  children: string
  t: Theme
}

interface OverlayKeysOptions {
  disabled?: boolean
  onBack?: () => void
  onClose: () => void
}
