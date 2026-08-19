// src/wxnodus-ui/components/streamingAssistant.tsx — 流式助手消息渲染
import { useAtom as useStore } from '../../app/stores/engine.js'
import { memo } from 'react'

import type { AppLayoutProgressProps } from '../bridge/interfaces.js'
import { toggleTodoCollapsed, useTurnSelector } from '../runtime/flowStore.js'
import { $uiState } from '../runtime/viewStore.js'
import { blockRenders } from '../domain/blockLayout.js'
import { appendToolShelfMessage } from '../lib/liveProgress.js'
import type { ActiveTool, DetailsMode, Msg, SectionVisibility } from '../types.js'

import { MessageLine } from './messageLine.js'
import { Spinner } from './thinking.js'
import { TodoPanel } from './todoPanel.js'
import { Box, Text } from '@wxnodus/ink'

const groupedSegments = (segments: Msg[]): Msg[] =>
  segments.reduce<Msg[]>((acc, msg) => appendToolShelfMessage(acc, msg), [])

interface LiveBlock {
  isStreaming?: boolean
  key: string
  msg: Msg
  tools?: ActiveTool[]
}

export const StreamingAssistant = memo(function StreamingAssistant({
  cols,
  compact,
  detailsMode,
  detailsModeCommandOverride,
  prevMsg,
  progress,
  sections
}: StreamingAssistantProps) {
  const ui = useStore($uiState)
  const streamSegments = useTurnSelector(state => state.streamSegments)
  const streamPendingTools = useTurnSelector(state => state.streamPendingTools)
  const streaming = useTurnSelector(state => state.streaming)
  const activeTools = useTurnSelector(state => state.tools)
  // A24 第三类修复：live 轮次活动流/结果/委派树/思考态真实传入 ToolTrail
  // （此前 outcome/activity/subagents/reasoningActive 只存在于 TurnState，
  //  ToolTrail 的对应面板从未收到数据——死数据接线）
  const turnActivity = useTurnSelector(state => state.activity)
  const turnOutcome = useTurnSelector(state => state.outcome)
  const turnSubagents = useTurnSelector(state => state.subagents)
  const turnReasoningActive = useTurnSelector(state => state.reasoningActive)
  const turnReasoningStreaming = useTurnSelector(state => state.reasoningStreaming)
  const showStreamingArea = Boolean(streaming)

  if (!progress.showProgressArea && !showStreamingArea && !activeTools.length) {
    return null
  }

  // Flatten the live area into one ordered list so each block's leading gap
  // can be derived from the block directly above it — including the boundary
  // back into settled history (prevMsg). Tracking the predecessor rather than
  // the live text is what keeps the streaming block from jumping when it
  // flushes into a settled segment.
  const blocks: LiveBlock[] = groupedSegments(streamSegments).map((msg, i) => ({ key: `seg:${i}`, msg }))

  if (activeTools.length) {
    blocks.push({ key: 'active-tools', msg: { kind: 'trail', role: 'system', text: '' }, tools: activeTools })
  }

  if (showStreamingArea) {
    blocks.push({
      isStreaming: true,
      key: 'streaming',
      msg: { role: 'assistant', text: streaming, ...(streamPendingTools.length && { tools: streamPendingTools }) }
    })
  } else if (streamPendingTools.length) {
    blocks.push({ key: 'pending-tools', msg: { kind: 'trail', role: 'system', text: '', tools: streamPendingTools } })
  }

  const detailsCtx = { commandOverride: detailsModeCommandOverride, detailsMode, sections }
  let prev = prevMsg

  return (
    <>
      {/* A22：动态状态行——busy 时一句话说明正在做什么（agent.stage 实时驱动，随输出变化） */}
      {ui.busy && ui.status && ui.status !== 'running…' && ui.status !== 'ready' ? (
        <Box flexDirection="row" marginBottom={1}>
          <Box flexShrink={0}>
            <Text color={ui.theme.color.accent}>
              <Spinner color={ui.theme.color.accent} variant="think" />{' '}
            </Text>
          </Box>
          <Box flexShrink={1} overflow="hidden">
            <Text color={ui.theme.color.muted} wrap="truncate-end">
              {ui.status}
            </Text>
          </Box>
        </Box>
      ) : null}
      {blocks.map(block => {
        const node = (
          <MessageLine
            activity={turnActivity}
            busy={ui.busy}
            cols={cols}
            compact={compact}
            detailsMode={detailsMode}
            detailsModeCommandOverride={detailsModeCommandOverride}
            isStreaming={block.isStreaming}
            key={block.key}
            msg={block.msg}
            outcome={turnOutcome}
            prev={prev}
            reasoningActive={turnReasoningActive}
            reasoningStreaming={turnReasoningStreaming}
            sections={sections}
            subagents={turnSubagents}
            t={ui.theme}
            {...(block.tools ? { tools: block.tools } : {})}
          />
        )

        // Advance the grouping predecessor only past blocks that actually
        // paint, so a trail hidden by /details stays transparent here too
        // (active tools live in the prop, so fold them into the check).
        const checkMsg = block.tools?.length ? { ...block.msg, tools: block.tools.map(tool => tool.name) } : block.msg

        if (blockRenders(checkMsg, detailsCtx)) {
          prev = block.msg
        }

        return node
      })}
    </>
  )
})

export const LiveTodoPanel = memo(function LiveTodoPanel() {
  const ui = useStore($uiState)
  const todos = useTurnSelector(state => state.todos)
  const collapsed = useTurnSelector(state => state.todoCollapsed)

  return <TodoPanel collapsed={collapsed} onToggle={toggleTodoCollapsed} t={ui.theme} todos={todos} />
})

interface StreamingAssistantProps {
  cols: number
  compact?: boolean
  detailsMode: DetailsMode
  detailsModeCommandOverride: boolean
  prevMsg?: Msg
  progress: AppLayoutProgressProps
  sections?: SectionVisibility
}
