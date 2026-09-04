// src/tui/ui/Header.tsx — 顶部品牌条：三明治边界框架的上沿（WXNODUS 字标 + 会话徽章行）
// 边界词汇：上下双细线包夹（#2a3050）——界面整体结构的明确锚点（用户反馈：整体边界未体现）。
// 窄终端：分段 + 显示宽度硬截断（参数行同款机制——40 列也不折行，钉底不漂移）。
import React from 'react'
import { Box, Text } from 'ink'
import type { TuiState } from '../store.js'
import { DEEP_SPACE } from '../theme.js'
import { glyphs } from '../termcap.js'
import { modeColor } from './modeColor.js'
import { strWidth } from '../viewport.js'
import { tuiT } from '../i18n.js'

function line(width: number): string { return '─'.repeat(Math.max(0, width - 1)) }

export function Header({ s, cols }: { s: TuiState; cols: number }): React.ReactElement {
  const g = glyphs()
  // 「独立艺术品」品牌行：ConfigService.resolveBranding（未配置回退 WXNODUS）；
  // icon 仅当为短可显示文本/emoji 时渲染（数据 URI/超长图标降级为仅名称——零噪音）
  const brandName = s.brand?.name || 'WXNODUS'
  const icon = s.brand?.icon ?? null
  const showIcon = icon !== null && icon.length <= 8 && !icon.includes(':')
  const segs: Array<{ text: string; color?: string; bold?: boolean }> = [
    { text: ` ${showIcon ? `${icon} ` : ''}${brandName} `, color: DEEP_SPACE.accent, bold: true },
    { text: 'TUI', color: DEEP_SPACE.dim },
    { text: '  │  ', color: DEEP_SPACE.dim },
  ]
  if (s.command) segs.push({ text: tuiT('tui.header.command'), color: DEEP_SPACE.violet }) // 命令心跳同步状态（不再显示误导性的「空闲」）
  else if (s.running) segs.push({ text: tuiT('tui.header.running', { spin: g.spinner[Math.floor(Date.now() / 120) % g.spinner.length]! }), color: DEEP_SPACE.violet })
  else segs.push({ text: tuiT('tui.header.idle'), color: DEEP_SPACE.dim })
  segs.push({ text: '  │  ', color: DEEP_SPACE.dim })
  segs.push({ text: s.mode, color: modeColor(s.mode), bold: true })
  segs.push({ text: ` · ${s.model || tuiT('tui.model.unset')}`, color: DEEP_SPACE.muted })
  if (s.gitBranch) segs.push({ text: ` · ${s.gitBranch}`, color: DEEP_SPACE.dim })
  // 硬截断：恒一行（信息优先序——品牌/状态/模式恒保留，模型/分支让位）
  const limit = Math.max(8, cols - 1)
  const kept: typeof segs = []
  let w = 0
  let cut = false
  for (const seg of segs) {
    const sw = strWidth(seg.text)
    if (w + sw > limit) { cut = true; break }
    kept.push(seg)
    w += sw
  }
  return (
    <Box flexDirection="column">
      <Text color={DEEP_SPACE.line}>{line(cols)}</Text>
      <Box>
        <Text>
          {kept.map((seg, i) => (
            <Text key={i} color={seg.color} bold={seg.bold ?? undefined}>{seg.text}</Text>
          ))}
          {cut ? <Text color={DEEP_SPACE.dim}>…</Text> : null}
        </Text>
      </Box>
      <Text color={DEEP_SPACE.line}>{line(cols)}</Text>
    </Box>
  )
}
