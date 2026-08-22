import { Box, Text, useStdout } from '@wxnodus/ink'
import { useEffect, useState } from 'react'
import unicodeSpinners from 'unicode-animations'

import { artWidth, logo, pixelLogo, pixelWordmark, PIXEL_LOGO_WIDTH, PIXEL_WORDMARK_WIDTH, type PixelRow } from '../banner.js'
import { FEATURE_SPOTLIGHTS } from '../content/features.js'
import { flat } from '../lib/text.js'
import { pushOverlay } from '../runtime/promptStore.js'
import type { Theme } from '../theme.js'
import type { PanelSection, SessionInfo } from '../types.js'
import { getTuiTerminalTier } from '../lib/terminalTier.js'
import { icon } from '../glyphs.js'

const LOADER_TICK_MS = 120

function InlineLoader({ label, t }: { label: string; t: Theme }) {
  const [tick, setTick] = useState(0)
  // W8-23：cmd 档用 ASCII 旋转帧（盲文在经典 conhost 字体无字形）
  const glyphSet = getTuiTerminalTier()?.capabilities.glyphSet ?? 'full'
  const spinner = glyphSet === 'full' ? unicodeSpinners.braille : { frames: ['|', '/', '-', '\\'], interval: 120 }
  const frame = spinner.frames[tick % spinner.frames.length] ?? '|'

  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), Math.max(LOADER_TICK_MS, spinner.interval))

    return () => clearInterval(id)
  }, [spinner.interval])

  return (
    <Text color={t.color.muted} wrap="truncate">
      <Text color={t.color.accent}>{frame}</Text> {label}
    </Text>
  )
}

export function ArtLines({ lines }: { lines: [string, string][] }) {
  return (
    <Box flexDirection="column" height={lines.length} opaque width={artWidth(lines)}>
      {lines.map(([c, text], i) => (
        <Text color={c} key={i} wrap="truncate-end">
          {text}
        </Text>
      ))}
    </Box>
  )
}

// 像素行渲染：每个字符格 = 一个背景色像素（空格 + backgroundColor），
// 零字形依赖——ASCII 图在 cmd 经典字体下错位的问题就此根除；
// 行内空格以 run 形式保留（bg 色包裹空格不裁剪）。
function PixelArt({ cols, rows }: { cols: number; rows: PixelRow[] }) {
  const w = rows.reduce((m, row) => Math.max(m, row.reduce((a, run) => a + run.n, 0)), 0)

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={i} width={cols} justifyContent="center">
          <Box flexDirection="row" width={w}>
            {row.map((run, j) =>
              run.bg ? (
                <Text backgroundColor={run.bg} key={j}>
                  {' '.repeat(run.n)}
                </Text>
              ) : (
                <Text key={j}>{' '.repeat(run.n)}</Text>
              )
            )}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

// Responsive Banner: 像素徽标（环+字标）→ 仅字标 → 文本 → 隐藏。
// 终端无法缩放字形，响应式 = 选择适配当前列宽的布局档位。
const TAG_FULL = '⚡ WxNodus ⚡'
const HIDE_BELOW = 34

export function Banner({ maxWidth, t }: { maxWidth?: number; t: Theme }) {
  const term = useStdout().stdout?.columns ?? 80
  const cols = Math.max(1, Math.min(term, maxWidth ?? term))

  if (cols < HIDE_BELOW) {
    return null
  }

  // 自定义皮肤 logo：沿用富文本行渲染（settings 皮肤注入，非默认路径）
  if (t.bannerLogo) {
    const lines = logo(t.color, t.bannerLogo)

    return (
      <Box flexDirection="column" marginBottom={1} width={cols} justifyContent="center">
        <ArtLines lines={lines} />
        <Text color={t.color.muted} wrap="truncate-end">
          {icon('brand')} {TAG_FULL}
        </Text>
      </Box>
    )
  }

  if (cols >= PIXEL_LOGO_WIDTH + 2) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <PixelArt cols={cols} rows={pixelLogo(t.color)} />
        <Box width={cols} justifyContent="center" marginTop={1}>
          <Text color={t.color.muted}>{t.brand.welcome}</Text>
        </Box>
      </Box>
    )
  }

  if (cols >= PIXEL_WORDMARK_WIDTH + 2) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <PixelArt cols={cols} rows={pixelWordmark(t.color)} />
        <Box width={cols} justifyContent="center" marginTop={1}>
          <Text color={t.color.muted}>{TAG_FULL}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={t.color.primary} wrap="truncate-end">
        {icon('brand')} {t.brand.name}
      </Text>
      <Text color={t.color.muted} wrap="truncate-end">
        {t.brand.welcome}
      </Text>
    </Box>
  )
}

// ── Collapsible helpers ──────────────────────────────────────────────

function CollapseToggle({
  count,
  open,
  suffix,
  t,
  title,
  onToggle
}: {
  count?: number
  open: boolean
  suffix?: string
  t: Theme
  title: string
  onToggle: () => void
}) {
  return (
    <Box onClick={onToggle}>
      <Text color={t.color.accent}>{open ? '▾ ' : '▸ '}</Text>
      <Text bold color={t.color.accent}>
        {title}
      </Text>
      {typeof count === 'number' ? (
        <Text color={t.color.muted}> ({count})</Text>
      ) : null}
      {suffix ? (
        <Text color={t.color.muted}> {suffix}</Text>
      ) : null}
    </Box>
  )
}

// ── SessionPanel ─────────────────────────────────────────────────────

const SKILLS_MAX = 8
const TOOLSETS_MAX = 8

export function SessionPanel({ info, maxWidth, onCommand, sid, t }: SessionPanelProps) {
  const term = useStdout().stdout?.columns ?? 100
  const cols = Math.max(20, Math.min(term, maxWidth ?? term))
  // 扁平无框（2026-08-19 mockup 极简对齐）：去掉英雄图 + 外框——像素徽标已由
  // Banner 居中展示，这里只留信息行与可折叠分区；留白 4 列防贴边。
  const w = Math.max(20, cols - 4)
  const lineBudget = Math.max(12, w - 2)
  const strip = (s: string) => (s.endsWith('_tools') ? s.slice(0, -6) : s)

  // ── Local collapse state for each section ──
  // 审查修复：工具墙默认折叠——新用户第一眼是几十个工具名（工具墙）而非「我能做什么」；
  // 特色能力（✅ 已默认展开）承担引导角色，工具名按需展开（行内提示 + 点击）
  const [toolsOpen, setToolsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [systemOpen, setSystemOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  // V4 UI 闭环（症状C）：特色能力默认收起（首屏仅「环境概览」一行摘要——10 条全铺过载）
  const [featuresOpen, setFeaturesOpen] = useState(false)
  // 环境概览总控（默认收起——首屏降噪主开关）
  const [overviewOpen, setOverviewOpen] = useState(false)

  const truncLine = (pfx: string, items: string[]) => {
    let line = ''
    let shown = 0

    for (const item of [...items].sort()) {
      const next = line ? `${line}, ${item}` : item

      if (pfx.length + next.length > lineBudget) {
        return line ? `${line}, …+${items.length - shown}` : `${item}, …`
      }

      line = next
      shown++
    }

    return line
  }

  // ── Collapsible skills section ──
  const skillEntries = Object.entries(info.skills).sort()
  const skillsTotal = flat(info.skills).length
  const skillsCatCount = skillEntries.length

  const skillsBody = () => {
    if (info.lazy && skillEntries.length === 0) {
      return <InlineLoader label="scanning skills" t={t} />
    }

    const shown = skillEntries.slice(0, SKILLS_MAX)
    const overflow = skillEntries.length - SKILLS_MAX

    return (
      <>
        {shown.map(([k, vs]) => (
          <Text key={k} wrap="truncate">
            <Text color={t.color.muted}>{strip(k)}: </Text>
            <Text color={t.color.text}>{truncLine(strip(k) + ': ', vs)}</Text>
          </Text>
        ))}
        {overflow > 0 && (
          <Text color={t.color.muted}>(and {overflow} more categories…)</Text>
        )}
      </>
    )
  }

  // ── Collapsible tools section ──
  const toolEntries = Object.entries(info.tools).sort()
  const toolsTotal = flat(info.tools).length

  const toolsBody = () => {
    const shown = toolEntries.slice(0, TOOLSETS_MAX)
    const overflow = toolEntries.length - TOOLSETS_MAX

    return (
      <>
        {shown.map(([k, vs]) => (
          <Text key={k} wrap="truncate">
            <Text color={t.color.muted}>{strip(k)}: </Text>
            <Text color={t.color.text}>{truncLine(strip(k) + ': ', vs)}</Text>
          </Text>
        ))}
        {overflow > 0 && (
          <Text color={t.color.muted}>(and {overflow} more toolsets…)</Text>
        )}
      </>
    )
  }

  // ── Collapsible MCP section ──
  const mcpBody = () => (
    <>
      {(info.mcp_servers ?? []).map(s => (
        <Text key={s.name} wrap="truncate">
          <Text color={t.color.muted}>{`  ${s.name} `}</Text>
          <Text color={t.color.muted}>{`[${s.transport}]`}</Text>
          <Text color={t.color.muted}>: </Text>
          {s.connected ? (
            <Text color={t.color.text}>
              {s.tools} tool{s.tools === 1 ? '' : 's'}
            </Text>
          ) : s.disabled || s.status === 'disabled' ? (
            <Text color={t.color.muted}>disabled</Text>
          ) : s.status === 'connecting' ? (
            <Text color={t.color.warn}>connecting</Text>
          ) : s.status === 'configured' ? (
            <Text color={t.color.muted}>configured</Text>
          ) : (
            <Text color={t.color.error}>failed</Text>
          )}
        </Text>
      ))}
    </>
  )

  // ── System prompt body ──
  const sysPromptLen = (info.system_prompt ?? '').length

  const systemBody = () => {
    if (sysPromptLen === 0) {
      return <Text color={t.color.muted}>No system prompt loaded.</Text>
    }

    return (
      <Text color={t.color.muted}>
        {info.system_prompt}
      </Text>
    )
  }

  return (
    // 极简扁平（2026-08-19 mockup 对齐）：无外框、无英雄图——徽标由 Banner 居中展示
    <Box flexDirection="column" marginBottom={1}>
      {/* 信息行居中：模型·版本（点开模型选择器） · 目录（点开目录选择器） */}
      <Box justifyContent="center">
        <Box flexDirection="row">
          <Box onClick={() => pushOverlay({ kind: 'modelPicker' })}>
            <Text color={t.color.accent} wrap="truncate-end">
              {info.model.split('/').pop()}
              {info.version ? ` v${info.version}` : ''}
            </Text>
          </Box>
          <Box onClick={() => pushOverlay({ kind: 'dirPicker' })}>
            <Text color={t.color.muted} wrap="truncate-end">
              {' · '}
              {info.cwd || process.cwd()}
            </Text>
          </Box>
        </Box>
      </Box>

      {sid && (
        <Box justifyContent="center">
          <Text wrap="truncate-end">
            <Text color={t.color.sessionLabel}>会话：</Text>
            <Text color={t.color.sessionBorder}>{sid}</Text>
          </Text>
        </Box>
      )}

      <Box flexDirection="column" width={w} marginTop={1}>

        {/* ── V4 UI 闭环（症状C 首屏降噪）：环境信息两级折叠 ──
            默认仅一行摘要（工具/技能/特色/MCP 计数）——首屏从 ~18 行降到 1 行；
            展开后才出现原五分区（工具/技能/特色/System Prompt/MCP）。
            用户实测反馈：启动面板信息过载（10 条特色全铺 + System Prompt 头行噪声）。 */}
        <CollapseToggle
          onToggle={() => setOverviewOpen(v => !v)}
          open={overviewOpen}
          suffix={`工具 ${toolsTotal} · 技能 ${skillsTotal} · 特色 ${FEATURE_SPOTLIGHTS.length}${info.mcp_servers?.length ? ` · MCP ${info.mcp_servers.length}` : ''} · /help 全览`}
          t={t}
          title="环境概览"
        />
        {overviewOpen && (
          <>

        {/* ── Tools ── */}
        <Box flexDirection="column" marginTop={1}>
          <CollapseToggle
            onToggle={() => setToolsOpen(v => !v)}
            open={toolsOpen}
            t={t}
            title="可用工具"
          />
          {toolsOpen && toolsBody()}
        </Box>

        {/* ── Skills (collapsed by default) ── */}
        <Box flexDirection="column" marginTop={1}>
          <CollapseToggle
            count={skillsTotal}
            onToggle={() => setSkillsOpen(v => !v)}
            open={skillsOpen}
            suffix={skillsCatCount > 0 ? `in ${skillsCatCount} categor${skillsCatCount === 1 ? 'y' : 'ies'}` : undefined}
            t={t}
            title="可用技能"
          />
          {skillsOpen && skillsBody()}
        </Box>

        {/* ── A24：特色能力（启动即见 WxNodus 核心优势） ── */}
        <Box flexDirection="column" marginTop={1}>
          <CollapseToggle
            count={FEATURE_SPOTLIGHTS.length}
            onToggle={() => setFeaturesOpen(v => !v)}
            open={featuresOpen}
            suffix="一键尝试"
            t={t}
            title="⚡ 特色能力"
          />
          {featuresOpen && (
            <Box flexDirection="column" marginLeft={2}>
              {FEATURE_SPOTLIGHTS.map(f => (
                // A24 修复：标注「一键尝试」就必须可点——点击执行示例命令
                <Box key={f.label} onClick={() => onCommand?.(f.cmd)}>
                  <Text color={t.color.muted} wrap="truncate-end">
                    <Text color={t.color.accent}>{f.label}</Text>
                    {' — '}
                    {f.desc}
                    <Text color={t.color.statusFg} dim>
                      {' '}
                      {f.cmd}
                    </Text>
                  </Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>

        {/* ── System Prompt (collapsed by default) ── */}
        {sysPromptLen > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <CollapseToggle
              onToggle={() => setSystemOpen(v => !v)}
              open={systemOpen}
              suffix={`— ${sysPromptLen.toLocaleString()} chars`}
              t={t}
              title="System Prompt"
            />
            {systemOpen && systemBody()}
          </Box>
        )}

        {/* ── MCP Servers (collapsed by default) ── */}
        {info.mcp_servers && info.mcp_servers.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <CollapseToggle
              count={info.mcp_servers.length}
              onToggle={() => setMcpOpen(v => !v)}
              open={mcpOpen}
              suffix="connected"
              t={t}
              title="MCP Servers"
            />
            {mcpOpen && mcpBody()}
          </Box>
        )}

        <Text />

        <Box justifyContent="center">
          <Text color={t.color.text}>
            {toolsTotal} tools{' · '}
            {skillsTotal} skills
            {info.mcp_servers?.length ? ` · ${info.mcp_servers.length} MCP` : ''}
            {' · '}
            <Text color={t.color.muted}>/help 查看全部命令</Text>
          </Text>
        </Box>

        {typeof info.update_behind === 'number' && info.update_behind > 0 && (
          <Text bold color={t.color.warn}>
            ! {info.update_behind} {info.update_behind === 1 ? 'commit' : 'commits'} behind
            <Text bold={false} color={t.color.warn} dimColor>
              {' '}
              - run{' '}
            </Text>
            <Text bold color={t.color.warn}>
              {info.update_command || 'wxnodus update'}
            </Text>
            <Text bold={false} color={t.color.warn} dimColor>
              {' '}
              to update
            </Text>
          </Text>
        )}
          </>
        )}
      </Box>
    </Box>
  )
}

export function Panel({ sections, t, title }: PanelProps) {
  // 2026-08-19 输出格式体系：对话流内面板无边框（对标 Claude Code
  // /status 的 plain 格式）——标题行 + 分区标题 + kv 条目
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold color={t.color.primary}>
        {title}
      </Text>

      {sections.map((sec, si) => (
        <Box flexDirection="column" key={si} marginTop={si > 0 ? 1 : 0}>
          {sec.title && (
            <Text bold color={t.color.accent}>
              {sec.title}
            </Text>
          )}

          {sec.rows?.map(([k, v], ri) => (
            <Text key={ri} wrap="truncate">
              <Text color={t.color.muted}>{k.padEnd(20)}</Text>
              <Text color={t.color.text}>{v}</Text>
            </Text>
          ))}

          {sec.items?.map((item, ii) => (
            <Text color={t.color.text} key={ii} wrap="truncate">
              {item}
            </Text>
          ))}

          {sec.text && <Text color={t.color.muted}>{sec.text}</Text>}
        </Box>
      ))}
    </Box>
  )
}

interface PanelProps {
  sections: PanelSection[]
  t: Theme
  title: string
}

interface SessionPanelProps {
  info: SessionInfo
  maxWidth?: number
  /** A24：特色能力行点击执行（composer.submit 链路） */
  onCommand?: (text: string) => void
  sid?: string | null
  t: Theme
}
