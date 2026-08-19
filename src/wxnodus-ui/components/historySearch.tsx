// src/wxnodus-ui/components/historySearch.tsx — Ctrl+R 历史反向搜索（bash readline 同款）
// 打开后替换 composer 输入区（overlay 阻断输入）；按键语义：
//   任意字符 → 追加 query 实时搜索；Ctrl+R → 更旧匹配（环绕）；Backspace → 删 query；
//   Enter → 接受当前匹配替换输入框；Esc / Ctrl+C → 取消（输入框原值不动）。
import { Box, Text, useInput } from '@wxnodus/ink'
import { topEntry } from '../runtime/overlayStack.js'
import { getOverlayState } from '../runtime/promptStore.js'
import { useState } from 'react'

import type { Theme } from '../theme.js'
import { searchHistoryWrapped } from '../lib/historySearch.js'
import { useInputHistory } from '../hooks/useInputHistory.js'

export function HistorySearch({ onAccept, onCancel, t }: { onAccept: (text: string) => void; onCancel: () => void; t: Theme }) {
  const { historyRef } = useInputHistory()
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState<{ index: number; text: string } | null>(() =>
    searchHistoryWrapped(historyRef.current, '', historyRef.current.length)
  )

  const update = (q: string, before: number) => {
    setQuery(q)
    setMatch(searchHistoryWrapped(historyRef.current, q, before))
  }

  useInput((ch, key) => {
    // P1 收尾：Esc/Ctrl+C 仅当本面板为栈顶时消费（防一次 Esc 弹两层）
    if ((key.escape || (key.ctrl && ch === 'c')) && topEntry(getOverlayState())?.kind !== 'histSearch') {
      return
    }
    if (key.return) {
      if (match) {
        onAccept(match.text)
      }
      return
    }

    if (key.escape || (key.ctrl && ch === 'c')) {
      onCancel()
      return
    }

    if (key.ctrl && ch === 'r') {
      // 再按 Ctrl+R：从当前匹配继续向更旧方向（窗口内无 → 环绕回末尾）
      update(query, match?.index ?? historyRef.current.length)
      return
    }

    if (key.backspace) {
      update(query.slice(0, -1), historyRef.current.length)
      return
    }

    if (ch && ch.length === 1 && !key.ctrl && !key.meta && !key.alt) {
      update(query + ch, historyRef.current.length)
      return
    }
  })

  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
      <Box flexDirection="row">
        <Text color={t.color.accent} bold>⏎ </Text>
        <Text color={t.color.muted}>(reverse-i-search)`</Text>
        <Text color={t.color.label} bold>{query}</Text>
        <Text color={t.color.muted}>': </Text>
        <Text color={match ? t.color.accent : t.color.warn} wrap="truncate-end">
          {match?.text ?? '（无匹配）'}
        </Text>
      </Box>
      <Text color={t.color.muted}>输入继续搜索 · Ctrl+R 更旧匹配 · Enter 接受 · Esc 取消</Text>
    </Box>
  )
}
