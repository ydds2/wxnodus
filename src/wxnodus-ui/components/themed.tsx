import { Text } from '@wxnodus/ink'
import { useAtom as useStore } from '../../app/stores/engine.js'
import type { ReactNode } from 'react'

import { $uiState } from '../runtime/viewStore.js'
import type { Theme, ThemeColors } from '../theme.js'

/** 键帽（赛博深空）：`[Enter]` label 色粗体——面板提示行统一用键帽标注快捷键 */
export function Keycap({ k, t }: { k: string; t: Theme }) {
  return (
    <Text color={t.color.label} bold>
      [{k}]
    </Text>
  )
}

export function Fg({ bold, c, children, dim, italic, literal, strikethrough, underline, wrap }: FgProps) {
  const { theme } = useStore($uiState)

  return (
    <Text color={literal ?? (c && theme.color[c])} dimColor={dim} {...{ bold, italic, strikethrough, underline, wrap }}>
      {children}
    </Text>
  )
}

export type ThemeColor = keyof ThemeColors

export interface FgProps {
  bold?: boolean
  c?: ThemeColor
  children?: ReactNode
  dim?: boolean
  italic?: boolean
  literal?: string
  strikethrough?: boolean
  underline?: boolean
  wrap?: 'end' | 'middle' | 'truncate' | 'truncate-end' | 'truncate-middle' | 'truncate-start' | 'wrap' | 'wrap-trim'
}
