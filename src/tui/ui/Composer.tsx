// src/tui/ui/Composer.tsx — 输入区（钉底固定区核心）：❯ 提示符 + 多行输入 + 双通道（Enter 发送/排队 · Ctrl+S steer）
// + 斜杠命令菜单（kimi 同语义：Tab 补全；↑↓ 导航后 Enter 才应用选中项；未导航 Enter 直接提交本行——绝不吃掉回车）
// + Ctrl+↑↓ 历史召回（原型 29）。value 存 store：App 依此精确计算固定区行数——底栏钉死，多行输入也不漂移。
import React, { useRef, useState } from 'react'
import { Box, Text } from 'ink'
import type { TuiState } from '../store.js'
import { TuiRuntime } from '../runtime.js'
import { DEEP_SPACE } from '../theme.js'
import { glyphs } from '../termcap.js'
import { searchAllCommands, detectAttachments } from '../commands.js'
import { wrapText, strWidth } from '../viewport.js'
import { useStableInput } from './stableInput.js'
import { tuiT } from '../i18n.js'

const MAX_SLASH_ROWS = 8
const MAX_PROMPT_ROWS = 8

// C-5 i18n：提示文案经 tuiT（/lang 即切即生效——键位与文案同语言）

/** 附件行文本（原型 33：路径截断 + 超 3 个折叠计数——与终端视觉换行一致计入钉底预算） */
function attachLine(value: string): string {
  const atts = detectAttachments(value)
  if (atts.length === 0) return ''
  const shown = atts.slice(0, 3).map(p => (p.length > 18 ? `${p.slice(0, 17)}…` : p)).join(' · ')
  return tuiT('tui.composer.attachLine', { n: atts.length, shown, more: atts.length > 3 ? ` · +${atts.length - 3}` : '' })
}

/** 按显示宽度截断（CJK 感知——盒内文本永不溢出右边界） */
function truncateTo(text: string, width: number): string {
  let w = 0
  let out = ''
  for (const ch of text) {
    const cw = strWidth(ch)
    if (w + cw > width) break
    w += cw
    out += ch
  }
  return out
}

/** 输入区行数（App 钉底预算用——与渲染完全一致：队列+附件+菜单+盒框(上/下)+提示符行+盒内键位行）。
 *  index = runtime.commandIndex() 注入（2026-09-03 全目录菜单——预算与渲染同源同计数） */
export function composerRows(s: TuiState, cols: number, index: Array<{ cmd: string; desc: string; cat: string }> = []): number {
  const value = s.composer.value
  const slashOpen = value.startsWith('/') && !value.includes('\n')
  const slashRows = slashOpen ? Math.min(MAX_SLASH_ROWS, searchAllCommands(value, index).length) : 0
  const attachRows = attachLine(value) ? Math.max(1, wrapText(attachLine(value), cols - 2).length) : 0
  const promptRows = Math.min(MAX_PROMPT_ROWS, Math.max(1, wrapText(value || '·', Math.max(4, cols - 9)).length))
  const overflow = value ? Math.max(0, wrapText(value, Math.max(4, cols - 9)).length - MAX_PROMPT_ROWS) : 0
  return (s.queue.length > 0 ? 1 : 0) + attachRows + slashRows + 2 + promptRows + (overflow > 0 ? 1 : 0) + (s.running ? 0 : 1)
}

export function Composer({ runtime, s, cols }: { runtime: TuiRuntime; s: TuiState; cols: number }): React.ReactElement {
  const value = s.composer.value
  const slashSel = s.composer.slashSel
  const slashOpen = value.startsWith('/') && !value.includes('\n')
  const slashMatches = slashOpen ? searchAllCommands(value, runtime.commandIndex()) : []
  const total = slashMatches.length
  const sel = total ? slashSel % total : 0
  // 滚动窗口（用户反馈：命令无法翻页——菜单可视 8 行，选中项居中滚动，可翻到全部匹配）
  const winStart = Math.max(0, Math.min(sel - Math.floor(MAX_SLASH_ROWS / 2), Math.max(0, total - MAX_SLASH_ROWS)))
  const visibleMatches = slashMatches.slice(winStart, winStart + MAX_SLASH_ROWS)
  // 菜单导航标记：↑↓ 移动过 → Enter 应用选中项；未移动 → Enter 提交本行（kimi 同语义——防"双回车"陷阱）
  const [menuNavigated, setMenuNavigated] = useState(false)
  // Windows 粘贴多行：ConPTY 把粘贴里的换行作为 \r 送达 → ink 解析为 return 键 → 首行即被提交。
  // 突发判定：与上一输入事件 <40ms 的 Enter 视为粘贴换行（真实回车与输入间隔几乎必超 40ms）
  const lastTypedAt = useRef(0)

  useStableInput((input, key) => {
    if (s.overlay.kind !== 'none') return // 浮层态输入归 Overlays
    // 快输入下 ink 事件回调闭包捕获渲染时值——一律从 store 快照读最新值（粘贴/连发不丢字）
    const cur = runtime.store.getSnapshot().composer.value
    const curSlash = cur.startsWith('/') && !cur.includes('\n')
    const curMatches = curSlash ? searchAllCommands(cur, runtime.commandIndex()) : []
    if (key.ctrl && (input === 's' || input === 'S')) {
      if (cur.trim()) { runtime.steer(cur); runtime.store.setComposerValue('') }
      return
    }
    if (key.ctrl && (input === 't' || input === 'T')) { runtime.toggleToolDetail(); return }
    // Ctrl+L 清屏（kimi/codex 同款——会话保留，/undo 可回滚会话）
    if (key.ctrl && (input === 'l' || input === 'L')) { runtime.clearScreen(); return }
    // Ctrl+↑↓ 历史召回（原型 29：gemini keyBindings 历史导航机制，实现原创）
    if (key.ctrl && key.upArrow) {
      const hit = runtime.recallHistory(-1)
      if (hit !== null) runtime.store.setComposerValue(hit)
      return
    }
    if (key.ctrl && key.downArrow) {
      const hit = runtime.recallHistory(1)
      if (hit !== null) runtime.store.setComposerValue(hit)
      return
    }
    if (key.return) {
      if (key.shift) { runtime.store.setComposerValue(cur + '\n'); return } // 多行输入（原型 29 换行通道）
      // 粘贴换行判定（Windows 粘贴多行文本——\r 突发到达视为换行而非提交）
      if (cur.length > 0 && Date.now() - lastTypedAt.current < 40) {
        runtime.store.setComposerValue(cur + '\n')
        return
      }
      // Enter 语义（kimi 同款）：↑↓ 导航过菜单 → 应用选中项；否则直接提交本行（绝不吃掉回车）
      if (curSlash && curMatches.length > 0 && menuNavigated) {
        const snapSel = runtime.store.getSnapshot().composer.slashSel
        runtime.store.setComposerValue(curMatches[snapSel % curMatches.length]!.cmd)
        runtime.store.setComposerSel(0)
        setMenuNavigated(false)
        return
      }
      if (cur.trim()) { runtime.submit(cur); runtime.store.setComposerValue(''); runtime.store.setComposerSel(0); setMenuNavigated(false) }
      return
    }
    if (key.upArrow && curSlash && curMatches.length) {
      const curSel = runtime.store.getSnapshot().composer.slashSel
      runtime.store.setComposerSel((curSel + curMatches.length - 1) % curMatches.length)
      setMenuNavigated(true)
      return
    }
    if (key.downArrow && curSlash && curMatches.length) {
      const curSel = runtime.store.getSnapshot().composer.slashSel
      runtime.store.setComposerSel((curSel + 1) % curMatches.length)
      setMenuNavigated(true)
      return
    }
    if (key.tab && curSlash && curMatches.length) {
      const curSel = runtime.store.getSnapshot().composer.slashSel
      runtime.store.setComposerValue(curMatches[curSel % curMatches.length]!.cmd)
      setMenuNavigated(false)
      return
    }
    if (key.backspace || key.delete) { runtime.store.setComposerValue(cur.slice(0, -1)); if (!cur.slice(0, -1).startsWith('/')) setMenuNavigated(false); return }
    if (key.ctrl || key.meta || key.escape) return
    if (input) {
      // 粘贴整块到达：\r 内嵌于 input（ConPTY 单 chunk 送达）→ 归一为换行；否则 \r 在盒内回车覆写乱屏
      const cleaned = input.replace(/\r\n?/g, '\n')
      runtime.store.setComposerValue(cur + cleaned)
      lastTypedAt.current = Date.now() // 粘贴突发判定的时间锚
      if (cur + cleaned === '/') setMenuNavigated(false)
    }
  })

  const symColor = s.running ? DEEP_SPACE.violet : s.mode === 'plan' ? DEEP_SPACE.violet : DEEP_SPACE.accent
  // 安全边距（2026-09-03）：内容预算再收 2 列——↑↓/▏/CJK 等在真实终端字体渲染宽度可能大于
  // strWidth 估算，溢出会触发终端侧换行产生「第三行空行」。留边 + wrap=truncate 双保险：
  // 输入框结构恒为上沿+提示符行+键位行+下沿（两行内容），任何字体/宽度下绝不出现第三行。
  const textW = Math.max(4, cols - 8) // 盒内预算（P2 对齐 2026-09-04：盒宽 = cols 与边线齐——此前 cols-1 右缘缺 1）：│(2) 提示符(2) … 内容+光标+填充(textW) 空格(1) │(2)
  const innerW = Math.max(4, cols - 6)
  const promptLines = wrapText(value || '·', textW).slice(0, MAX_PROMPT_ROWS)
  const overflow = value ? Math.max(0, wrapText(value, textW).length - MAX_PROMPT_ROWS) : 0
  const attachments = attachLine(value)
  const b = glyphs().box
  const boxH = b.h.repeat(Math.max(0, cols - 2))
  const placeholderText = truncateTo(s.running ? tuiT('tui.composer.busyPlaceholder') : DEEP_SPACE.placeholders[s.placeholderIdx]!, textW)
  // 提示行内容硬截断到 textW——内容行永不超出盒宽（wrap=truncate 兜底：即使估算误差也只截尾不折行）
  const promptSafe = (line: string) => truncateTo(line, textW)

  return (
    <Box flexDirection="column">
      {s.queue.length > 0 ? (
        <Box paddingLeft={1}>
          <Text color={DEEP_SPACE.warn}>{truncateTo(tuiT('tui.composer.queueHint', { n: s.queue.length }), cols - 2)}</Text>
        </Box>
      ) : null}
      {attachments ? (
        <Box paddingLeft={1}>
          <Text color={DEEP_SPACE.violet}>{attachments}</Text>
        </Box>
      ) : null}
      {slashOpen && slashMatches.length > 0 ? (
        <Box flexDirection="column" paddingLeft={1} paddingBottom={0}>
          {visibleMatches.map((m, i) => {
            const on = winStart + i === sel
            // 硬截断到行宽——菜单每行恰 1 行（窄终端不折行，钉底预算不漂移）；cat 符号先行（视觉分组）
            const line = truncateTo(`${on ? glyphs().pointer + ' ' : '  '}${m.cat ? m.cat + ' ' : ''}${m.cmd.padEnd(14)} ${m.desc}`, cols - 2)
            return (
              <Text key={m.cmd} color={on ? DEEP_SPACE.accent : DEEP_SPACE.muted}>{line}</Text>
            )
          })}
        </Box>
      ) : null}
      {/* 输入框四周围起来（用户裁决：kimi 同款盒式输入框）——上沿/内容/盒内键位行/下沿 */}
      <Text color={DEEP_SPACE.line}>{b.tl + boxH + b.tr}</Text>
      {promptLines.map((line, i) => {
        const isLast = i === promptLines.length - 1
        const content = value ? promptSafe(line) : (i === 0 ? placeholderText : '')
        const pad = Math.max(0, textW - strWidth(content) - (isLast ? 1 : 0))
        return (
          <Text key={i} wrap="truncate">
            <Text color={DEEP_SPACE.line}>{b.v + ' '}</Text>
            {i === 0 ? <Text color={symColor} bold>{glyphs().prompt + ' '}</Text> : <Text color={DEEP_SPACE.dim}>  </Text>}
            {value
              ? <Text>{content}</Text>
              : <Text color={DEEP_SPACE.dim}>{content}</Text>}
            {isLast ? <Text color={symColor}>{glyphs().caret}</Text> : null}
            <Text>{' '.repeat(pad)}</Text>
            <Text color={DEEP_SPACE.line}>{' ' + b.v}</Text>
          </Text>
        )
      })}
      {s.running ? null : (
        <Text color={DEEP_SPACE.dim} wrap="truncate">
          <Text color={DEEP_SPACE.line}>{b.v + ' '}</Text>
          {truncateTo(tuiT('tui.composer.hintIdle'), innerW)}
          <Text>{' '.repeat(Math.max(0, innerW - strWidth(truncateTo(tuiT('tui.composer.hintIdle'), innerW))))}</Text>
          <Text color={DEEP_SPACE.line}>{' ' + b.v}</Text>
        </Text>
      )}
      {overflow > 0 ? (
        <Text color={DEEP_SPACE.dim}>
          <Text color={DEEP_SPACE.line}>{b.v + ' '}</Text>
          {tuiT('tui.composer.overflowHint', { n: overflow })}
          <Text>{' '.repeat(Math.max(0, innerW - strWidth(tuiT('tui.composer.overflowHint', { n: overflow }))))}</Text>
          <Text color={DEEP_SPACE.line}>{' ' + b.v}</Text>
        </Text>
      ) : null}
      <Text color={DEEP_SPACE.line}>{b.bl + boxH + b.br}</Text>
    </Box>
  )
}
