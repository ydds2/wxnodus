import { Box, Text } from '@wxnodus/ink'
import { memo, useEffect, useState } from 'react'

import { countPendingTodos } from '../lib/liveProgress.js'
import { todoGlyph, todoTone } from '../lib/todo.js'
import type { Theme } from '../theme.js'
import type { TodoItem } from '../types.js'

const rowColor = (t: Theme, status: TodoItem['status']) => {
  const tone = todoTone(status)

  return tone === 'active' ? t.color.text : tone === 'body' ? t.color.statusFg : t.color.muted
}

export const TodoPanel = memo(function TodoPanel({
  collapsed,
  defaultCollapsed = false,
  incomplete = false,
  onToggle,
  t,
  todos
}: {
  collapsed?: boolean
  defaultCollapsed?: boolean
  incomplete?: boolean
  onToggle?: () => void
  t: Theme
  todos: TodoItem[]
}) {
  // Fallback local state for archived todos in transcript where there's no
  // external controller. Live TodoPanel passes collapsed+onToggle from the
  // turn store so clicks still work there.
  const [localCollapsed, setLocalCollapsed] = useState(defaultCollapsed)
  const isControlled = typeof collapsed === 'boolean'
  const effectiveCollapsed = isControlled ? collapsed : localCollapsed

  // A20：in_progress 行 [>] 500ms 闪烁（动态效果——任务在跑一眼可见；unref 防测试挂起）
  const hasActive = todos.some(todo => todo.status === 'in_progress')
  const [tick, setTick] = useState(0)
  // A22 鼠标化：行点击选中高亮（再点取消）——纯视觉定位，不改变任务状态
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (!hasActive) {
      return
    }

    const id = setInterval(() => setTick(v => v + 1), 500)
    id.unref?.()

    return () => clearInterval(id)
  }, [hasActive])

  const handleToggle = () => {
    if (onToggle) {
      onToggle()

      return
    }

    if (!isControlled) {
      setLocalCollapsed(v => !v)
    }
  }

  if (!todos.length) {
    return null
  }

  const done = todos.filter(todo => todo.status === 'completed').length
  const pending = countPendingTodos(todos)

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box onClick={handleToggle}>
        <Text color={t.color.muted}>
          <Text color={t.color.accent}>{effectiveCollapsed ? '▸ ' : '▾ '}</Text>
          <Text bold color={t.color.text}>
            Todo
          </Text>{' '}
          <Text color={t.color.statusFg} dim>
            ({done}/{todos.length})
          </Text>
          {incomplete && pending > 0 && (
            <Text color={t.color.muted} dim>
              {' '}
              · incomplete · {pending} still {pending === 1 ? 'pending' : 'pending/in_progress'}
            </Text>
          )}
        </Text>
      </Box>

      {!effectiveCollapsed && (
        <Box flexDirection="column" marginLeft={2}>
          {todos.map(todo => {
            const tone = todoTone(todo.status)
            const color = rowColor(t, todo.status)
            // A20：进行中 glyph 闪烁（[>] ↔ [ ]）
            const glyph =
              todo.status === 'in_progress' && tick % 2 === 1 ? '[ ]' : todoGlyph(todo.status)

            return (
              // A22 鼠标化：点击行选中高亮（再点取消）
              <Box key={todo.id} onClick={() => setSelectedId(prev => (prev === todo.id ? null : todo.id))}>
                <Text
                  backgroundColor={selectedId === todo.id ? t.color.selectionBg : undefined}
                  color={color}
                  dim={tone === 'dim'}
                >
                  <Text color={color}>{glyph} </Text>
                  {todo.content}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
})
