// CommandPalette — Ctrl+K 命令面板：命令/技能/会话统一直达（V3 自研）
// 数据源三路真实 RPC：commands.catalog（命令+描述）/ skills.manage list（技能）/
// session.active_list（活跃会话）。fuzzy 子序列过滤（lib/fuzzy 自研引擎），
// ↑/↓ 选择、Enter 执行（命令/技能 → 提交输入；会话 → 激活切换）、Esc 关闭。
// 面板打开时主输入区随 isBlocked 卸载，按键只进本组件 useInput——无冲突。
import { Box, Text, useInput } from '@wxnodus/ink'
import { useEffect, useMemo, useRef, useState } from 'react'

import { fuzzyScoreMulti } from '../lib/fuzzy.js'
import type { GatewayClient } from '../gatewayClient.js'
import type { Theme } from '../theme.js'
import { icon } from '../glyphs.js'

interface PaletteEntry {
  desc?: string
  kind: 'cmd' | 'skill' | 'session'
  label: string
  value: string
}

const MAX_ROWS = 9

const kindGlyph: Record<PaletteEntry['kind'], string> = {
  cmd: '/',
  skill: '◆',
  session: icon('diamond')
}

export function CommandPalette({
  cols,
  currentSessionId,
  gw,
  onClose,
  onSessionSelect,
  onSubmit,
  t
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  const [entries, setEntries] = useState<PaletteEntry[]>([])
  const [loading, setLoading] = useState(true)
  const queryRef = useRef('')

  useEffect(() => {
    void (async () => {
      const [catRes, skillRes, sessRes] = await Promise.allSettled([
        gw.request<{ pairs?: Array<[string, string]> }>('commands.catalog'),
        gw.request<{ skills?: Record<string, string[]> }>('skills.manage', { action: 'list' }),
        gw.request<{ sessions?: Array<{ id: string; title?: string }> }>('session.active_list', {
          current_session_id: currentSessionId ?? ''
        })
      ])
      const next: PaletteEntry[] = []
      if (catRes.status === 'fulfilled') {
        for (const [cmd, desc] of catRes.value.pairs ?? []) {
          next.push({ kind: 'cmd', label: cmd, desc, value: cmd })
        }
      }
      if (skillRes.status === 'fulfilled') {
        for (const names of Object.values(skillRes.value.skills ?? {})) {
          for (const name of names) {
            next.push({ kind: 'skill', label: `/skill:${name}`, desc: `技能 ${name}`, value: `/skill:${name}` })
          }
        }
      }
      if (sessRes.status === 'fulfilled') {
        for (const s of sessRes.value.sessions ?? []) {
          next.push({ kind: 'session', label: s.title?.trim() || s.id, desc: `会话 ${s.id}`, value: s.id })
        }
      }
      setEntries(next)
      setLoading(false)
    })()
  }, [currentSessionId, gw])

  // 过滤：label + desc 双字段 fuzzy 子序列评分，取最高分
  const filtered = useMemo(() => {
    const q = queryRef.current.trim()
    if (!q) return entries
    const scored = entries
      .map(e => {
        const sLabel = fuzzyScoreMulti(e.label, q)
        const sDesc = e.desc ? fuzzyScoreMulti(e.desc, q) : null
        const score = Math.max(sLabel?.score ?? -1, sDesc?.score ?? -1)
        return { e, score }
      })
      .filter(x => x.score >= 0)
      .sort((a, b) => b.score - a.score)
    return scored.map(x => x.e)
  }, [entries, query])

  const shown = filtered.slice(0, MAX_ROWS)

  useInput((ch, key) => {
    if (key.escape || (key.ctrl && ch.toLowerCase() === 'c')) {
      onClose()
      return
    }
    if (key.upArrow || key.downArrow) {
      setIdx(i => {
        const len = shown.length
        if (!len) return 0
        return key.upArrow ? (i - 1 + len) % len : (i + 1) % len
      })
      return
    }
    if (key.return) {
      const target = shown[Math.min(idx, shown.length - 1)]
      if (!target) return
      onClose()
      if (target.kind === 'session') {
        onSessionSelect(target.value)
      } else {
        onSubmit(target.value)
      }
      return
    }
    if (key.backspace) {
      setQuery(q => q.slice(0, -1))
      queryRef.current = queryRef.current.slice(0, -1)
      setIdx(0)
      return
    }
    // 可打印字符（Enter/Ctrl 组合除外）追加到查询
    if (ch && !key.ctrl && !key.meta && !key.shift) {
      const next = queryRef.current + ch
      queryRef.current = next
      setQuery(next)
      setIdx(0)
    }
  })

  const width = Math.max(30, cols - 10)
  const head = `⌘ 命令面板  ${query}▏`

  return (
    <Box borderColor={t.color.border} borderStyle="round" flexDirection="column" width={width} paddingX={1}>
      <Text bold color={t.color.accent} wrap="truncate-end">
        {head}
      </Text>
      <Text color={t.color.muted}>命令 / 技能 / 会话 · ↑↓ 选择 · Enter 执行 · 鼠标点击直达 · Esc 关闭</Text>
      <Box flexDirection="column" marginTop={1}>
        {loading ? (
          <Text color={t.color.muted}>加载中…</Text>
        ) : shown.length === 0 ? (
          <Text color={t.color.muted}>
            {entries.length === 0 ? '无可用条目（后端数据未就绪）' : `无匹配「${query}」`}
          </Text>
        ) : (
          shown.map((e, i) => (
            // A22 鼠标化：点击条目 = 执行（命令/技能 → 提交；会话 → 切换激活）
            <Box
              key={`${e.kind}:${e.value}:${i}`}
              onClick={() => {
                onClose()
                if (e.kind === 'session') {
                  onSessionSelect(e.value)
                } else {
                  onSubmit(e.value)
                }
              }}
            >
              <Text
                bold={i === idx}
                color={i === idx ? t.color.accent : undefined}
                backgroundColor={i === idx ? t.color.selectionBg : undefined}
                wrap="truncate-end"
              >
                {i === idx ? <Text color={t.color.accent}>▸ </Text> : null}
                <Text color={i === idx ? t.color.accent : t.color.muted}>{kindGlyph[e.kind]} </Text>
                {e.label}
                {e.desc ? <Text color={t.color.muted} dimColor>  — {e.desc}</Text> : null}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  )
}

interface CommandPaletteProps {
  cols: number
  currentSessionId: string | null
  gw: GatewayClient
  onClose: () => void
  onSessionSelect: (sessionId: string) => void
  onSubmit: (text: string) => void
  t: Theme
}
