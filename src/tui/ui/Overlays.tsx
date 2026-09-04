// src/tui/ui/Overlays.tsx — 浮层：审批（黄框四级）/澄清/密钥（紫框掩码）/帮助/模型选择器/主题选择器
// （原型 05/09/10/11/08/31）优先级栈（原型 56）：密钥 > 审批 > 澄清 > 帮助/模型/主题——同时至多一层；
// 面板替换输入区（覆盖即输入面）。
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { TuiStore, type TuiState } from '../store.js'
import { TuiRuntime } from '../runtime.js'
import { DEEP_SPACE, TUI_THEME_NAMES, TUI_THEMES, paletteOf } from '../theme.js'
import { glyphs } from '../termcap.js'
import { groupCommands, type IndexCommand } from '../commands.js'
import { keySections } from '../keys.js'
import { strWidth } from '../viewport.js'
import { tuiT, tuiLang } from '../i18n.js'
import { useStableInput } from './stableInput.js'

const panel = (color: string) => ({
  borderStyle: 'round' as const,
  borderColor: color as never,
  flexDirection: 'column' as const,
  paddingX: 1,
  marginY: 1,
})

/** 2026-09-03 美化：模型选择器厂商徽章色（未知厂商回落 muted——零噪音） */
const PROVIDER_COLORS: Record<string, string> = {
  deepseek: DEEP_SPACE.accent,
  kimi: DEEP_SPACE.violet,
  zhipu: DEEP_SPACE.success,
  offline: DEEP_SPACE.dim,
  custom: DEEP_SPACE.warn,
}

/** T79 面板行硬截断：按显示宽度截到单行（窄终端下长提示/数据行不再折行——行数预算不漂移） */
function fit(text: string, pad = 6): string {
  const width = (process.stdout.columns ?? 80) - pad
  if (strWidth(text) <= width) return text
  let w = 0
  let out = ''
  for (const ch of text) {
    const cw = strWidth(ch)
    if (w + cw > width - 1) return out + '…'
    w += cw
    out += ch
  }
  return out
}

/**
 * 浮层行数估计（App 钉底预算用——宁多勿少，多估即转录区让位，底栏永不漂出）。
 * T79 短终端加固：终端行数过低时按 rows-4 封顶（头部 3 + 转录最少 1），
 * 且带长列表的三面板（model/rewind/help）与列表钳制值联动——估计恒 ≥ 实际渲染。
 */
export function overlayRows(kind: TuiState['overlay']['kind'], rows = 24): number {
  const cap = Math.max(6, rows - 4)
  const base = (() => {
    switch (kind) {
      case 'none': return 0
      case 'approval': return 9
      case 'clarify': return 10
      case 'secret': return 8
      case 'confirm': return 8
      case 'compact': return 10
      case 'plan': return 11
      case 'planedit': return 10
      case 'help': return 18
      case 'model': return 16
      case 'theme': return 14
      case 'config': return 13
      case 'modelform': return 14
      case 'mode': return 11
      case 'keys': return 16
      case 'rewind': return 14
      case 'voice': return 9
    }
  })()
  return Math.min(base, cap)
}

/** T79 长列表窗口钳制：短终端下面板列表行数收缩（标题/边框/页脚占用扣减——与 overlayRows 同源） */
export function overlayListMax(kind: 'model' | 'rewind' | 'help', rows = 24): number {
  if (kind === 'model') return Math.min(12, Math.max(2, rows - 12))
  if (kind === 'rewind') return Math.min(10, Math.max(2, rows - 10))
  return Math.min(11, Math.max(3, rows - 14))
}

export function Overlays({ store, runtime, s, rows = 24 }: { store: TuiStore; runtime: TuiRuntime; s: TuiState; rows?: number }): React.ReactElement | null {
  const ov = s.overlay

  if (ov.kind === 'approval') {
    return <ApprovalPanel store={store} s={s} />
  }
  if (ov.kind === 'clarify') {
    return <ClarifyPanel store={store} s={s} />
  }
  if (ov.kind === 'secret') {
    return <SecretPanel store={store} s={s} />
  }
  if (ov.kind === 'confirm') {
    return <ConfirmPanel store={store} s={s} />
  }
  if (ov.kind === 'compact') {
    return <CompactPanel store={store} s={s} />
  }
  if (ov.kind === 'plan') {
    return <PlanPanel s={s} />
  }
  if (ov.kind === 'planedit') {
    return <PlanEditPanel s={s} />
  }
  if (ov.kind === 'help') {
    return <HelpPanel runtime={runtime} rows={rows} />
  }
  if (ov.kind === 'model') {
    return <ModelPicker runtime={runtime} s={s} rows={rows} />
  }
  if (ov.kind === 'mode') {
    return <ModePicker runtime={runtime} s={s} />
  }
  if (ov.kind === 'theme') {
    return <ThemePicker runtime={runtime} s={s} />
  }
  if (ov.kind === 'config') {
    return <ConfigPanel runtime={runtime} s={s} />
  }
  if (ov.kind === 'modelform') {
    return <ModelFormPanel runtime={runtime} />
  }
  if (ov.kind === 'keys') {
    return <KeysPanel runtime={runtime} />
  }
  if (ov.kind === 'rewind') {
    return <RewindPanel runtime={runtime} rows={rows} />
  }
  if (ov.kind === 'voice') {
    return <VoicePanel runtime={runtime} s={s} />
  }
  return null
}

function ApprovalPanel({ store, s }: { store: TuiStore; s: TuiState }): React.ReactElement {
  const ov = s.overlay
  if (ov.kind !== 'approval') return <Box />
  const p = ov.pending
  useStableInput((_input, key) => {
    if (key.upArrow) store.patch({ overlay: { kind: 'approval', pending: { ...p, selected: (p.selected + p.choices.length - 1) % p.choices.length } } })
    else if (key.downArrow) store.patch({ overlay: { kind: 'approval', pending: { ...p, selected: (p.selected + 1) % p.choices.length } } })
    else if (key.return) p.resolve(p.choices[p.selected]!.key)
    else if (key.escape) p.resolve('deny')
  })
  return (
    <Box {...panel(DEEP_SPACE.warn)}>
      <Text color={DEEP_SPACE.warn} bold>⚠ {p.title}</Text>
      <Text color={DEEP_SPACE.muted}>{fit(`$ ${p.command}`)}</Text>
      {p.choices.map((c, i) => (
        <Text key={c.key} color={i === p.selected ? DEEP_SPACE.warn : DEEP_SPACE.muted}>
          {i === p.selected ? glyphs().pointer + ' ' : '  '}{i + 1} {c.label}
        </Text>
      ))}
      <Text color={DEEP_SPACE.dim}>
        {fit(tuiT('tui.panel.approval.footer', { t: approvalLeft(p.deadline) }))}
      </Text>
    </Box>
  )
}

/** 审批倒计时（原型 05 倒计时动画——1s tick 驱动重渲染） */
function approvalLeft(deadline?: number): string {
  if (!deadline) return '5:00'
  const left = Math.max(0, Math.round((deadline - Date.now()) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

function ClarifyPanel({ store, s }: { store: TuiStore; s: TuiState }): React.ReactElement {
  const ov = s.overlay
  const [typed, setTyped] = useState('')
  if (ov.kind !== 'clarify') return <Box />
  const p = ov.pending
  useStableInput((input, key) => {
    if (key.return) {
      p.resolve(typed.trim() || p.choices[p.selected] || '')
      return
    }
    if (p.choices.length) {
      if (key.upArrow) { store.patch({ overlay: { kind: 'clarify', pending: { ...p, selected: (p.selected + p.choices.length - 1) % p.choices.length } } }); return }
      if (key.downArrow) { store.patch({ overlay: { kind: 'clarify', pending: { ...p, selected: (p.selected + 1) % p.choices.length } } }); return }
    }
    if (key.backspace || key.delete) { setTyped(v => v.slice(0, -1)); return }
    if (!key.ctrl && !key.meta && !key.escape && input) setTyped(v => v + input)
  })
  return (
    <Box {...panel(DEEP_SPACE.accent)}>
      <Text color={DEEP_SPACE.accent} bold>{fit(`? ${p.question}`)}</Text>
      {p.choices.map((c, i) => (
        <Text key={c} color={i === p.selected && !typed ? DEEP_SPACE.accent : DEEP_SPACE.muted}>
          {i === p.selected && !typed ? '▸ ' : '  '}{c}
        </Text>
      ))}
      <Text color={DEEP_SPACE.muted}>{tuiT('tui.panel.clarify.answerPrefix')}{typed || tuiT('tui.panel.clarify.fallback')}</Text>
      <Text color={DEEP_SPACE.dim}>{fit(tuiT('tui.panel.clarify.footer'))}</Text>
    </Box>
  )
}

function SecretPanel({ store, s }: { store: TuiStore; s: TuiState }): React.ReactElement {
  const ov = s.overlay
  if (ov.kind !== 'secret') return <Box />
  const p = ov.pending
  useStableInput((input, key) => {
    if (key.return) { p.resolve(p.masked || null); return }
    if (key.escape) { p.resolve(null); return }
    if (key.backspace || key.delete) { store.patch({ overlay: { kind: 'secret', pending: { ...p, masked: p.masked.slice(0, -1) } } }); return }
    if (!key.ctrl && !key.meta && input) store.patch({ overlay: { kind: 'secret', pending: { ...p, masked: p.masked + glyphs().mask } } })
  })
  return (
    <Box {...panel(DEEP_SPACE.violet)}>
      <Text color={DEEP_SPACE.violet} bold>{p.kind === 'sudo' ? tuiT('tui.panel.secret.sudoTitle') : tuiT('tui.panel.secret.title')}</Text>
      <Text color={DEEP_SPACE.muted}>{p.prompt}</Text>
      <Text>  {p.masked}<Text color={DEEP_SPACE.violet}>{glyphs().caret}</Text></Text>
      <Text color={DEEP_SPACE.dim}>{fit(tuiT('tui.panel.secret.footer'))}</Text>
    </Box>
  )
}

/** 模型选择器（原型 08）：目录列表 + 当前档高亮 + A 提示添加自定义接口 */
function ModelPicker({ runtime, s, rows = 24 }: { runtime: TuiRuntime; s: TuiState; rows?: number }): React.ReactElement {
  const [sel, setSel] = useState(0)
  const catalog = runtime.modelCatalog()
  useStableInput((input, key) => {
    if (key.upArrow) { setSel(i => (i + catalog.length - 1) % Math.max(1, catalog.length)); return }
    if (key.downArrow) { setSel(i => (i + 1) % Math.max(1, catalog.length)); return }
    if (key.return) {
      const hit = catalog[sel % Math.max(1, catalog.length)]
      if (hit) runtime.selectModel(hit.id)
      return
    }
    if (key.escape) { runtime.closeModelPicker(); return }
    if (input === 'a' || input === 'A') {
      runtime.openModelForm() // 原型 58：选择器「＋ 添加自定义接口」→ 五步表单（简版三字段）
      return
    }
  })
  return (
    <Box {...panel(DEEP_SPACE.accent)}>
      <Text color={DEEP_SPACE.accent} bold>◆ {tuiT('tui.panel.model.name')} · <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.model.titleHint')}</Text></Text>
      {catalog.length === 0 ? (
        <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.model.empty')}</Text>
      ) : (
        catalog.slice(0, overlayListMax('model', rows)).map((m, i) => (
          <Text key={m.id} color={i === sel % Math.max(1, catalog.length) ? DEEP_SPACE.accent : DEEP_SPACE.muted}>
            {i === sel % Math.max(1, catalog.length) ? glyphs().pointer + ' ' : '  '}
            {m.id}{m.id === s.model ? <Text color={DEEP_SPACE.success}>{tuiT('tui.panel.model.current')}</Text> : null}
            <Text color={DEEP_SPACE.dim}>  {fit(m.name, 16)} · </Text>
            <Text color={PROVIDER_COLORS[m.provider] ?? DEEP_SPACE.muted}>{m.provider}</Text>
          </Text>
        ))
      )}
      <Text color={DEEP_SPACE.dim}>{fit(tuiT('tui.panel.model.footer'))}</Text>
    </Box>
  )
}

/** 权限模式选择器（2026-09-03 用户裁决：模式全部由命令进入——/perm 唯一入口；六档一览，yolo 醒目标注） */
function ModePicker({ runtime, s }: { runtime: TuiRuntime; s: TuiState }): React.ReactElement {
  const MODE_ROWS: Array<[string, string]> = [
    ['smart', tuiT('tui.panel.mode.smart')],
    ['auto', tuiT('tui.panel.mode.auto')],
    ['manual', tuiT('tui.panel.mode.manual')],
    ['plan', tuiT('tui.panel.mode.plan')],
    ['goal', tuiT('tui.panel.mode.goal')],
    ['yolo', tuiT('tui.panel.mode.yolo')],
  ]
  const start = Math.max(0, MODE_ROWS.findIndex(([id]) => id === s.mode))
  const [sel, setSel] = useState(start)
  useStableInput((_input, key) => {
    if (key.upArrow) { setSel(i => (i + MODE_ROWS.length - 1) % MODE_ROWS.length); return }
    if (key.downArrow) { setSel(i => (i + 1) % MODE_ROWS.length); return }
    if (key.return) { const hit = MODE_ROWS[sel % MODE_ROWS.length]!; runtime.selectMode(hit[0]); return }
    if (key.escape) { runtime.closeModePicker(); return }
  })
  return (
    <Box {...panel(DEEP_SPACE.accent)}>
      <Text color={DEEP_SPACE.accent} bold>{tuiT('tui.panel.mode.title')}</Text>
      {MODE_ROWS.map(([id, label], i) => {
        const on = i === sel % MODE_ROWS.length
        const cur = id === s.mode
        return (
          <Text key={id} color={on ? DEEP_SPACE.accent : id === 'yolo' ? DEEP_SPACE.warn : DEEP_SPACE.muted}>
            {on ? glyphs().pointer + ' ' : '  '}{label}{cur ? <Text color={DEEP_SPACE.success}>{tuiT('tui.panel.model.current')}</Text> : null}
          </Text>
        )
      })}
      <Text color={DEEP_SPACE.dim}>{fit(tuiT('tui.panel.mode.footer'))}</Text>
    </Box>
  )
}

/** 主题选择器（原型 31）：左列表右预览（gemini ThemeDialog 模式）· ↑↓ 预览即见 · Enter 应用改即存 · Esc 取消零残留 */
function ThemePicker({ runtime, s }: { runtime: TuiRuntime; s: TuiState }): React.ReactElement {
  const names = TUI_THEME_NAMES
  const start = names.indexOf(s.themeName)
  const [sel, setSel] = useState(start >= 0 ? start : 0)
  const selName = names[sel % names.length]!
  const preview = paletteOf(selName) // 预览走选中主题色板（不污染当前全局主题——取消零残留）
  useStableInput((_input, key) => {
    if (key.upArrow) { setSel(i => (i + names.length - 1) % names.length); return }
    if (key.downArrow) { setSel(i => (i + 1) % names.length); return }
    if (key.return) { runtime.selectTheme(selName); return }
    if (key.escape) { runtime.closeThemePicker(); return }
  })
  return (
    <Box {...panel(preview.accent)}>
      <Text color={preview.accent} bold>◆ {tuiT('tui.panel.theme.name')} · <Text color={preview.dim}>{tuiT('tui.panel.theme.titleHint')}</Text></Text>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column" width={34}>
          {names.map((n, i) => (
            <Text key={n} color={i === sel % names.length ? preview.accent : preview.muted}>
              {i === sel % names.length ? glyphs().pointer + ' ' : '  '}
              {TUI_THEMES[n]!.label}{n === s.themeName ? <Text color={preview.success}>{tuiT('tui.panel.model.current')}</Text> : null}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text color={preview.dim}>{TUI_THEMES[selName]!.desc}</Text>
          <Text><Text color={preview.accent} bold>{glyphs().prompt}</Text> <Text color={preview.fg}>{tuiT('tui.panel.theme.sampleInput')}</Text></Text>
          <Text><Text color={preview.success}>✓</Text> <Text color={preview.accent}>bash</Text> <Text color={preview.muted}>npm test</Text> <Text color={preview.dim}>3 passed</Text></Text>
          <Text><Text color={preview.success}>{tuiT('tui.panel.theme.diffAdd')}</Text>   <Text color={preview.error}>{tuiT('tui.panel.theme.diffDel')}</Text></Text>
          <Text><Text color={preview.warn}>{tuiT('tui.panel.theme.appr')}</Text>   <Text color={preview.violet}>{tuiT('tui.panel.theme.memhit')}</Text></Text>
          <Text color={preview.dim}><Text color={preview.accent}>▎</Text>{tuiT('tui.panel.theme.legendUser')} <Text color={preview.success}>▎</Text>{tuiT('tui.panel.theme.legendAssistant')} <Text color={preview.violet}>◐</Text>{tuiT('tui.panel.theme.legendRunning')}</Text>
        </Box>
      </Box>
      <Text color={preview.dim}>{tuiT('tui.panel.theme.footer')}</Text>
    </Box>
  )
}

/** 二次确认（原型 46/59 敏感项）：默认否防手滑（crush quit.go:20 同族）· Esc=否 */
function ConfirmPanel({ store, s }: { store: TuiStore; s: TuiState }): React.ReactElement {
  const ov = s.overlay
  if (ov.kind !== 'confirm') return <Box />
  const p = ov.pending
  const color = p.danger ? DEEP_SPACE.warn : DEEP_SPACE.accent
  useStableInput((_input, key) => {
    if (key.upArrow || key.downArrow) {
      store.patch({ overlay: { kind: 'confirm', pending: { ...p, selected: (p.selected + 1) % p.choices.length } } })
      return
    }
    if (key.return) { p.resolve(p.choices[p.selected]!.key); return }
    if (key.escape) { p.resolve('no'); return }
  })
  return (
    <Box {...panel(color)}>
      <Text color={color} bold>{p.danger ? '⚠ ' : '? '}{p.message}</Text>
      {p.choices.map((c, i) => (
        <Text key={c.key} color={i === p.selected ? color : DEEP_SPACE.muted}>
          {i === p.selected ? glyphs().pointer + ' ' : '  '}{c.label}
        </Text>
      ))}
      <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.confirm.footer')}</Text>
    </Box>
  )
}

/** 配置面板（原型 59）：三种值控件 × 改即存（toggle 翻转 / 循环选择 / 数字步进 / 主题跳转）——无保存按钮地狱 */
function ConfigPanel({ runtime, s }: { runtime: TuiRuntime; s: TuiState }): React.ReactElement {
  const [sel, setSel] = useState(0)
  const snap = runtime.configSnapshot()
  const thinking = snap.thinking === true || snap.thinking === 'true'
  const lang = tuiLang() // 实际生效语言（settings 缺省时 = 向导 locale——显示与真实一致）
  const ctxLimitRaw = Number(snap.contextLimit)
  const ctxLimit = Number.isFinite(ctxLimitRaw) && ctxLimitRaw >= 4096 ? ctxLimitRaw : 0
  const voiceSpeak = snap.voiceAutoSpeak === true || snap.voiceAutoSpeak === 'true'
  const rows = 7
  useStableInput((_input, key) => {
    if (key.upArrow) {
      // contextLimit 数字控件（原型 59：↑↓ 步进 8k——改即存，下回合经 maxContextTokens 真实消费）
      if (sel === 5) { runtime.setContextLimit(ctxLimit + 8_192); return }
      setSel(i => (i + rows - 1) % rows)
      return
    }
    if (key.downArrow) {
      if (sel === 5) { runtime.setContextLimit(ctxLimit - 8_192); return }
      setSel(i => (i + 1) % rows)
      return
    }
    if (key.escape) { runtime.closeConfigPanel(); return }
    if (!key.return) return
    switch (sel) {
      case 0: runtime.toggleThinking(); return
      case 1: {
        // 2026-09-03 用户裁决：模式全部经 /perm 选择器进入——配置面板不再 Enter 循环档位，直接打开选择器
        runtime.closeConfigPanel()
        runtime.openModePicker()
        return
      }
      case 2: runtime.toggleLang(); return
      case 3: runtime.closeConfigPanel(); runtime.openThemePicker(); return
      case 4: runtime.closeConfigPanel(); runtime.openModelPicker(); return
      case 6: runtime.toggleVoiceSpeak(); return
      default: return
    }
  })
  const row = (i: number, label: string, value: React.ReactNode, ctl: string): React.ReactElement => (
    <Text key={label} color={i === sel ? DEEP_SPACE.accent : DEEP_SPACE.muted}>
      {i === sel ? glyphs().pointer + ' ' : '  '}
      <Text bold={i === sel}>{label}</Text>
      {'  '}
      {value}
      <Text color={DEEP_SPACE.dim}>  — {fit(ctl, 8)}</Text>
    </Text>
  )
  return (
    <Box {...panel(DEEP_SPACE.accent)}>
      <Text color={DEEP_SPACE.accent} bold>◆ {tuiT('tui.panel.config.name')} · <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.config.titleHint')}</Text></Text>
      {row(0, tuiT('tui.panel.config.thinking'), <Text color={thinking ? DEEP_SPACE.success : DEEP_SPACE.muted}>{thinking ? 'on' : 'off'}</Text>, tuiT('tui.panel.config.thinkingCtl'))}
      {row(1, tuiT('tui.panel.config.mode'), <Text color={s.mode === 'yolo' || s.mode === 'auto' ? DEEP_SPACE.warn : DEEP_SPACE.success}>{s.mode}</Text>, tuiT('tui.panel.config.modeCtl'))}
      {row(2, tuiT('tui.panel.config.lang'), <Text color={DEEP_SPACE.success}>{lang}</Text>, tuiT('tui.panel.config.langCtl'))}
      {row(3, tuiT('tui.panel.config.theme'), <Text color={DEEP_SPACE.success}>{s.themeName}</Text>, tuiT('tui.panel.config.themeCtl'))}
      {row(4, tuiT('tui.panel.config.model'), <Text color={DEEP_SPACE.muted}>{s.model}</Text>, tuiT('tui.panel.config.modelCtl'))}
      {row(5, tuiT('tui.panel.config.ctx'), <Text color={ctxLimit > 0 ? DEEP_SPACE.success : DEEP_SPACE.dim}>{ctxLimit > 0 ? `${ctxLimit / 1024}k` : tuiT('tui.panel.config.defaultLimit')}</Text>, tuiT('tui.panel.config.ctxCtl'))}
      {row(6, tuiT('tui.panel.config.voice'), <Text color={voiceSpeak ? DEEP_SPACE.success : DEEP_SPACE.muted}>{voiceSpeak ? 'on' : 'off'}</Text>, tuiT('tui.panel.config.voiceCtl'))}
      <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.config.footer')}</Text>
    </Box>
  )
}

/** 自定义接口表单（原型 58 完整版）：三字段 Tab 轮换 · Ctrl+T 测试连接（SSRF 防护）· Key 粘贴即掩码 · Esc 取消零残留 */
function ModelFormPanel({ runtime }: { runtime: TuiRuntime }): React.ReactElement {
  const [name, setName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [focus, setFocus] = useState(0)
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; models?: string[]; error?: string }>({ state: 'idle' })
  useStableInput((input, key) => {
    if (key.tab) { setFocus(f => (f + 1) % 3); return }
    if (key.ctrl && (input === 't' || input === 'T')) {
      // 测试连接（原型 58 三态：◐ 探测 → ✓ N 模型 / ✗ 原因；6s 超时 fail-closed——网络在 cli）
      const url = baseURL.trim()
      if (!/^https:\/\//.test(url)) {
        setTest({ state: 'fail', error: tuiT('tui.panel.form.httpsRequired') })
        return
      }
      setTest({ state: 'testing' })
      void runtime.probeEndpoint(url, apiKey).then(r => {
        setTest(r.ok ? { state: 'ok', models: r.models ?? [] } : { state: 'fail', error: r.error ?? tuiT('tui.panel.form.probeFailed') })
      })
      return
    }
    if (key.escape) { runtime.closeModelForm(); return }
    if (key.return) {
      if (focus === 2) { runtime.submitModelForm({ name, baseURL, key: apiKey }); return }
      setFocus(f => f + 1)
      return
    }
    if (key.backspace || key.delete) {
      if (focus === 0) setName(v => v.slice(0, -1))
      else if (focus === 1) setBaseURL(v => v.slice(0, -1))
      else setApiKey(v => v.slice(0, -1))
      return
    }
    if (!key.ctrl && !key.meta && input) {
      if (focus === 0) setName(v => v + input)
      else if (focus === 1) setBaseURL(v => v + input)
      else setApiKey(v => v + input)
    }
  })
  const field = (i: number, label: string, value: string, mask: boolean): React.ReactElement => (
    <Text key={label} color={i === focus ? DEEP_SPACE.accent : DEEP_SPACE.muted}>
      {i === focus ? glyphs().pointer + ' ' : '  '}
      {label}：{mask ? glyphs().mask.repeat(Math.min(16, value.length)) : value}
      {i === focus ? <Text color={DEEP_SPACE.accent}>{glyphs().caret}</Text> : null}
    </Text>
  )
  return (
    <Box {...panel(DEEP_SPACE.accent)}>
      <Text color={DEEP_SPACE.accent} bold>◆ {tuiT('tui.panel.form.name')} · <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.form.titleHint')}</Text></Text>
      {field(0, tuiT('tui.panel.form.fieldName'), name, false)}
      {field(1, 'Base URL', baseURL, false)}
      {field(2, 'API Key', apiKey, true)}
      <Text color={DEEP_SPACE.muted}>
        {test.state === 'testing' ? <Text color={DEEP_SPACE.violet}>{tuiT('tui.panel.form.testing')}</Text>
          : test.state === 'ok' ? <Text color={DEEP_SPACE.success}>{tuiT('tui.panel.form.ok', { n: test.models!.length, list: test.models!.length > 0 ? `：${test.models!.slice(0, 4).join(' · ')}` : '' })}</Text>
          : test.state === 'fail' ? <Text color={DEEP_SPACE.error}>✗ {test.error}</Text>
          : <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.form.idle')}</Text>}
      </Text>
      <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.form.footer')}</Text>
    </Box>
  )
}

/** 帮助（原型 11 + 53 全景索引）：第 1 页快捷分组 · 第 2 页全量索引（分组滚动） */
/** 压缩三选（原型 32：上下文超额三级选择——micro 推荐/全量/不压缩；水印条变紫 + 超时回退默认） */
function CompactPanel({ store, s }: { store: TuiStore; s: TuiState }): React.ReactElement {
  const ov = s.overlay
  if (ov.kind !== 'compact') return <Box />
  const p = ov.pending
  const pct = Math.round(p.ratio * 100)
  useStableInput((_input, key) => {
    if (key.upArrow) { store.patch({ overlay: { kind: 'compact', pending: { ...p, selected: (p.selected + p.choices.length - 1) % p.choices.length } } }); return }
    if (key.downArrow) { store.patch({ overlay: { kind: 'compact', pending: { ...p, selected: (p.selected + 1) % p.choices.length } } }); return }
    if (key.return) { p.resolve(p.choices[p.selected]!.key as 'micro' | 'full' | 'none'); return }
    if (key.escape) { p.resolve('none'); return }
  })
  const filled = Math.round(p.ratio * 10)
  return (
    <Box {...panel(DEEP_SPACE.violet)}>
      <Text color={DEEP_SPACE.violet} bold>{tuiT('tui.panel.compact.title', { used: p.used.toLocaleString(), limit: p.limit.toLocaleString(), pct })}</Text>
      <Text color={DEEP_SPACE.dim}>{'█'.repeat(filled)}{'░'.repeat(Math.max(0, 10 - filled))}</Text>
      {p.choices.map((c, i) => (
        <Box key={c.key} flexDirection="column">
          <Text color={i === p.selected ? DEEP_SPACE.violet : DEEP_SPACE.muted}>
            {i === p.selected ? glyphs().pointer + ' ' : '  '}{c.label}
          </Text>
          <Text color={DEEP_SPACE.dim}>    {c.desc}</Text>
        </Box>
      ))}
      <Text color={DEEP_SPACE.dim}>{fit(tuiT('tui.panel.compact.footer'))}</Text>
    </Box>
  )
}

/** 回滚时间线（原型 28：只列 user 消息 · 影响统计先行 · 双路回滚经 /undo N 内核命令面） */
function RewindPanel({ runtime, rows = 24 }: { runtime: TuiRuntime; rows?: number }): React.ReactElement {
  const [sel, setSel] = useState(0)
  const msgs = runtime.sessionMessages() // 新的在前
  useStableInput((_input, key) => {
    if (key.upArrow) { setSel(i => (i + Math.max(1, msgs.length) - 1) % Math.max(1, msgs.length)); return }
    if (key.downArrow) { setSel(i => (i + 1) % Math.max(1, msgs.length)); return }
    if (key.escape) { runtime.closeRewindPanel(); return }
    if (key.return) {
      const hit = msgs[sel % Math.max(1, msgs.length)]
      if (!hit) return
      const turns = sel // 新的在前：选第 sel 条 → 丢弃其后 sel 条 = 回滚最近 sel 轮
      if (turns < 1) {
        runtime.closeRewindPanel()
        runtime.store.push({ kind: 'notice', text: tuiT('tui.panel.rewind.latest') })
        return
      }
      runtime.requestUndo(turns, { messages: turns })
      return
    }
  })
  if (msgs.length === 0) {
    return (
      <Box {...panel(DEEP_SPACE.accent)}>
        <Text color={DEEP_SPACE.accent} bold>◆ 回滚时间线 · <Text color={DEEP_SPACE.dim}>Esc 返回</Text></Text>
        <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.rewind.empty')}</Text>
      </Box>
    )
  }
  return (
    <Box {...panel(DEEP_SPACE.accent)}>
      <Text color={DEEP_SPACE.accent} bold>◆ {tuiT('tui.panel.rewind.name')} · <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.rewind.titleHint')}</Text></Text>
      {msgs.slice(0, overlayListMax('rewind', rows)).map((m, i) => {
        const on = i === sel % Math.max(1, msgs.length)
        const after = i // 该条之后的用户消息数 = 回滚将丢弃的轮次
        return (
          <Text key={`${m.runNo}-${i}`} color={on ? DEEP_SPACE.accent : DEEP_SPACE.muted}>
            {on ? glyphs().pointer + ' ' : '  '}
            <Text color={DEEP_SPACE.dim}>{new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false })}</Text>
            {'  '}{fit(m.preview.slice(0, 36), 10)}
            {after > 0 ? <Text color={DEEP_SPACE.warn}>{tuiT('tui.panel.rewind.dropN', { n: after })}</Text> : <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.rewind.toPoint')}</Text>}
          </Text>
        )
      })}
      <Text color={DEEP_SPACE.dim}>{fit(tuiT('tui.panel.rewind.footer'))}</Text>
    </Box>
  )
}

/** 计划提案（原型 06：紫罗兰计划卡——Enter 批准 · E 编辑 · Esc 返回；批准前零副作用由内核零工具闸保证） */
function PlanPanel({ s }: { s: TuiState }): React.ReactElement {
  const ov = s.overlay
  if (ov.kind !== 'plan') return <Box />
  const p = ov.pending
  const head = p.text.split('\n').slice(0, 6)
  useStableInput((input, key) => {
    if (key.return) { p.resolve('approve'); return }
    if (key.escape) { p.resolve('cancel'); return }
    if (input === 'e' || input === 'E') { p.resolve('edit'); return }
  })
  return (
    <Box {...panel(DEEP_SPACE.violet)}>
      <Text color={DEEP_SPACE.violet} bold>{tuiT('tui.panel.plan.title')}</Text>
      {head.map((l, i) => (
        <Text key={i} color={DEEP_SPACE.muted}>{l.slice(0, 72)}</Text>
      ))}
      {p.text.length > 380 ? <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.plan.abbrev')}</Text> : null}
      <Text color={DEEP_SPACE.violet}>{tuiT('tui.panel.plan.approve')}</Text>
      <Text color={DEEP_SPACE.muted}>  {tuiT('tui.panel.plan.edit')}</Text>
      <Text color={DEEP_SPACE.muted}>  {tuiT('tui.panel.plan.back')}</Text>
      <Text color={DEEP_SPACE.dim}>{fit(tuiT('tui.panel.plan.footer'))}</Text>
    </Box>
  )
}

/** 计划编辑（原型 06 E 编辑计划：Shift+Enter 换行 · Enter 确认执行 · Esc 取消）
 *  草稿预填原计划（编辑语义——此前空草稿：直接 Enter 会 resolve null = 计划被取消，用户须重打全文） */
function PlanEditPanel({ s }: { s: TuiState }): React.ReactElement {
  const ov = s.overlay
  const [draft, setDraft] = useState<string | null>(null)
  if (ov.kind !== 'planedit') return <Box />
  const p = ov.pending
  const current = draft ?? p.text // 首次渲染预填原计划
  useStableInput((input, key) => {
    if (key.return) {
      if (key.shift) { setDraft(current + '\n'); return }
      p.resolve(current.trim() || null)
      return
    }
    if (key.escape) { p.resolve(null); return }
    if (key.backspace || key.delete) { setDraft(current.slice(0, -1)); return }
    if (!key.ctrl && !key.meta && input) setDraft(current + input)
  })
  const lines = current.split('\n').slice(-6)
  return (
    <Box {...panel(DEEP_SPACE.violet)}>
      <Text color={DEEP_SPACE.violet} bold>✎ <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.planedit.titleHint')}</Text></Text>
      <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.planedit.prefilled')}</Text>
      {lines.map((l, i) => (
        <Text key={i} color={DEEP_SPACE.muted}>{i === lines.length - 1 ? glyphs().prompt + ' ' : '  '}{l}{i === lines.length - 1 ? <Text color={DEEP_SPACE.violet}>{glyphs().caret}</Text> : null}</Text>
      ))}
      <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.planedit.footer')}</Text>
    </Box>
  )
}

/** 语音面板（原型 34：录音态波形 + 转写态 + 免打扰说明——全链在 kernel：ffmpeg 采集 + whisper/SAPI 转写 + SAPI 播报） */
function VoicePanel({ runtime, s }: { runtime: TuiRuntime; s: TuiState }): React.ReactElement {
  const v = s.voice
  useStableInput((_input, key) => {
    if (key.escape) { runtime.cancelVoice(); return }
    if (key.return && v.state === 'recording') { void runtime.stopVoiceAndTranscribe(); return }
  })
  const wave = ['▂▃▅▂▇▃▂▅', '▃▅▇▃▂▅▂▇', '▅▂▃▇▅▃▂▂', '▂▇▅▃▂▇▅▃']
  const frame = wave[Math.floor(Date.now() / 200) % wave.length]!
  const mm = String(Math.floor(v.seconds / 60)).padStart(2, '0')
  const ss = String(v.seconds % 60).padStart(2, '0')
  return (
    <Box {...panel(DEEP_SPACE.violet)}>
      {v.state === 'recording' ? (
        <>
          <Text color={DEEP_SPACE.error}>{tuiT('tui.panel.voice.recording', { mmss: `${mm}:${ss}`, frame })}</Text>
          <Text color={DEEP_SPACE.muted}>{tuiT('tui.panel.voice.recHint')}</Text>
          <Text color={DEEP_SPACE.dim}>{fit(tuiT('tui.panel.voice.stopHint'))}</Text>
        </>
      ) : (
        <>
          <Text color={DEEP_SPACE.violet}>{tuiT('tui.panel.voice.transcribing')}</Text>
          <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.voice.transHint')}</Text>
        </>
      )}
      <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.voice.footer')}</Text>
    </Box>
  )
}

/** 快捷键速查（原型 30）：双列动态生成（KEY_SECTIONS 单一事实来源——键位改动一处生效） */
function KeysPanel({ runtime }: { runtime: TuiRuntime }): React.ReactElement {
  useStableInput((_input, key) => {
    if (key.escape) runtime.closeKeysPanel() // 仅 Esc 关闭——Enter 不再吞面板（提示文案如实）
  })
  const sections = keySections() // 渲染期构建——/lang 即切（模块级常量会冻结导入时语言）
  const cols = Math.ceil(sections.length / 2)
  return (
    <Box {...panel(DEEP_SPACE.accent)}>
      <Text color={DEEP_SPACE.accent} bold>? {tuiT('tui.panel.keys.name')} · <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.keys.titleHint')}</Text></Text>
      <Box flexDirection="row" gap={4}>
        {[sections.slice(0, cols), sections.slice(cols)].map((side, si) => (
          <Box key={si} flexDirection="column">
            {side.map(sec => (
              <Box key={sec.title} flexDirection="column" marginTop={si === 0 && side.indexOf(sec) === 0 ? 0 : 0}>
                <Text color={DEEP_SPACE.violet}>◆ {sec.title}</Text>
                {sec.rows.map(([k, d]) => (
                  <Text key={k} color={DEEP_SPACE.muted}>
                    <Text color={DEEP_SPACE.accent}>{k}</Text>{'  '}
                    <Text color={DEEP_SPACE.dim}>{d}</Text>
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function HelpPanel({ runtime, rows = 24 }: { runtime: TuiRuntime; rows?: number }): React.ReactElement {
  // 页序（2026-09-03 用户裁决：打开即全景索引——全部命令第一眼可见；Tab → 快捷分组 → 联动图谱）
  const [page, setPage] = useState(0)
  const [scroll, setScroll] = useState(0)
  const index = runtime.commandIndex()
  const groups = groupCommands(index)
  const total = index.length
  // 第 2 页行计划：组头 + 条目（滚动窗口）
  const flat: Array<{ kind: 'head' | 'item'; label: string; item?: IndexCommand }> = []
  for (const g of groups) {
    flat.push({ kind: 'head', label: g.label })
    for (const it of g.items) flat.push({ kind: 'item', label: it.cmd, item: it })
  }
  const VIEW = overlayListMax('help', rows)
  const maxScroll = Math.max(0, flat.length - VIEW)

  useStableInput((_input, key) => {
    if (key.escape) { runtime.toggleHelp(); return } // 仅 Esc 关闭——Enter 不再吞面板（提示文案如实）
    if (key.tab || key.pageDown || key.pageUp) { setPage(p => (p + 1) % 3); setScroll(0); return }
    if (key.upArrow) { setScroll(s => Math.max(0, s - 1)); return }
    if (key.downArrow) { setScroll(s => Math.min(maxScroll, s + 1)); return }
  })

  // 渲染期构建（/lang 即切）——快捷分组：组名与描述全部经 tuiT
  const quickCols: Array<[string, Array<[string, string]>]> = [
    [tuiT('tui.help.g.session'), [['/new /resume', tuiT('tui.help.session.1')], ['/sessions', tuiT('tui.help.session.2')], ['/undo', tuiT('tui.help.session.3')], ['/export', tuiT('tui.help.session.4')]]],
    [tuiT('tui.help.g.model'), [['/model', tuiT('tui.help.model.1')], ['/offline', tuiT('tui.help.model.2')], ['/thinking', tuiT('tui.help.model.3')], ['/status', tuiT('tui.help.model.4')]]],
    [tuiT('tui.help.g.memory'), [['/memory', tuiT('tui.help.memory.1')], ['/hole', tuiT('tui.help.memory.2')], ['/compact', tuiT('tui.help.memory.3')], ['/digest', tuiT('tui.help.memory.4')]]],
    [tuiT('tui.help.g.security'), [['/perm', tuiT('tui.help.security.1')], ['/sandbox', tuiT('tui.help.security.2')], ['/audit', tuiT('tui.help.security.3')], ['/security', tuiT('tui.help.security.4')]]],
    [tuiT('tui.help.g.build'), [['/build', tuiT('tui.help.build.1')], ['/evidence', tuiT('tui.help.build.2')], ['/doctor', tuiT('tui.help.build.3')], ['/bundle', tuiT('tui.help.build.4')]]],
    [tuiT('tui.help.g.system'), [['/theme', tuiT('tui.help.system.1')], ['/config', tuiT('tui.help.system.2')], ['/usage', tuiT('tui.help.system.3')], ['/logs', tuiT('tui.help.system.4')]]],
  ]

  // 原型 56 联动图谱（状态机规格压缩为 7 主链——全部为已落地联动；未落地链如实标注 fence）
  const LINKAGE: Array<[string, string]> = [
    ['/model', tuiT('tui.help.link.model')],
    ['/theme · /config', tuiT('tui.help.link.persist')],
    [tuiT('tui.help.link.approvalHead'), tuiT('tui.help.link.approval')],
    [tuiT('tui.help.link.runningHead'), tuiT('tui.help.link.running')],
    [tuiT('tui.help.link.subagentHead'), tuiT('tui.help.link.subagent')],
    [tuiT('tui.help.link.jobsHead'), tuiT('tui.help.link.jobs')],
    [tuiT('tui.help.link.errorHead'), tuiT('tui.help.link.error')],
  ]

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={DEEP_SPACE.accent} paddingX={1} marginY={1}>
      <Text color={DEEP_SPACE.accent} bold>
        {page === 0
          ? <Text>{tuiT('tui.panel.help.title1', { n: total })}</Text>
          : page === 1
            ? <Text>{tuiT('tui.panel.help.title0')}</Text>
            : <Text>{tuiT('tui.panel.help.title2')}</Text>}
      </Text>
      {page === 0 ? (
        <Box flexDirection="column">
          {flat.slice(scroll, scroll + VIEW).map((row, i) => row.kind === 'head'
            ? <Text key={`h${i}`} color={DEEP_SPACE.violet}>◆ {row.label}</Text>
            : <Text key={`i${i}`} color={DEEP_SPACE.muted}><Text color={DEEP_SPACE.fg}>{row.item!.cmd}</Text> {row.item!.desc}</Text>)}
        </Box>
      ) : page === 1 ? (
        <Box flexDirection="row" gap={4} flexWrap="wrap">
          {quickCols.map(([group, items]) => (
            <Box key={group} flexDirection="column" width={30}>
              <Text color={DEEP_SPACE.accent}>◆ {group}</Text>
              {items.map(([cmd, desc]) => (
                <Text key={cmd} color={DEEP_SPACE.muted}><Text color={DEEP_SPACE.fg}>{cmd}</Text> {desc}</Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          {LINKAGE.map(([head, body]) => (
            <Text key={head} color={DEEP_SPACE.muted}>
              <Text color={DEEP_SPACE.accent}>{head}</Text>
              <Text color={DEEP_SPACE.dim}>{body}</Text>
            </Text>
          ))}
          <Text color={DEEP_SPACE.dim}>{tuiT('tui.panel.help.rules')}</Text>
        </Box>
      )}
      <Text color={DEEP_SPACE.dim}>
        {page === 0 ? fit(tuiT('tui.panel.help.foot1', { a: Math.min(flat.length, scroll + VIEW), b: flat.length }), 4)
          : page === 1 ? fit(tuiT('tui.panel.help.foot0'), 4)
          : tuiT('tui.panel.help.foot2')}
      </Text>
    </Box>
  )
}
