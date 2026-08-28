// src/wxnodus-ui/components/messageLine.tsx — 消息行渲染（2026-08-19 全面替换：
// 对标 Claude Code / Codex / Gemini CLI 同族输出格式）
// 规则：用户 = dim「❯ 文本」（无底色块）；助手 = 纯 markdown（无 Response 徽标、
// 无 └─ 标记）；系统/命令输出 = dim 文本；工具调用 = 单行 dim + dim 缩进结果；
// 无边框卡片、无 Todo 面板、无 ✓/✗ 装饰、无时长。
import { Ansi, Box, NoSelect, Text } from '@wxnodus/ink'
import { memo, useState, type ReactNode } from 'react'

import { useAtom as useStore } from '../../app/stores/engine.js'

import { TERMUX_TUI_MODE } from '../config/env.js'
import { LONG_MSG } from '../config/limits.js'
import { hasLeadGap } from '../domain/blockLayout.js'
import { sectionMode } from '../domain/details.js'
import { userDisplay } from '../domain/messages.js'
import { ROLE } from '../domain/roles.js'
import { writeClipboardText } from '../lib/clipboard.js'
import { stripDiffFence } from '../lib/diffHighlight.js'
import { diffBodyOf } from '../lib/diffGutter.js'
import { transcriptBodyWidth, transcriptGutterWidth } from '../lib/inputMetrics.js'
import {
  boundedLiveRenderText,
  compactPreview,
  hasAnsi,
  isPasteBackedText,
  sanitizeAnsiForRender,
  stripAnsi
} from '../lib/text.js'
import {
  $selectedMessage,
  clearSelectedMessage,
  getUiState,
  patchUiState,
  selectMessage,
  showSelectionHint
} from '../runtime/viewStore.js'
import type { Theme } from '../theme.js'
import { getTuiDensity } from '../config/density.js'
import type { ActiveTool, DetailsMode, Msg, Role, SectionVisibility } from '../types.js'

import { Md } from './markdown.js'
import { msgToOutputEvents } from '../output/bridge.js'
import { renderEvent } from '../output/spec.js'
import { BlockListView } from '../output/tui.js'
import { StreamingMd } from './streamingMarkdown.js'
import { PeerToolTrail } from './peerTrail.js'
import { DiffRenderer } from './diffRenderer.js'
import { icon } from '../glyphs.js'

// Collapse threshold for long system messages (system prompt etc.)
const SYSTEM_COLLAPSE_CHARS = 400
// V4 UI 闭环（症状B）：长 assistant 终稿默认折叠阈值——超 1,200 字符（约 30+ 行）
// 折叠为首段 + 计数指示；竞品调研类长回答全量平铺是用户实测投诉（信息淹没问题）
const ASSISTANT_COLLAPSE_CHARS = 1200

// A19：悬停提示文案（onMouseLeave 据此识别并清除，避免误伤选中/复制反馈）
const HOVER_HINT = '单击选中 · 双击复制'

// ── A19：消息行鼠标意图（纯函数——测试直接覆盖，组件闭包只做副作用）──
export type MessageClickIntent =
  | { type: 'clear' }
  | { type: 'none' }
  | { key: string; role: Role; text: string; type: 'select' }

/** 单击意图：空白格→取消；无 key（不可点消息）→无动作；否则选中该消息。 */
export const messageClickIntent = (
  e: { cellIsBlank?: boolean },
  msgKey: string | undefined,
  msg: Msg
): MessageClickIntent => {
  if (e.cellIsBlank) {
    return { type: 'clear' }
  }

  if (!msgKey) {
    return { type: 'none' }
  }

  return { type: 'select', key: msgKey, text: msg.text, role: msg.role }
}

/** 双击意图：count===2 且可点 → 复制整条消息（三击保持 ink 选行高亮）。 */
export const messageMultiClickIntent = (e: { clickCount?: number }, msgKey: string | undefined): boolean =>
  e.clickCount === 2 && !!msgKey

// A8：已发消息中 /skill:名 引用高亮（参考 splitSlashSkillRefs 同款）
const SKILL_REF_RE = /(\/skill:[^\s，。！？,.;]+)/g

// A24：/skill: 引用可点（高亮如链接就必须可点——点击提交执行技能；
// stopImmediatePropagation 阻断消息选中冒泡）
function renderSkillRefs(text: string, t: Theme, onCommand?: (text: string) => void): { nodes: ReactNode[]; hasRefs: boolean } {
  const nodes: ReactNode[] = []
  let last = 0
  let hasRefs = false

  for (const m of text.matchAll(SKILL_REF_RE)) {
    hasRefs = true
    const i = m.index ?? 0

    if (i > last) {
      nodes.push(<Text key={nodes.length}>{text.slice(last, i)}</Text>)
    }

    nodes.push(
      <Box
        key={nodes.length}
        onClick={(e: { stopImmediatePropagation?: () => void }) => {
          e.stopImmediatePropagation?.()
          onCommand?.(m[1]!)
        }}
      >
        <Text color={t.color.accent}>{m[1]}</Text>
      </Box>
    )
    last = i + m[0].length
  }

  if (last < text.length) {
    nodes.push(<Text key={nodes.length}>{text.slice(last)}</Text>)
  }

  return { hasRefs, nodes }
}

export const MessageLine = memo(function MessageLine({
  cols,
  compact,
  detailsMode = 'collapsed',
  detailsModeCommandOverride = false,
  isStreaming = false,
  msg,
  msgKey,
  onCommand,
  outcome = '',
  prev,
  sections,
  t,
  tools = []
}: MessageLineProps) {
  // 工具显示开关（/details tools hidden 仍可隐藏——其余区段随全面替换移除）
  const toolsMode = sectionMode('tools', detailsMode, sections, detailsModeCommandOverride)

  // One blank line above this block iff it opens a new visual group relative
  // to the block directly above it (`prev`) — the flex-grouping rule. Applied
  // intrinsically on each *rendered* element (not via an outer wrapper) so a
  // block that renders nothing — e.g. a tool trail hidden by /details — emits
  // no floating gap.
  const leadGap = hasLeadGap(prev, msg)

  // Collapse toggle for long system messages
  const systemIsLong = msg.role === 'system' && msg.text.length > SYSTEM_COLLAPSE_CHARS
  const [systemOpen, setSystemOpen] = useState(false)
  // V4 UI 闭环（症状B）：长 assistant 终稿折叠（点击展开——与 system 折叠同款交互）
  const assistantIsLong = msg.role === 'assistant' && !isStreaming && msg.text.length > ASSISTANT_COLLAPSE_CHARS
  const [assistantOpen, setAssistantOpen] = useState(false)

  // ── A19：鼠标点选辅助 ────────────────────────────────────────────────
  // 消息行只订阅 $selectedMessage（hint 变化不重渲染全部消息行）。
  const selected = useStore($selectedMessage)
  const isSelected = !!msgKey && selected?.key === msgKey
  const [hovered, setHovered] = useState(false)

  const copyMessageText = async () => {
    const ok = await writeClipboardText(msg.text)
    clearSelectedMessage()

    if (ok) {
      showSelectionHint(`${icon('check')} 已复制 ${msg.text.length} 字符`)
    } else {
      showSelectionHint(`${icon('warn')} 复制失败：无可用剪贴板通道`)
    }
  }

  // 单击：选中该消息（内容区点击同样生效——cellIsBlank 才走取消）。
  // 双击：复制整条消息（onMultiClick 是独立通道，单击 handler 不会重复触发）。
  const handleMessageClick = (e: { cellIsBlank?: boolean }) => {
    const intent = messageClickIntent(e, msgKey, msg)

    if (intent.type === 'clear') {
      clearSelectedMessage()

      return
    }

    if (intent.type === 'select') {
      selectMessage(intent.key, intent.text, intent.role)
      showSelectionHint('已选中 · Ctrl+C 复制 · Esc 取消')
    }
  }

  const handleMessageMultiClick = (e: { clickCount?: number }) => {
    if (messageMultiClickIntent(e, msgKey)) {
      void copyMessageText()
    }
  }

  const handleMessageEnter = () => {
    setHovered(true)

    if (!getUiState().selectedMessage) {
      showSelectionHint('单击选中 · 双击复制')
    }
  }

  const handleMessageLeave = () => {
    setHovered(false)

    if (getUiState().selectionHint === HOVER_HINT) {
      patchUiState({ selectionHint: null })
    }
  }

  // A12：timeline 事件消息（◈ 会话切换/委派完成等）——dim 单行
  if (msg.kind === 'event') {
    // V4 L0-3：走 spec 渲染（形态/着色出自 output/spec.ts 单一事实源；
    // eventType 结构化映射零内容正则——L0-2 已删三段猜测，此版收敛到 renderEvent）
    const events = msgToOutputEvents(msg)
    if (events.length) {
      return (
        <Box flexDirection="column" marginTop={1}>
          <BlockListView blocks={events.flatMap(ev => renderEvent(ev, 'cozy'))} t={t} />
        </Box>
      )
    }
  }

  // 全面替换：Todo 面板不再渲染（对标 Claude Code——清单不占对话流）
  if (msg.kind === 'trail' && msg.todos?.length) {
    return null
  }

  if (msg.kind === 'trail' && (msg.tools?.length || tools.length)) {
    return toolsMode !== 'hidden' ? (
      <Box flexDirection="column" marginTop={leadGap ? 1 : 0}>
        <PeerToolTrail outcome={outcome} t={t} tools={tools} trail={msg.tools ?? []} />
      </Box>
    ) : null
  }

  // finalDetails 轨迹（无工具/清单——推理 + token 摘要）：
  // 推理默认折叠为一行「▸ 推理 (N tokens)」（点击展开 dim 全文，≤4000 字符）；
  // token 摘要 dim 一行——对标 Claude Code 回合尾部用量行
  if (msg.kind === 'trail') {
    // V4 L0-3：trail 走 spec（推理统一 FoldHeader 折叠 + turn-summary 回合尾行
    // 「◦ N 调用 · X tokens · Zs」——形态出自 output/spec.ts，废除本组件内联格式）
    const events = msgToOutputEvents(msg)
    if (!events.length) {
      return null
    }
    return (
      <Box flexDirection="column" marginTop={leadGap ? 1 : 0}>
        <BlockListView
          blocks={events.flatMap(ev => renderEvent(ev, 'cozy'))}
          foldedBodies={events.map(ev =>
            ev.kind === 'reasoning' ? (
              <Text color={t.color.muted} dimColor wrap="truncate-end">
                {boundedLiveRenderText(ev.text, { maxChars: 4000, maxLines: 12 })}
              </Text>
            ) : undefined
          )}
          t={t}
        />
      </Box>
    )
  }

  // trail 三分支（todos 不渲染 / tools 轨迹 / finalDetails 摘要）已覆盖全部
  // trail 消息——此处无需兜底分支

  if (msg.role === 'tool') {
    const stripped = hasAnsi(msg.text) ? stripAnsi(msg.text) : msg.text
    // 工具结果 diff 回显（fs_edit 等结果含 @@ hunk）——行内 +/- 着色，无边框卡片
    const diffTail = diffBodyOf(stripped)
    if (diffTail) {
      const head = stripped.slice(0, stripped.indexOf(diffTail)).trim()
      return (
        <Box flexDirection="column" marginLeft={2}>
          {head ? (
            <Text color={t.color.muted} dimColor>
              {head}
            </Text>
          ) : null}
          <DiffRenderer t={t} body={diffTail} />
        </Box>
      )
    }
    // V4 L0-3：工具结果行走 spec 渲染（⎿ + outcome 结构化着色 + 超阈值统一折叠；
    // 零正则——规范 docs/output-spec-v1.md，形态出自 output/spec.ts 单一事实源）
    const toolEvents = msgToOutputEvents(msg)
    if (toolEvents.length) {
      return (
        <Box marginLeft={2}>
          <BlockListView
            blocks={toolEvents.flatMap(ev => renderEvent(ev, 'cozy'))}
            foldedBodies={toolEvents.map(() => (
              <Text color={t.color.muted} dimColor>{stripped}</Text>
            ))}
            t={t}
          />
        </Box>
      )
    }
    const preview = compactPreview(stripped, Math.max(24, cols - 10)) || '(no output)'
    return (
      <Box marginLeft={2}>
        <Text color={t.color.muted} dimColor wrap="truncate-end">
          {preview}
        </Text>
      </Box>
    )
  }

  const { body, glyph, prefix } = ROLE[msg.role](t)
  const isUser = msg.role === 'user'
  const gutterWidth = transcriptGutterWidth(msg.role, t.brand.prompt)

  const showDetails = toolsMode !== 'hidden' && Boolean(msg.tools?.length)

  const content = (() => {
    if (msg.kind === 'slash') {
      // 命令输出支持 ANSI 彩色（/help 分组面板等 TTY 门控输出）——
      // 纯文本向后兼容；sanitizeAnsiForRender 防注入
      return hasAnsi(msg.text) ? (
        <Ansi>{sanitizeAnsiForRender(msg.text)}</Ansi>
      ) : (
        <Text color={t.color.muted}>{msg.text}</Text>
      )
    }

    // ── Collapsible long system message (system prompt, AGENTS.md, etc.) ──
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

    // ── diff 语法高亮（Aider/Claude Code 同款 +/-/@@ 着色）──
    if (msg.kind === 'diff') {
      const bodyText = stripDiffFence(msg.text)
      if (bodyText) return <DiffRenderer t={t} body={bodyText} />
    }

    if (msg.role === 'assistant') {
      const bodyWidth = transcriptBodyWidth(cols, msg.role, t.brand.prompt, TERMUX_TUI_MODE)

      if (isStreaming) {
        return <StreamingMd cols={bodyWidth} compact={compact} t={t} text={boundedLiveRenderText(msg.text)} />
      }
      if (assistantIsLong) {
        // 折叠态：首段（前 ~500 字符按段落边界截）+ 计数；点击头部展开全文
        const full = msg.text
        const cut = full.slice(0, 500)
        const nl2 = cut.lastIndexOf('\n\n')
        const nl1 = cut.lastIndexOf('\n')
        const head = cut.slice(0, Math.max(nl2, nl1)) || cut
        return (
          <Box flexDirection="column">
            <Md cols={bodyWidth} compact={compact} t={t} text={head} />
            <Box onClick={() => setAssistantOpen(v => !v)}>
              <Text color={t.color.accent}>{assistantOpen ? '▾ ' : '▸ '}</Text>
              <Text color={t.color.muted} dimColor>
                {assistantOpen ? '收起' : `展开全文 — ${full.length.toLocaleString()} 字符 / ${full.split('\n').length} 行`}
              </Text>
            </Box>
            {assistantOpen && <Md cols={bodyWidth} compact={compact} t={t} text={full} />}
          </Box>
        )
      }
      return <Md cols={bodyWidth} compact={compact} t={t} text={msg.text} />
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
    const skill = renderSkillRefs(msg.text, t, onCommand)

    if (skill.hasRefs) {
      return (
        <Box flexDirection="row" flexWrap="wrap" {...(body ? { color: body } : {})}>
          {skill.nodes}
        </Box>
      )
    }

    return <Text {...(body ? { color: body } : {})}>{msg.text}</Text>
  })()

  // Diff segments（pushInlineDiffSegment 产出的叙述间 diff 段）保留两侧空行
  const isDiffSegment = msg.kind === 'diff'

  return (
    <Box
      flexDirection="column"
      marginBottom={msg.role === 'user' || isDiffSegment ? (getTuiDensity() === 'cozy' ? 2 : 1) : getTuiDensity() === 'cozy' ? 1 : 0}
      marginTop={msg.role === 'user' || msg.kind === 'slash' || isDiffSegment || leadGap ? 1 : 0}
      onClick={handleMessageClick}
      onMultiClick={handleMessageMultiClick}
      onMouseEnter={handleMessageEnter}
      onMouseLeave={handleMessageLeave}
    >
      {showDetails && (
        <Box flexDirection="column" marginBottom={1}>
          <PeerToolTrail outcome={outcome} t={t} trail={msg.tools} />
        </Box>
      )}

      <Box>
        <NoSelect flexShrink={0} fromLeftEdge width={gutterWidth}>
          {/* 用户 = dim「❯ 」；其余角色无字形（保持列对齐的空白 gutter——对标 Claude Code） */}
          <Text bold={isUser} color={isSelected || (hovered && !isSelected) ? t.color.accent : isUser ? prefix : t.color.text}>
            {isUser ? `${glyph} ` : '  '}
          </Text>
        </NoSelect>

        <Box
          width={transcriptBodyWidth(cols, msg.role, t.brand.prompt, TERMUX_TUI_MODE)}
          {...(isSelected ? { backgroundColor: t.color.selectionBg, ...(isUser ? { paddingX: 1 } : {}) } : {})}
        >
          {content}
        </Box>
      </Box>
    </Box>
  )
})

interface MessageLineProps {
  cols: number
  compact?: boolean
  detailsMode?: DetailsMode
  detailsModeCommandOverride?: boolean
  isStreaming?: boolean
  msg: Msg
  /** A19：虚拟行 key（appLayout row.key）——鼠标点选的唯一标识。 */
  msgKey?: string
  /** A24：/skill: 引用点击执行（composer.submit 链路） */
  onCommand?: (text: string) => void
  /** live 轮次结果（approved (auto)/denied 等）——PeerToolTrail 底行 */
  outcome?: string
  // The block rendered directly above this one. Drives the group-boundary
  // lead gap (see domain/blockLayout.ts::hasLeadGap).
  prev?: Msg
  sections?: SectionVisibility
  t: Theme
  tools?: ActiveTool[]
}
