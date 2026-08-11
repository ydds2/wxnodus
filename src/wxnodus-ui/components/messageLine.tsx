import { Ansi, Box, NoSelect, Text } from '@wxnodus/ink'
import { memo, useState, type ReactNode } from 'react'

import { TERMUX_TUI_MODE } from '../config/env.js'
import { LONG_MSG } from '../config/limits.js'
import { hasLeadGap } from '../domain/blockLayout.js'
import { sectionMode } from '../domain/details.js'
import { userDisplay } from '../domain/messages.js'
import { ROLE } from '../domain/roles.js'
import { transcriptBodyWidth, transcriptGutterWidth } from '../lib/inputMetrics.js'
import {
  boundedLiveRenderText,
  compactPreview,
  hasAnsi,
  isPasteBackedText,
  sanitizeAnsiForRender,
  stripAnsi
} from '../lib/text.js'
import type { Theme } from '../theme.js'
import type { ActiveTool, DetailsMode, Msg, SectionVisibility } from '../types.js'

import { Md } from './markdown.js'
import { StreamingMd } from './streamingMarkdown.js'
import { ToolTrail } from './thinking.js'
import { TodoPanel } from './todoPanel.js'

// Collapse threshold for long system messages (system prompt etc.)
const SYSTEM_COLLAPSE_CHARS = 400

// A8：已发消息中 /skill:名 引用高亮（参考 splitSlashSkillRefs 同款）
const SKILL_REF_RE = /(\/skill:[^\s，。！？,.;]+)/g

function renderSkillRefs(text: string, t: Theme): ReactNode {
  const parts: ReactNode[] = []
  let last = 0

  for (const m of text.matchAll(SKILL_REF_RE)) {
    const i = m.index ?? 0

    if (i > last) {
      parts.push(<Text key={parts.length}>{text.slice(last, i)}</Text>)
    }

    parts.push(
      <Text color={t.color.accent} key={parts.length}>
        {m[1]}
      </Text>
    )
    last = i + m[0].length
  }

  if (last < text.length) {
    parts.push(<Text key={parts.length}>{text.slice(last)}</Text>)
  }

  return parts.length ? parts : text
}

export const MessageLine = memo(function MessageLine({
  cols,
  compact,
  detailsMode = 'collapsed',
  detailsModeCommandOverride = false,
  isStreaming = false,
  msg,
  prev,
  sections,
  t,
  tools = []
}: MessageLineProps) {
  // Per-section overrides win over the global mode, so resolve each section
  // we might consume here once and gate visibility on the *content-bearing*
  // sections only — never on the global mode.  A `trail` message feeds Tool
  // calls + Activity; an assistant message with thinking/tools metadata
  // feeds Thinking + Tool calls.  Gating on every section would let
  // `thinking` (expanded by default) keep an empty wrapper alive when only
  // `tools` is hidden — exactly the empty-Box bug Copilot caught.
  const thinkingMode = sectionMode('thinking', detailsMode, sections, detailsModeCommandOverride)
  const toolsMode = sectionMode('tools', detailsMode, sections, detailsModeCommandOverride)
  const activityMode = sectionMode('activity', detailsMode, sections, detailsModeCommandOverride)
  const thinking = msg.thinking?.trim() ?? ''

  // One blank line above this block iff it opens a new visual group relative
  // to the block directly above it (`prev`) — the flex-grouping rule. Applied
  // intrinsically on each *rendered* element (not via an outer wrapper) so a
  // block that renders nothing — e.g. a tool trail hidden by /details — emits
  // no floating gap. Streaming-safe: the gap is derived from the stable
  // predecessor, never this block's own live content. See domain/blockLayout.
  const leadGap = hasLeadGap(prev, msg)

  // Collapse toggle for long system messages
  const systemIsLong = msg.role === 'system' && msg.text.length > SYSTEM_COLLAPSE_CHARS
  const [systemOpen, setSystemOpen] = useState(false)

  // A12：timeline 事件消息（◈ 会话切换/委派完成等——参考 kind==='event' 同款）
  // 输出状态按情况区分颜色：失败/异常 → 红，完成/成功 → 绿，进行中/切换 → 紫，其余灰
  if (msg.kind === 'event') {
    const evColor = /失败|错误|异常|拒绝|无法|未成功|中断/.test(msg.text)
      ? t.color.error
      : /完成|成功|已保存|已删除|已切换|已恢复|已启动|就绪/.test(msg.text)
        ? t.color.ok
        : /开始|切换|加载|连接|等待|恢复|构建/.test(msg.text)
          ? t.color.accent
          : t.color.muted

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={evColor} wrap="truncate-end">
          {' '}◈ {msg.text}
        </Text>
      </Box>
    )
  }

  if (msg.kind === 'trail' && msg.todos?.length) {
    return (
      <TodoPanel
        defaultCollapsed={msg.todoCollapsedByDefault}
        incomplete={msg.todoIncomplete}
        t={t}
        todos={msg.todos}
      />
    )
  }

  if (msg.kind === 'trail' && (msg.tools?.length || tools.length || thinking)) {
    return thinkingMode !== 'hidden' || toolsMode !== 'hidden' || activityMode !== 'hidden' ? (
      <Box flexDirection="column" marginTop={leadGap ? 1 : 0}>
        <ToolTrail
          commandOverride={detailsModeCommandOverride}
          detailsMode={detailsMode}
          reasoning={thinking}
          reasoningTokens={msg.thinkingTokens}
          sections={sections}
          t={t}
          tools={tools}
          toolTokens={msg.toolTokens}
          trail={msg.tools ?? []}
        />
      </Box>
    ) : null
  }

  // A trail with no reasoning, tools, or todos to show (e.g. the finalDetails
  // segment message.complete appends carrying only a token tally) has nothing
  // to draw — render nothing instead of an empty gutter row. blockRenders()
  // agrees, so it also stays transparent to grouping and never opens a gap.
  if (msg.kind === 'trail') {
    return null
  }

  if (msg.role === 'tool') {
    const maxChars = Math.max(24, cols - 14)
    const stripped = hasAnsi(msg.text) ? stripAnsi(msg.text) : msg.text
    const safeAnsi = hasAnsi(msg.text) ? sanitizeAnsiForRender(msg.text) : msg.text
    const preview = compactPreview(stripped, maxChars) || '(empty tool result)'
    // 工具结果卡片按结果着色：输出含失败信号 → error 边框（一眼定位失败工具）
    const failed = /失败|错误|异常|不存在|无权限|error|failed|exception/i.test(stripped.slice(0, 200))
    const cardColor = failed ? t.color.error : t.color.border

    return (
      <Box alignSelf="flex-start" borderColor={cardColor} borderStyle="round" marginLeft={3} paddingX={1}>
        {hasAnsi(msg.text) ? (
          <Text wrap="truncate-end">
            <Ansi>{safeAnsi}</Ansi>
          </Text>
        ) : (
          <Text color={failed ? t.color.error : t.color.muted} wrap="truncate-end">
            {preview}
          </Text>
        )}
      </Box>
    )
  }

  const { body, glyph, prefix } = ROLE[msg.role](t)
  const gutterWidth = transcriptGutterWidth(msg.role, t.brand.prompt)

  const showDetails =
    (toolsMode !== 'hidden' && Boolean(msg.tools?.length)) || (thinkingMode !== 'hidden' && Boolean(thinking))

  const showResponseSeparator = shouldShowResponseSeparator(msg, showDetails, prev)

  const content = (() => {
    if (msg.kind === 'slash') {
      return <Text color={t.color.muted}>{msg.text}</Text>
    }

    // ── Collapsible long system message (system prompt, AGENTS.md, etc.) ──
    // MUST come before the hasAnsi check — system messages from the backend
    // contain Rich markup escape codes that would otherwise hit <Ansi> full render.
    if (systemIsLong) {
      const firstLine = (msg.text.split('\n')[0] ?? '').trim().slice(0, 120) || '(system message)'

      return (
        <Box flexDirection="column">
          <Box onClick={() => setSystemOpen(v => !v)}>
            <Text color={t.color.accent}>{systemOpen ? '▾ ' : '▸ '}</Text>
            <Text color={t.color.muted}>{firstLine}</Text>
            <Text color={t.color.muted} dimColor>
              {' — '}
              {msg.text.length.toLocaleString()} chars
            </Text>
          </Box>
          {systemOpen && <Ansi>{sanitizeAnsiForRender(msg.text)}</Ansi>}
        </Box>
      )
    }

    if (msg.role !== 'user' && hasAnsi(msg.text)) {
      return <Ansi>{sanitizeAnsiForRender(msg.text)}</Ansi>
    }

    if (msg.role === 'assistant') {
      const bodyWidth = transcriptBodyWidth(cols, msg.role, t.brand.prompt, TERMUX_TUI_MODE)

      return isStreaming ? (
        // Incremental markdown: split at the last stable block boundary so
        // only the in-flight tail re-tokenizes per delta. See
        // streamingMarkdown.tsx for the cost model.
        <StreamingMd cols={bodyWidth} compact={compact} t={t} text={boundedLiveRenderText(msg.text)} />
      ) : (
        <Md cols={bodyWidth} compact={compact} t={t} text={msg.text} />
      )
    }

    if (msg.role === 'user' && msg.text.length > LONG_MSG && isPasteBackedText(msg.text)) {
      const [head, ...rest] = userDisplay(msg.text).split('[long message]')

      return (
        <Text color={body}>
          {head}
          <Text color={t.color.muted} dimColor>
            [long message]
          </Text>
          {rest.join('')}
        </Text>
      )
    }

    // A8：user 消息中的 /skill:名 引用以 accent 高亮（技能直达提示）
    return <Text {...(body ? { color: body } : {})}>{renderSkillRefs(msg.text, t)}</Text>
  })()

  // Diff segments (emitted by pushInlineDiffSegment between narration
  // segments) keep a blank line on both sides so the patch doesn't butt up
  // against the prose around it.
  const isDiffSegment = msg.kind === 'diff'

  return (
    <Box
      flexDirection="column"
      marginBottom={msg.role === 'user' || isDiffSegment ? 1 : 0}
      marginTop={msg.role === 'user' || msg.kind === 'slash' || isDiffSegment || leadGap ? 1 : 0}
    >
      {showDetails && (
        <Box flexDirection="column" marginBottom={1}>
          <ToolTrail
            commandOverride={detailsModeCommandOverride}
            detailsMode={detailsMode}
            reasoning={thinking}
            reasoningTokens={msg.thinkingTokens}
            sections={sections}
            t={t}
            toolTokens={msg.toolTokens}
            trail={msg.tools}
          />
        </Box>
      )}

      {showResponseSeparator && (
        // Response 徽标：accent 背景色块 + 深色粗体字——轮次回复起点一眼可辨
        <Box marginBottom={1}>
          <NoSelect flexShrink={0} fromLeftEdge width={gutterWidth}>
            <Text color={t.color.accent}>└─ </Text>
          </NoSelect>
          <Box backgroundColor={t.color.accent} paddingX={1}>
            <Text color={t.color.statusBg} bold>
              Response
            </Text>
          </Box>
        </Box>
      )}

      <Box>
        <NoSelect flexShrink={0} fromLeftEdge width={gutterWidth}>
          <Text bold={msg.role === 'user'} color={prefix}>
            {glyph}{' '}
          </Text>
        </NoSelect>

        {/* user 消息带底色块：长会话里每轮提问一眼可定位（glyph 保留在块外） */}
        <Box
          width={transcriptBodyWidth(cols, msg.role, t.brand.prompt, TERMUX_TUI_MODE)}
          {...(msg.role === 'user' ? { backgroundColor: t.color.userBg, paddingX: 1 } : {})}
        >
          {content}
        </Box>
      </Box>
    </Box>
  )
})

// 回复起始标记（└─ Response）：
//  1. 回复带思考/工具明细（showDetails）——原有行为
//  2. 回复直接跟在一轮用户提问之后（prev 为 user）——纯文本回复也标记轮次边界，
//     与 user 底色块配合，多轮消息间的起止一目了然
export const shouldShowResponseSeparator = (
  msg: Msg,
  showDetails: boolean,
  prev?: Pick<Msg, 'kind' | 'role'>
): boolean =>
  msg.role === 'assistant' && /\S/.test(msg.text) && (showDetails || prev?.role === 'user')

interface MessageLineProps {
  cols: number
  compact?: boolean
  detailsMode?: DetailsMode
  detailsModeCommandOverride?: boolean
  isStreaming?: boolean
  msg: Msg
  // The block rendered directly above this one. Drives the group-boundary
  // lead gap (see domain/blockLayout.ts::hasLeadGap). Undefined at the top of
  // the transcript or when spacing is irrelevant.
  prev?: Msg
  sections?: SectionVisibility
  t: Theme
  tools?: ActiveTool[]
}
