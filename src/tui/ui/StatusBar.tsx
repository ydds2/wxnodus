// src/tui/ui/StatusBar.tsx — 状态栏（钉底参数行）：[模式] (模型 ●/○) · cwd · git · ▣后台 · ctx 水位
// 用户裁决：参数只占一栏——分段 + 显示宽度硬截断，永不折行（窄终端丢尾部段）；下沿细线收口。
// 机制参考：kimi 底栏（模式/模型/用量）+ gemini ContextUsageDisplay 阈值变色，实现原创。
import React from 'react'
import { Box, Text } from 'ink'
import type { TuiState } from '../store.js'
import { DEEP_SPACE } from '../theme.js'
import { modeColor } from './modeColor.js'
import { glyphs } from '../termcap.js'
import { strWidth } from '../viewport.js'
import { tuiT } from '../i18n.js'

export function StatusBar({ state, cols }: { state: TuiState; cols: number }): React.ReactElement {
  // ⅩⅩⅧ：头尾式截断（C:\…\wxnodus4.0）——纯尾截丢盘符/根路径，用户难以辨认
  const cwdRaw = state.cwd.split('\\').join('/')
  const cwd = cwdRaw.length > 24
    ? `${cwdRaw.slice(0, 8)}…${cwdRaw.slice(-14)}`
    : state.cwd
  const jobsNote = state.tasks.length > 0 ? tuiT('tui.status.jobs', { n: state.tasks.length }) : ''
  let ctx = ''
  let ctxColor = DEEP_SPACE.dim
  if (state.context) {
    const ratio = state.context.limit > 0 ? Math.min(1, state.context.used / state.context.limit) : 0
    const pct = Math.round(ratio * 100)
    ctxColor = ratio >= 0.85 ? DEEP_SPACE.violet : DEEP_SPACE.dim // 阈值变紫（原型 32）
    ctx = ` · ctx ${pct}%`
  }
  // 分段（信息优先序）→ 宽度预算 cols-1 内截断——参数恒一行
  const segs: Array<{ text: string; color?: string; bold?: boolean }> = [
    { text: `[${state.mode}]`, color: modeColor(state.mode), bold: true },
    { text: ` (${state.model || tuiT('tui.model.unset')} ${state.running ? '●' : '○'})` },
    { text: `  ${cwd}` },
  ]
  if (state.gitBranch) segs.push({ text: ` ${state.gitBranch}`, color: DEEP_SPACE.dim })
  if (jobsNote) segs.push({ text: jobsNote, color: DEEP_SPACE.violet })
  if (ctx) segs.push({ text: ctx, color: ctxColor })
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
      <Text color={DEEP_SPACE.muted}>
        {kept.map((seg, i) => (
          <Text key={i} color={seg.color} bold={seg.bold ?? undefined}>{seg.text}</Text>
        ))}
        {cut ? <Text color={DEEP_SPACE.dim}>…</Text> : null}
      </Text>
      <Text color={DEEP_SPACE.line}>
        <Text color={modeColor(state.mode)}>{glyphs().box.h}</Text>
        {glyphs().box.h.repeat(Math.max(0, cols - 2))}
      </Text>
    </Box>
  )
}
