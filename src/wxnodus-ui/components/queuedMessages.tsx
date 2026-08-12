import { Box, Text } from '@wxnodus/ink'

import { compactPreview } from '../lib/text.js'
import type { Theme } from '../theme.js'

export const QUEUE_WINDOW = 3

export function getQueueWindow(queueLen: number, queueEditIdx: number | null) {
  const start =
    queueEditIdx === null ? 0 : Math.max(0, Math.min(queueEditIdx - 1, Math.max(0, queueLen - QUEUE_WINDOW)))

  const end = Math.min(queueLen, start + QUEUE_WINDOW)

  return { end, showLead: start > 0, showTail: end < queueLen, start }
}

export function QueuedMessages({ cols, onEdit, queueEditIdx, queued, t }: QueuedMessagesProps) {
  if (!queued.length) {
    return null
  }

  const q = getQueueWindow(queued.length, queueEditIdx)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={t.color.muted} dimColor>
        {`queued (${queued.length})${
          queueEditIdx !== null ? ` · editing ${queueEditIdx + 1} · Ctrl+X delete · Esc cancel` : ''
        }`}
      </Text>

      {q.showLead && (
        <Text color={t.color.muted} dimColor>
          {' '}
          …
        </Text>
      )}

      {queued.slice(q.start, q.end).map((item, i) => {
        const idx = q.start + i
        const active = queueEditIdx === idx

        return (
          // A24：点击排队行进入编辑（此前仅 ↑ 循环可进入）
          <Box key={`${idx}-${item.slice(0, 16)}`} onClick={() => onEdit(idx)}>
            <Text color={active ? t.color.accent : t.color.muted} dimColor>
              {active ? '▸' : ' '} {idx + 1}. {compactPreview(item, Math.max(16, cols - 10))}
            </Text>
          </Box>
        )
      })}

      {q.showTail && (
        <Text color={t.color.muted} dimColor>
          {'  '}…and {queued.length - q.end} more
        </Text>
      )}
    </Box>
  )
}

interface QueuedMessagesProps {
  cols: number
  /** A24：点击行进入编辑（composer.editQueued） */
  onEdit: (index: number) => void
  queueEditIdx: number | null
  queued: string[]
  t: Theme
}
