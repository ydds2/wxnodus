// src/wxnodus-ui/components/kimiChrome.tsx — kimi code TUI 视觉层（2026-08-28 全面对齐重构）
// 机制参考 kimi-cli ui/shell（__init__.py _print_welcome_info / prompt.py _render_agent_prompt_message
// + _render_bottom_toolbar / theme.py ToolbarColors）·实现原创（React/ink 重写，不抄代码）。
// 三件套：
//   ① KimiWelcomeCard —— 蓝框欢迎卡（块字 LOGO + 欢迎语 + /help 提示 + info 行按 level 着色）
//   ② kimiInputHeader —— 输入区分隔头（normal 灰实线 / plan 蓝虚线 / N queued 计入标题）
//   ③ KimiBottomBar —— 双行底栏（全宽分隔线 + 状态标志/mode(model ○)/cwd+branch/后台/30s 轮换 tip）
// 配色对齐 kimi theme.py：separator #4d4d4d · cwd #666666 · tip #555555 · yolo 黄 bold · afk 橙 · plan 蓝。
import { Box, Text } from '@wxnodus/ink'
import { useAtom as useStore } from '../../app/stores/engine.js'
import { bgActiveCount, useBgSelector } from '../runtime/backgroundStore.js'
import { $uiState } from '../runtime/viewStore.js'
import { icon } from '../glyphs.js'
import { memo, useEffect, useState } from 'react'
import type { Theme } from '../theme.js'
import { WXNODUS_VERSION } from '../../kernel/version.js'

// kimi 视觉常量（theme.py ToolbarColors dark 档）
export const KIMI_COLORS = {
  separator: '#4d4d4d',
  cwd: '#666666',
  tip: '#555555',
  yolo: '#ffff00',
  afk: '#ff8800',
  plan: '#00aaff',
  logo: '#00aaff', // dodger_blue1
  infoRow: 'grey50',
} as const

// ── ① 欢迎卡 ──────────────────────────────────────────────────────────

const LOGO_LINES = ['▐█▛█▛█▌', '▐█████▌']

export interface KimiWelcomeInfo {
  name: string
  value: string
  level?: 'info' | 'warn' | 'error'
}

/**
 * kimi 式欢迎卡（_print_welcome_info 语义）：
 * Panel 蓝框内 = 左块字 LOGO + 右「Welcome to … CLI!」两行 + info 行（Directory/Session/Model…）。
 * info level：info=grey50 / warn=yellow / error=red。首帧渲染后不再动画（kimi 无 intro 动画）。
 */
export const KimiWelcomeCard = memo(function KimiWelcomeCard({ model, cwd, sessionId, t }: {
  model: string
  cwd: string
  sessionId: string
  t: Theme
}) {
  const items: KimiWelcomeInfo[] = [
    { name: 'Directory', value: cwd },
    { name: 'Session', value: sessionId },
  ]
  if (model) {
    items.push({ name: 'Model', value: model })
  } else {
    items.push({ name: 'Model', value: 'not set, /model set-key 配置', level: 'warn' })
  }
  items.push({ name: 'Tip', value: 'send /help for help information', level: 'info' })

  const levelColor = (lv?: KimiWelcomeInfo['level']) =>
    lv === 'warn' ? t.color.warn : lv === 'error' ? t.color.error : KIMI_COLORS.infoRow

  // 框宽：内容宽 + 2 padding + 2 边框（expand=False 语义——按内容收窄，非全宽）
  const innerW = Math.max(
    LOGO_LINES[0]!.length + 1 + 'Welcome to WxNodus CLI!'.length,
    ...items.map(i => `${i.name}: ${i.value}`.length),
    `WxNodus ${WXNODUS_VERSION}`.length,
  ) + 4
  const top = `╭${'─'.repeat(innerW)}╮`
  const bottom = `╰${'─'.repeat(innerW)}╯`
  const pad = (s: string) => `│ ${s}${' '.repeat(Math.max(0, innerW - 2 - visualWidth(s)))} │`

  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Text color={KIMI_COLORS.logo}>{top}</Text>
      <Box flexDirection="row">
        <Box flexDirection="column" paddingRight={1}>
          {LOGO_LINES.map((l, i) => (
            <Text key={i} color={KIMI_COLORS.logo}>{l}</Text>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Text bold>Welcome to WxNodus CLI!</Text>
          <Text color={KIMI_COLORS.tip}>Send /help for help information.</Text>
        </Box>
      </Box>
      <Text>{''}</Text>
      <Text>{pad(`WxNodus ${WXNODUS_VERSION}`)}</Text>
      {items.map((it, i) => (
        <Text key={i} color={levelColor(it.level)}>{pad(`${it.name}: ${it.value}`)}</Text>
      ))}
      <Text color={KIMI_COLORS.logo}>{bottom}</Text>
    </Box>
  )
})

// 修复（2026-08-28 真机反馈）：原实现恒返回 1（三元逻辑坏 + surrogate pair 未处理）——
// 中文路径/全角字符宽度全错导致欢迎卡边框错位。内联正确实现（@wxnodus/ink stringWidth 同族简版：
// CJK/全角区双宽、surrogate pair 计 2、组合标记计 0）。
const WIDE_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/
const visualWidth = (s: string): number => {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp > 0xFFFF) { w += 2; continue }        // surrogate pair（emoji 等）计 2
    if (cp >= 0x0300 && cp <= 0x036F) continue   // 组合标记计 0
    w += WIDE_RE.test(ch) ? 2 : 1
  }
  return w
}

// ── ② 输入区分隔头 ─────────────────────────────────────────────────────

/**
 * kimi 输入区分隔头（_render_agent_prompt_message 第 4 步语义）：
 *   normal:  ── input ──────────  （灰实线）
 *   plan:    ╌╌ input · plan ╌╌╌╌  （蓝虚线）
 *   queued:  ── input · N queued ──
 */
export const KimiInputHeader = memo(function KimiInputHeader({ cols, plan = false, queued = 0 }: {
  cols: number
  plan?: boolean
  queued?: number
}) {
  const titleParts = ['input']
  if (plan) titleParts.push('plan')
  if (queued > 0) titleParts.push(`${queued} queued`)
  const title = ` ${titleParts.join(' · ')} `
  const dash = plan ? '╌' : '─'
  const color = plan ? KIMI_COLORS.plan : KIMI_COLORS.separator
  const borderFill = Math.max(0, cols - 4 - title.length)
  return (
    <Text color={color} wrap="truncate-end">
      {dash}{dash}{title}{dash.repeat(borderFill)}
    </Text>
  )
})

// ── ③ 双行底栏 ─────────────────────────────────────────────────────────

const TIPS = [
  '/help 查看全部命令 · /model set-key 配置模型',
  'Ctrl+C 中断当前任务 · 再按退出',
  '/memory 长期记忆 · /jobs 后台任务',
  '✨ 开头 / 执行命令 · 空行跳过',
]
const TIP_INTERVAL_MS = 30_000

/**
 * kimi 双行底栏（_render_bottom_toolbar 语义）：
 * 第一行全宽 ─ 分隔线；第二行 = 状态标志（yolo/afk/plan 色）+ `agent (model ○)` +
 * cwd（左截）+ git 分支 + 后台任务数 + 30s 轮换 tip。窄终端降级 full→mid→bare。
 */
export const KimiBottomBar = memo(function KimiBottomBar({ mode = 'agent', model, thinking = false, cwd, branch, bgCount = 0, cols = 80, flags = [] }: {
  mode?: string
  model: string
  thinking?: boolean
  cwd: string
  branch?: string | null
  bgCount?: number
  cols?: number
  flags?: Array<'yolo' | 'afk' | 'plan'>
}) {
  const [tipIdx, setTipIdx] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTipIdx(i => i + 1), TIP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  const dot = thinking ? '●' : '○'
  const modeFull = model ? `${mode} (${model} ${dot})` : mode
  const modeMid = `${mode} ${dot}`
  const cwdText = String(cwd).replace(/\\/g, '/')
  const branchSeg = branch ? ` ${branch}` : ''
  const tip = TIPS[tipIdx % TIPS.length]!

  // 降级链：full（mode+cwd+tip）→ mid（mode+cwd）→ bare（mode only）
  const w = (s: string) => s.length
  const flagStr = flags.length ? flags.join(' ') + '  ' : ''
  const tryFull = w(flagStr) + w(modeFull) + 2 + w(cwdText) + w(branchSeg) + 2 + w(tip)
  const tryMid = w(flagStr) + w(modeFull) + 2 + Math.min(w(cwdText), 30) + w(branchSeg)
  const inner = Math.max(20, cols - 2)

  let modeText = modeFull
  let cwdShow = cwdText.length > 32 ? '…' + cwdText.slice(-30) : cwdText
  let tipShow: string | null = tip
  if (tryFull > inner) {
    if (tryMid > inner) { modeText = mode; cwdShow = ''; tipShow = null }
    else { tipShow = null; modeText = w(modeFull) <= inner - 2 ? modeFull : modeMid }
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={KIMI_COLORS.separator}>{'─'.repeat(cols)}</Text>
      <Box>
        {flags.map(f => (
          <Text key={f} bold color={f === 'yolo' ? KIMI_COLORS.yolo : f === 'afk' ? KIMI_COLORS.afk : KIMI_COLORS.plan}>
            {f}{'  '}
          </Text>
        ))}
        <Text>{modeText}{'  '}</Text>
        {cwdShow ? <Text color={KIMI_COLORS.cwd}>{cwdShow}{branchSeg}</Text> : null}
        {bgCount > 0 ? <Text color="#888888">{'  '}bg {bgCount}</Text> : null}
        {tipShow ? <Text color={KIMI_COLORS.tip}>{'  '}{tipShow}</Text> : null}
      </Box>
    </Box>
  )
})

// ── 组合件：kimi 底栏区（分隔线+状态行+line2 toast 槽）——appLayout 瘦身抽取 ──
export const KimiStatusZone = memo(function KimiStatusZone(props: {
  model: string
  thinking: boolean
  cwd: string
  bgCount: number
  cols: number
  perm: string
  top: boolean
  notice?: { text?: string; level?: string } | null
  usage?: { context_percent?: number } | null
  t: Theme
}) {
  const flags = props.perm === 'yolo' ? ['yolo'] as const : props.perm === 'plan' ? ['plan'] as const : []
  const pct = props.usage?.context_percent
  return (
    <Box marginTop={props.top ? 1 : 0} flexDirection="column">
      <KimiBottomBar model={props.model} thinking={props.thinking} cwd={props.cwd}
        bgCount={props.bgCount} cols={props.cols} flags={[...flags]} />
      {(props.notice?.text || pct !== undefined) && (
        <Box>
          {props.notice?.text ? <Text color={props.notice.level === 'error' ? props.t.color.error : props.t.color.warn}>{props.notice.text}</Text> : null}
          {pct !== undefined ? <Text color={pct >= 85 ? props.t.color.error : pct >= 75 ? props.t.color.warn : KIMI_COLORS.cwd}>{'  '}ctx {Math.round(pct)}%</Text> : null}
        </Box>
      )}
    </Box>
  )
})

// ── 后台活动摘要行（appLayout 瘦身迁入——ratchet 收容）──
// A24：后台活动摘要行——运行中任务/终端/goal 循环一览
export const BgSummaryLine = memo(function BgSummaryLine() {
  const ui = useStore($uiState)
  const bg = useBgSelector(s => s)
  const terms = bg.terms.filter(x => x.status === 'running').length
  const jobs = bg.jobs.filter(j => j.status === 'running' || j.status === 'queued').length
  const parts: string[] = []
  if (jobs) parts.push(`${jobs} 任务`)
  if (terms) parts.push(`${terms} 终端`)
  if (bg.goal?.active) parts.push(bg.goal.cancelled ? `goal 已取消（${bg.goal.round}/${bg.goal.maxRounds} 轮）` : `goal ${bg.goal.round}/${bg.goal.maxRounds} 轮`)
  if (bgActiveCount(bg) === 0 || !parts.length) return null

  return (
    <Box>
      <Text color={ui.theme.color.muted}>
        <Text color={ui.theme.color.accent}>{icon('copy')} 后台：</Text>
        {parts.join(' · ')}
      </Text>
    </Box>
  )
})
