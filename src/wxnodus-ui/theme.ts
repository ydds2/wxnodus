// src/wxnodus-ui/theme.ts — 主题 token 契约（10 内置预设 + dataDir 用户主题 + system 终端取色 + dark/light 双变体；语义色沿用基底）
import { existsSync, readdirSync, readFileSync } from 'node:fs'

export interface ThemeColors {
  primary: string
  accent: string
  border: string
  text: string
  muted: string
  completionBg: string
  completionCurrentBg: string
  completionMetaBg: string
  completionMetaCurrentBg: string

  label: string
  ok: string
  error: string
  warn: string

  prompt: string
  sessionLabel: string
  sessionBorder: string

  statusBg: string
  statusFg: string
  statusGood: string
  statusWarn: string
  statusBad: string
  statusCritical: string
  selectionBg: string

  diffAdded: string
  diffRemoved: string
  diffAddedWord: string
  diffRemovedWord: string

  shellDollar: string

  userBg: string
}

export interface ThemeBrand {
  name: string
  icon: string
  prompt: string
  welcome: string
  goodbye: string
  tool: string
  helpHeader: string
}

export interface Theme {
  color: ThemeColors
  brand: ThemeBrand
  bannerLogo: string
  bannerHero: string
}

// ── Color math ───────────────────────────────────────────────────────

function parseHex(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(h)

  if (!m) {
    return null
  }

  const n = parseInt(m[1]!, 16)

  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

export function mix(a: string, b: string, t: number) {
  const pa = parseHex(a)
  const pb = parseHex(b)

  if (!pa || !pb) {
    return a
  }

  const lerp = (i: 0 | 1 | 2) => Math.round(pa[i] + (pb[i] - pa[i]) * t)

  return '#' + ((1 << 24) | (lerp(0) << 16) | (lerp(1) << 8) | lerp(2)).toString(16).slice(1)
}

const XTERM_6_LEVELS = [0, 95, 135, 175, 215, 255] as const
const ANSI_LIGHT_MAX_LUMINANCE = 0.72
const ANSI_LIGHT_TARGET_LUMINANCE = 0.34
const ANSI_LIGHT_MIN_SATURATION = 0.22
const ANSI_MUTED_BUCKET = 245

const ANSI_NORMALIZED_FOREGROUNDS: readonly (keyof ThemeColors)[] = [
  'text',
  'label',
  'ok',
  'error',
  'warn',
  'prompt',
  'statusFg',
  'statusGood',
  'statusWarn',
  'statusBad',
  'statusCritical',
  'shellDollar'
]

const ANSI_MUTED_FOREGROUNDS: readonly (keyof ThemeColors)[] = ['muted', 'sessionLabel', 'sessionBorder']

function xtermEightBitRgb(colorNumber: number): [number, number, number] {
  if (colorNumber >= 232) {
    const value = 8 + (colorNumber - 232) * 10

    return [value, value, value]
  }

  if (colorNumber >= 16) {
    const offset = colorNumber - 16

    return [
      XTERM_6_LEVELS[Math.floor(offset / 36) % 6]!,
      XTERM_6_LEVELS[Math.floor(offset / 6) % 6]!,
      XTERM_6_LEVELS[offset % 6]!
    ]
  }

  return [0, 0, 0]
}

function channelLuminance(value: number): number {
  const normalized = value / 255

  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * channelLuminance(red) + 0.7152 * channelLuminance(green) + 0.0722 * channelLuminance(blue)
}

function rgbToHsl(red: number, green: number, blue: number): [number, number, number] {
  const rn = red / 255
  const gn = green / 255
  const bn = blue / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const lightness = (max + min) / 2

  if (max === min) {
    return [0, 0, lightness]
  }

  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)

  const hue =
    max === rn
      ? (gn - bn) / delta + (gn < bn ? 6 : 0)
      : max === gn
        ? (bn - rn) / delta + 2
        : (rn - gn) / delta + 4

  return [hue / 6, saturation, lightness]
}

function circularDistance(a: number, b: number): number {
  const distance = Math.abs(a - b)

  return Math.min(distance, 1 - distance)
}

// Mirrors @wxnodus/ink's colorize.ts. Keep local: app code compiles from
// ui-tui/src, while @wxnodus/ink is bundled separately from packages/.
function richEightBitColorNumber(red: number, green: number, blue: number): number {
  const [, saturation, lightness] = rgbToHsl(red, green, blue)

  if (saturation < 0.15) {
    const gray = Math.round(lightness * 25)

    return gray === 0 ? 16 : gray === 25 ? 231 : 231 + gray
  }

  const sixRed = red < 95 ? red / 95 : 1 + (red - 95) / 40
  const sixGreen = green < 95 ? green / 95 : 1 + (green - 95) / 40
  const sixBlue = blue < 95 ? blue / 95 : 1 + (blue - 95) / 40

  return 16 + 36 * Math.round(sixRed) + 6 * Math.round(sixGreen) + Math.round(sixBlue)
}

function bestReadableAnsiColor(red: number, green: number, blue: number): number {
  const [hue, saturation, lightness] = rgbToHsl(red, green, blue)
  let bestColor = richEightBitColorNumber(red, green, blue)
  let bestScore = Number.POSITIVE_INFINITY

  for (let colorNumber = 16; colorNumber <= 255; colorNumber += 1) {
    const [candidateRed, candidateGreen, candidateBlue] = xtermEightBitRgb(colorNumber)
    const candidateLuminance = relativeLuminance(candidateRed, candidateGreen, candidateBlue)

    if (candidateLuminance > ANSI_LIGHT_MAX_LUMINANCE) {
      continue
    }

    const [candidateHue, candidateSaturation, candidateLightness] = rgbToHsl(
      candidateRed,
      candidateGreen,
      candidateBlue
    )

    const saturationFloorPenalty =
      candidateSaturation < ANSI_LIGHT_MIN_SATURATION ? (ANSI_LIGHT_MIN_SATURATION - candidateSaturation) * 3 : 0

    const score =
      circularDistance(candidateHue, hue) * 4 +
      Math.abs(candidateSaturation - Math.max(ANSI_LIGHT_MIN_SATURATION, saturation)) * 0.8 +
      Math.abs(candidateLightness - Math.min(lightness, ANSI_LIGHT_TARGET_LUMINANCE)) * 2 +
      saturationFloorPenalty

    if (score < bestScore) {
      bestColor = colorNumber
      bestScore = score
    }
  }

  return bestColor
}

function normalizeAnsiForeground(color: string): string {
  const rgb = parseHex(color)

  if (!rgb) {
    return color
  }

  const richAnsi = richEightBitColorNumber(rgb[0], rgb[1], rgb[2])
  const richRgb = xtermEightBitRgb(richAnsi)

  const ansi = relativeLuminance(richRgb[0], richRgb[1], richRgb[2]) > ANSI_LIGHT_MAX_LUMINANCE
    ? bestReadableAnsiColor(rgb[0], rgb[1], rgb[2])
    : richAnsi

  return `ansi256(${ansi})`
}

// ── Defaults ─────────────────────────────────────────────────────────
// WxNodus 品牌：黑洞引擎（事件视界辉光）
// 配色概念：深空背景 × 电光青主色（吸积盘辉光）× 紫罗兰点缀（事件视界）
const BRAND: ThemeBrand = {
  name: 'WxNodus V3',
  icon: '◉',
  prompt: '❯',
  welcome: 'Windows 本地 AI agent CLI',
  goodbye: '再见！◉',
  tool: '┊',
  helpHeader: '◉ 命令 · 自然语言直达'
}

const cleanPromptSymbol = (s: string | undefined, fallback: string) => {
  const cleaned = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned || fallback
}

export const DARK_THEME: Theme = {
  color: {
    // 黑洞引擎：电光青（吸积盘辉光）× 紫罗兰（事件视界）× 深空冷白
    primary: '#00E5FF',
    accent: '#B388FF',
    border: '#26A69A',
    text: '#E0F7FA',
    muted: '#80CBC4',
    completionBg: '#0B0F19',
    completionCurrentBg: '#1E2A4A',
    completionMetaBg: '#0B0F19',
    completionMetaCurrentBg: '#1E2A4A',

    label: '#4DD0E1',
    ok: '#66BB6A',
    error: '#EF5350',
    warn: '#FFB74D',

    prompt: '#E0F7FA',
    // sessionLabel/sessionBorder intentionally track the `dim` value — they
    // are "same role, same colour" by design.  fromSkin's banner_dim fallback
    // relies on this pairing (#11300).
    sessionLabel: '#80CBC4',
    sessionBorder: '#80CBC4',

    // 状态栏底条：深空背景向事件视界紫轻微倾斜（赛博深空——比纯背景亮一档，
    // 底条与消息区有层次，但远低于 selectionBg 的选中亮度）
    statusBg: mix('#0B0F19', '#B388FF', 0.14),
    statusFg: '#9EA7B3',
    statusGood: '#4DD0E1',
    statusWarn: '#FFD54F',
    statusBad: '#FF8A65',
    statusCritical: '#FF6B6B',
    selectionBg: '#1E2A4A',

    diffAdded: 'rgb(220,255,220)',
    diffRemoved: 'rgb(255,220,220)',
    diffAddedWord: 'rgb(36,138,61)',
    diffRemovedWord: 'rgb(207,34,46)',
    shellDollar: '#4DD0E1',

    // 用户消息块底色：深空背景向事件视界紫轻微倾斜（吸积盘辉光意象），
    // 亮度足够低，长会话里不刺眼，仅把「用户提问」从正文中托出来
    userBg: mix('#0B0F19', '#B388FF', 0.16)
  },

  brand: BRAND,

  bannerLogo: '',
  bannerHero: ''
}

// Light-terminal palette: deeper teal/violet that stay legible on white
// backgrounds. Same shape as DARK_THEME so `fromSkin` still layers on top
// cleanly (#11300).
export const LIGHT_THEME: Theme = {
  color: {
    primary: '#00838F',
    accent: '#5E35B1',
    border: '#00695C',
    text: '#1C2B33',
    muted: '#4A6B74',
    completionBg: '#F0F6F7',
    completionCurrentBg: mix('#F0F6F7', '#00838F', 0.2),
    completionMetaBg: '#F0F6F7',
    completionMetaCurrentBg: mix('#F0F6F7', '#00838F', 0.2),

    label: '#00695C',
    ok: '#2E7D32',
    error: '#C62828',
    warn: '#E65100',

    prompt: '#142A33',
    sessionLabel: '#4A6B74',
    sessionBorder: '#4A6B74',

    statusBg: '#F0F6F7',
    statusFg: '#333F45',
    statusGood: '#00796B',
    statusWarn: '#8B6914',
    statusBad: '#D84315',
    statusCritical: '#B71C1C',
    selectionBg: '#D4E4F7',

    diffAdded: 'rgb(200,240,200)',
    diffRemoved: 'rgb(240,200,200)',
    diffAddedWord: 'rgb(27,94,32)',
    diffRemovedWord: 'rgb(183,28,28)',
    shellDollar: '#00695C',

    // 浅色终端：浅紫灰（lavender tint），白底上依然能看出用户块
    userBg: mix('#F0F6F7', '#5E35B1', 0.1)
  },

  brand: BRAND,

  bannerLogo: '',
  bannerHero: ''
}

const TRUE_RE = /^(?:1|true|yes|on)$/
const FALSE_RE = /^(?:0|false|no|off)$/

// TERM_PROGRAM fallback allow-list for terminals whose default profile is
// light and which may not expose COLORFGBG. This currently includes Apple
// Terminal. Explicit WXNODUS_TUI_THEME / COLORFGBG signals above still win,
// so dark Apple Terminal profiles that advertise a dark background stay dark.
const LIGHT_DEFAULT_TERM_PROGRAMS = new Set<string>(['Apple_Terminal'])

// Best-effort RGB → luminance check.  Currently only accepts a 3- or
// 6-digit hex value (with or without a leading `#`); the env var name
// `WXNODUS_TUI_BACKGROUND` is intentionally generic so a future OSC11
// query helper can cache its answer there too, but additional formats
// (rgb()/hsl()/named colours) would need explicit parsing here first.
const LUMA_LIGHT_THRESHOLD = 0.6

// Strict allow-list: parseInt(..., 16) silently truncates at the first
// non-hex character (e.g. `fffgff` would parse as `fff` and yield a
// false-positive "white" reading), so reject anything that doesn't match
// the canonical 3- or 6-digit shape up front.
const HEX_3_RE = /^[0-9a-f]{3}$/
const HEX_6_RE = /^[0-9a-f]{6}$/

function backgroundLuminance(raw: string): null | number {
  const v = raw.trim().toLowerCase()

  if (!v) {
    return null
  }

  const hex = v.startsWith('#') ? v.slice(1) : v

  const rgb = HEX_6_RE.test(hex)
    ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    : HEX_3_RE.test(hex)
      ? [parseInt(hex[0]! + hex[0]!, 16), parseInt(hex[1]! + hex[1]!, 16), parseInt(hex[2]! + hex[2]!, 16)]
      : null

  if (!rgb) {
    return null
  }

  // Rec. 709 luma — close enough for "is this background bright".
  return (0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!) / 255
}

// Pick light vs dark with ordered, explainable signals (#11300):
//
//   1. `WXNODUS_TUI_LIGHT` boolean — `1`/`true`/`yes`/`on` → light;
//      `0`/`false`/`no`/`off` → dark.  Either explicit value wins
//      regardless of any later signal.
//   2. `WXNODUS_TUI_THEME` named override — `light` / `dark` win over
//      every signal below.
//   3. `WXNODUS_TUI_BACKGROUND` hex hint (3- or 6-digit) — luminance
//      ≥ LUMA_LIGHT_THRESHOLD → light.
//   4. `COLORFGBG` last field — XFCE / rxvt / Terminal.app emit
//      slot 7 or 15 on light profiles; 0–15 ranges are otherwise
//      treated as authoritatively dark so the TERM_PROGRAM
//      allow-list below cannot override an explicit dark profile.
//   5. `TERM_PROGRAM` light-default allow-list.
//
// Anything we can't decide stays dark — the default WxNodus palette
// is the dark one.
export function detectLightMode(
  env: NodeJS.ProcessEnv = process.env,
  // Injectable so tests can prove the COLORFGBG-over-TERM_PROGRAM
  // precedence rule even though the production allow-list is empty.
  lightDefaultTermPrograms: ReadonlySet<string> = LIGHT_DEFAULT_TERM_PROGRAMS
): boolean {
  const lightFlag = (env.WXNODUS_TUI_LIGHT ?? '').trim().toLowerCase()

  if (TRUE_RE.test(lightFlag)) {
    return true
  }

  if (FALSE_RE.test(lightFlag)) {
    return false
  }

  const themeFlag = (env.WXNODUS_TUI_THEME ?? '').trim().toLowerCase()

  if (themeFlag === 'light') {
    return true
  }

  if (themeFlag === 'dark') {
    return false
  }

  const bgHint = backgroundLuminance(env.WXNODUS_TUI_BACKGROUND ?? '')

  if (bgHint !== null) {
    return bgHint >= LUMA_LIGHT_THRESHOLD
  }

  const colorfgbg = (env.COLORFGBG ?? '').trim()

  if (colorfgbg) {
    // Validate as a decimal integer before coercing — `Number('')` is 0,
    // so a malformed `COLORFGBG='15;'` would otherwise look like an
    // authoritative dark slot and incorrectly block the TERM_PROGRAM
    // allow-list.  Anything that isn't pure digits falls through.
    const lastField = colorfgbg.split(';').at(-1) ?? ''

    if (/^\d+$/.test(lastField)) {
      const bg = Number(lastField)

      if (bg === 7 || bg === 15) {
        return true
      }

      // Slots 0–6 and 8–14 are the dark half of the 0–15 ANSI range.
      // When COLORFGBG is set we trust it as authoritative — a non-light
      // value here shouldn't get overridden by the TERM_PROGRAM allow-list.
      if (bg >= 0 && bg < 16) {
        return false
      }
    }
  }

  const termProgram = (env.TERM_PROGRAM ?? '').trim()

  return lightDefaultTermPrograms.has(termProgram)
}

function shouldNormalizeAnsiLightTheme(env: NodeJS.ProcessEnv = process.env, isLight = detectLightMode(env)): boolean {
  const colorTerm = (env.COLORTERM ?? '').trim().toLowerCase()
  const termProgram = (env.TERM_PROGRAM ?? '').trim()

  return termProgram === 'Apple_Terminal' && colorTerm !== 'truecolor' && colorTerm !== '24bit' && isLight
}

export function normalizeThemeForAnsiLightTerminal(
  theme: Theme,
  env: NodeJS.ProcessEnv = process.env,
  isLight = detectLightMode(env)
): Theme {
  if (!shouldNormalizeAnsiLightTheme(env, isLight)) {
    return theme
  }

  const color = { ...theme.color }

  for (const key of ANSI_NORMALIZED_FOREGROUNDS) {
    color[key] = normalizeAnsiForeground(color[key])
  }

  for (const key of ANSI_MUTED_FOREGROUNDS) {
    color[key] = `ansi256(${ANSI_MUTED_BUCKET})`
  }

  return { ...theme, color }
}

const DEFAULT_LIGHT_MODE = detectLightMode()

export const DEFAULT_THEME: Theme = normalizeThemeForAnsiLightTerminal(
  DEFAULT_LIGHT_MODE ? LIGHT_THEME : DARK_THEME,
  process.env,
  DEFAULT_LIGHT_MODE
)

// ── 主题预设（B-04，opencode 33 套对标——诚实口径：10 套命名预设，非 33）──
// 预设 = 基底（dark/light）品牌三元组覆盖（primary/accent/border——吸积盘/边框/brandBar 视觉面）；
// 语义色（ok/error/warn/diff 等）沿用基底保证可读性契约不破。
export interface ThemePreset { name: string; base: 'dark' | 'light'; trio: { primary: string; accent: string; border: string }; /** 2026-08-19 token 双变体（opencode dark/light 变体对标）：可选浅色三色组——终端浅色模式（detectLightMode）时替换 trio 并切 LIGHT 基底；缺省=深色唯一（诚实：非全部预设都带双变体） */ light?: { primary: string; accent: string; border: string } }

export const THEME_PRESETS: Record<string, ThemePreset> = {
  nord: { name: 'nord', base: 'dark', trio: { primary: '#88C0D0', accent: '#81A1C1', border: '#5E81AC' } },
  dracula: { name: 'dracula', base: 'dark', trio: { primary: '#BD93F9', accent: '#FF79C6', border: '#6272A4' } },
  'tokyo-night': { name: 'tokyo-night', base: 'dark', trio: { primary: '#7DCFFF', accent: '#BB9AF7', border: '#565F89' } },
  monokai: { name: 'monokai', base: 'dark', trio: { primary: '#A6E22E', accent: '#F92672', border: '#75715E' } },
  gruvbox: { name: 'gruvbox', base: 'dark', trio: { primary: '#B8BB26', accent: '#FE8019', border: '#665C54' } },
  solarized: { name: 'solarized', base: 'dark', trio: { primary: '#268BD2', accent: '#B58900', border: '#586E75' }, light: { primary: '#268BD2', accent: '#CB4B16', border: '#93A1A1' } },
  'one-dark': { name: 'one-dark', base: 'dark', trio: { primary: '#61AFEF', accent: '#E06C75', border: '#3E4452' } },
  catppuccin: { name: 'catppuccin', base: 'dark', trio: { primary: '#89B4FA', accent: '#F38BA8', border: '#585B70' } },
  everforest: { name: 'everforest', base: 'dark', trio: { primary: '#A7C080', accent: '#E69875', border: '#4B565C' } },
  synthwave: { name: 'synthwave', base: 'dark', trio: { primary: '#F92AAD', accent: '#00F9FF', border: '#262335' } },
}

/** 预设名列表（/theme 命令与帮助展示） */
export const themePresetNames = (): string[] => ['dark', 'light', ...Object.keys(THEME_PRESETS)]

// ── 用户主题（2026-08-19 主题机制补齐，opencode themeSource.discover() 磁盘发现对标）──
// dataDir/themes/*.json：{ name, base: 'dark'|'light', trio: {primary, accent, border} }——与内置预设同构。
// 非法文件诚实跳过并收集警告（绝不半载入）；与内置预设同名 → 内置优先。
export interface UserThemeLoad { presets: Record<string, ThemePreset>; warnings: string[] }

const THEME_HEX = /^#[0-9a-fA-F]{6}$/

export function loadUserThemes(dataDir: string): UserThemeLoad {
  const presets: Record<string, ThemePreset> = {}
  const warnings: string[] = []
  const dir = `${String(dataDir).replace(/[\\/]$/, '')}/themes`
  try {
    if (!existsSync(dir)) return { presets, warnings }
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { name?: unknown; base?: unknown; trio?: unknown }
        const name = String(raw?.name ?? '').trim().toLowerCase()
        const base = raw?.base
        const trio = raw?.trio as Record<string, unknown> | undefined
        if (!/^[a-z0-9-]{1,40}$/.test(name)) { warnings.push(`${f}: 主题名非法（仅小写字母/数字/-，≤40）`); continue }
        if (THEME_PRESETS[name]) { warnings.push(`${f}: 与内置预设同名（${name}）——内置优先，跳过`); continue }
        if (base !== 'dark' && base !== 'light') { warnings.push(`${f}: base 必须是 dark|light`); continue }
        const primary = String(trio?.primary ?? '')
        const accent = String(trio?.accent ?? '')
        const border = String(trio?.border ?? '')
        if (!THEME_HEX.test(primary) || !THEME_HEX.test(accent) || !THEME_HEX.test(border)) { warnings.push(`${f}: trio 三色必须是 #RRGGBB`); continue }
        // 可选 token 双变体：light 字段存在则同规则校验
        let lightVariant: { primary: string; accent: string; border: string } | undefined
        const light = (raw as { light?: unknown }).light as Record<string, unknown> | null | undefined
        if (light !== undefined && light !== null) {
          const lp = String(light?.primary ?? '')
          const la = String(light?.accent ?? '')
          const lb = String(light?.border ?? '')
          if (!THEME_HEX.test(lp) || !THEME_HEX.test(la) || !THEME_HEX.test(lb)) { warnings.push(`${f}: light 三色必须是 #RRGGBB`); continue }
          lightVariant = { primary: lp, accent: la, border: lb }
        }
        presets[name] = { name, base, trio: { primary, accent, border }, ...(lightVariant ? { light: lightVariant } : {}) }
      } catch { warnings.push(`${f}: JSON 解析失败`) }
    }
  } catch { warnings.push('themes 目录读取失败') }
  return { presets, warnings }
}

/** 按名解析主题：dark/light → 基底；预设名 → 三元组覆盖（token 双变体：终端浅色模式 + 预设带 light 变体 → 切 LIGHT 基底 + light 三色）；用户主题（第三参）次之；未知 → null（调用方回退 DEFAULT_THEME） */
export function themeByName(name: string, env: NodeJS.ProcessEnv = process.env, user?: Record<string, ThemePreset>): Theme | null {
  const n = String(name ?? '').trim().toLowerCase()
  if (n === 'dark') return DARK_THEME
  if (n === 'light') return LIGHT_THEME
  const p = THEME_PRESETS[n] ?? user?.[n]
  if (!p) return null
  const lightVariant = p.light && detectLightMode(env)
  const base = lightVariant ? LIGHT_THEME : p.base === 'light' ? LIGHT_THEME : DARK_THEME
  const trio = lightVariant ? p.light! : p.trio
  const derived: Theme = {
    ...base,
    color: { ...base.color, primary: trio.primary, accent: trio.accent, border: trio.border },
  }
  return normalizeThemeForAnsiLightTerminal(derived, env)
}

// ── system 主题（2026-08-19 B-04 收口，opencode generateSystem 对标——终端取色生成）──

const sysParseTriple = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const sysToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const sysLuminance = (hex: string) => {
  const [r, g, b] = sysParseTriple(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** 终端前景/背景色 → 主题（纯函数）：背景亮度定基底（>0.5 → LIGHT），前景色作 primary，
 * accent = 前景背景中点色、border = 背景亮度偏置灰——语义色沿用基底（可读性契约不破）。 */
export function themeFromTerminalColors(colors: { fg: string; bg: string }): Theme {
  const base = sysLuminance(colors.bg) > 0.5 ? LIGHT_THEME : DARK_THEME;
  const [fr, fg, fb] = sysParseTriple(colors.fg);
  const [br, bg2, bb] = sysParseTriple(colors.bg);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const accent = sysToHex(mix(fr, br, 0.5), mix(fg, bg2, 0.5), mix(fb, bb, 0.5));
  const border = base === DARK_THEME ? sysToHex(mix(br, 255, 0.18), mix(bg2, 255, 0.18), mix(bb, 255, 0.18)) : sysToHex(mix(br, 0, 0.18), mix(bg2, 0, 0.18), mix(bb, 0, 0.18));
  const derived: Theme = {
    ...base,
    color: { ...base.color, primary: colors.fg, accent, border },
  };
  return normalizeThemeForAnsiLightTerminal(derived, process.env);
}

// ── Skin → Theme ─────────────────────────────────────────────────────

export function fromSkin(
  colors: Record<string, string>,
  branding: Record<string, string>,
  bannerLogo = '',
  bannerHero = '',
  toolPrefix = '',
  helpHeader = ''
): Theme {
  const d = DEFAULT_THEME
  const c = (k: string) => colors[k]
  const hasSkinColors = Object.keys(colors).length > 0

  const accent = c('ui_accent') ?? c('banner_accent') ?? d.color.accent
  const bannerAccent = c('banner_accent') ?? c('banner_title') ?? d.color.accent
  const muted = c('banner_dim') ?? d.color.muted
  const completionBg = c('completion_menu_bg') ?? d.color.completionBg

  const completionCurrentBg =
    c('completion_menu_current_bg') ??
    (hasSkinColors ? mix(completionBg, bannerAccent, 0.25) : d.color.completionCurrentBg)

  const completionMetaBg = c('completion_menu_meta_bg') ?? completionBg
  const completionMetaCurrentBg = c('completion_menu_meta_current_bg') ?? completionCurrentBg

  return normalizeThemeForAnsiLightTerminal({
    color: {
      primary: c('ui_primary') ?? c('banner_title') ?? d.color.primary,
      accent,
      border: c('ui_border') ?? c('banner_border') ?? d.color.border,
      text: c('ui_text') ?? c('banner_text') ?? d.color.text,
      muted,
      completionBg,
      completionCurrentBg,
      completionMetaBg,
      completionMetaCurrentBg,

      label: c('ui_label') ?? d.color.label,
      ok: c('ui_ok') ?? d.color.ok,
      error: c('ui_error') ?? d.color.error,
      warn: c('ui_warn') ?? d.color.warn,

      prompt: c('prompt') ?? c('banner_text') ?? d.color.prompt,
      sessionLabel: c('session_label') ?? muted,
      sessionBorder: c('session_border') ?? muted,

      statusBg: d.color.statusBg,
      statusFg: d.color.statusFg,
      statusGood: c('ui_ok') ?? d.color.statusGood,
      statusWarn: c('ui_warn') ?? d.color.statusWarn,
      statusBad: d.color.statusBad,
      statusCritical: d.color.statusCritical,
      selectionBg: c('selection_bg') ?? c('completion_menu_current_bg') ?? (hasSkinColors ? completionCurrentBg : d.color.selectionBg),

      diffAdded: d.color.diffAdded,
      diffRemoved: d.color.diffRemoved,
      diffAddedWord: d.color.diffAddedWord,
      diffRemovedWord: d.color.diffRemovedWord,
      shellDollar: c('shell_dollar') ?? d.color.shellDollar,

      userBg: c('user_bg') ?? (hasSkinColors ? mix(completionBg, bannerAccent, 0.16) : d.color.userBg)
    },

    brand: {
      name: branding.agent_name ?? d.brand.name,
      icon: d.brand.icon,
      prompt: cleanPromptSymbol(branding.prompt_symbol, d.brand.prompt),
      welcome: branding.welcome ?? d.brand.welcome,
      goodbye: branding.goodbye ?? d.brand.goodbye,
      tool: toolPrefix || d.brand.tool,
      helpHeader: branding.help_header ?? (helpHeader || d.brand.helpHeader)
    },

    bannerLogo,
    bannerHero
  }, process.env, DEFAULT_LIGHT_MODE)
}
