// src/wxnodus-ui/components/dirPicker.tsx — A24 目录选择器（点击状态栏 cwd 打开）
// 设计：面包屑 + 目录行（点击/Enter 进入）+ 文件行 muted + 动作栏：
//   切换到此目录（cwd.set 运行时生效）/ 打开终端（/term new <path>）/ 资源管理器（explorer）
// 数据：dir.list RPC（readdirSync + statSync 真实目录内容）；零假数据。
import { Box, Text, useInput, useStdout } from '@wxnodus/ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useGateway } from '../bridge/gatewayProvider.js'
import type { DirListResponse } from '../gatewayTypes.js'
import { closeOverlay } from '../runtime/promptStore.js'
import type { Theme } from '../theme.js'

import { OverlayHint } from './overlayControls.js'
import { icon } from '../glyphs.js'

interface DirEntry {
  isDir: boolean
  name: string
}

const isSep = (c: string) => c === '/' || c === '\\'

/** 上级目录（Windows 盘符根/POSIX 根返回 null——不可再上）。 */
export const parentOf = (p: string): string | null => {
  const norm = String(p ?? '').replace(/[\\/]+$/, '')
  if (!norm) return null
  let i = norm.length - 1
  while (i >= 0 && !isSep(norm[i]!)) i--
  if (i <= 0) return null
  const prefix = norm.slice(0, i)
  // Windows 盘符根：C:\Users → C:\（保留尾分隔符；再上不可）
  if (/^[a-zA-Z]:$/.test(prefix)) return prefix + norm[i]
  return prefix
}

export const joinPath = (p: string, name: string): string => {
  const base = String(p ?? '')

  return base && !isSep(base[base.length - 1]!) ? `${base}/${name}` : `${base}${name}`
}

export const basenameOf = (p: string): string => {
  const norm = String(p ?? '').replace(/[\\/]+$/, '')

  if (!norm) return p
  let i = norm.length - 1
  while (i >= 0 && !isSep(norm[i]!)) i--

  return norm.slice(i + 1)
}

const MAX_ROWS = 14

export function DirPicker({ t }: { t: Theme }) {
  const { gw } = useGateway()
  const { stdout } = useStdout()
  const width = Math.max(44, Math.min(88, (stdout?.columns ?? 80) - 6))

  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [idx, setIdx] = useState(0)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  // 起始目录（进入选择器时的工作目录——「切换」按钮与当前目录标记用）
  const startPathRef = useRef('')

  const load = useCallback(
    (target: string) => {
      setLoading(true)
      gw.request<DirListResponse>('dir.list', { path: target })
        .then(r => {
          if (!r?.ok) {
            setErr(r?.error ?? '读取失败')
            setLoading(false)
            return
          }
          if (!startPathRef.current) startPathRef.current = r.path ?? ''
          setPath(r.path ?? '')
          setEntries(r.entries ?? [])
          setIdx(0)
          setErr('')
          setLoading(false)
        })
        .catch((e: Error) => {
          setErr(String(e?.message ?? e))
          setLoading(false)
        })
    },
    [gw]
  )

  useEffect(() => {
    load('')
  }, [load])

  const close = () => closeOverlay('dirPicker')

  useInput((ch, key) => {
    if (key.escape) {
      const parent = parentOf(path)
      if (parent && parent !== path) {
        load(parent)
      } else {
        close()
      }
      return
    }

    if (ch === 'q') {
      close()
      return
    }

    if (key.upArrow && idx > 0) {
      setIdx(i => i - 1)
      return
    }

    if (key.downArrow && idx < entries.length - 1) {
      setIdx(i => i + 1)
      return
    }

    if (key.return) {
      const e = entries[idx]
      if (e?.isDir) load(joinPath(path, e.name))
      return
    }

    if (key.backspace) {
      const parent = parentOf(path)
      if (parent && parent !== path) load(parent)
    }
  })

  // 动作：切换工作目录（cwd.set 运行时生效——gateway 重发 session.info 刷新状态栏）
  const switchHere = () => {
    if (switching) return
    setSwitching(true)
    gw.request<{ ok?: boolean; error?: string }>('cwd.set', { path })
      .then(r => {
        if (r?.ok) {
          close()
        } else {
          setErr(r?.error ?? '切换失败')
          setSwitching(false)
        }
      })
      .catch((e: Error) => {
        setErr(String(e?.message ?? e))
        setSwitching(false)
      })
  }

  const openTerminalHere = () => {
    void gw.request('command.dispatch', { name: 'term', arg: path }).then(close)
  }

  const openExplorer = () => {
    void gw.request('shell.exec', { command: `explorer "${path}"` }).then(close)
  }

  const rows: Array<{ isDir: boolean; key: string; name: string; parent?: boolean }> = []
  const parent = parentOf(path)
  if (parent && parent !== path) rows.push({ isDir: true, key: '..', name: '..', parent: true })
  for (const e of entries) rows.push({ isDir: e.isDir, key: e.name, name: e.name })
  // 窗口化：以选中行为中心展示 MAX_ROWS 行
  const start = Math.max(0, Math.min(idx - Math.floor(MAX_ROWS / 2), Math.max(0, rows.length - MAX_ROWS)))
  const windowed = rows.slice(start, start + MAX_ROWS)

  return (
    <Box borderColor={t.color.border} borderStyle="round" flexDirection="column" width={width} paddingX={1}>
      <Text bold color={t.color.accent} wrap="truncate-end">
        {icon('diamond')} 目录选择器 · {path || '…'}
      </Text>
      <Text color={t.color.muted}>点击目录进入 · Enter 进入 · Esc 上级 · q 关闭 · 底部按钮执行动作</Text>

      <Box flexDirection="column" marginTop={1}>
        {loading ? (
          <Text color={t.color.muted}>读取中…</Text>
        ) : err ? (
          <Text color={t.color.label}>错误：{err}</Text>
        ) : (
          windowed.map((row, i) => {
            const absolute = start + i === idx

            return (
              // A22 鼠标化：点击行——目录进入 / 文件无动作（muted）
              <Box
                key={row.key}
                onClick={() => {
                  if (row.parent) {
                    load(parent!)
                  } else if (row.isDir) {
                    load(joinPath(path, row.name))
                  }
                }}
              >
                <Text
                  bold={absolute}
                  color={absolute ? t.color.accent : row.isDir ? t.color.text : t.color.muted}
                  backgroundColor={absolute ? t.color.selectionBg : undefined}
                  wrap="truncate-end"
                >
                  {absolute ? '▸ ' : '  '}
                  {row.isDir ? `${icon('folder')} ` : '   '}
                  {row.name}
                  {row.isDir ? '/' : ''}
                </Text>
              </Box>
            )
          })
        )}
        {!loading && !err && !windowed.length ? <Text color={t.color.muted}>（空目录）</Text> : null}
      </Box>

      {/* 动作栏：切换 / 终端 / 资源管理器——全部鼠标可点 */}
      <Box flexDirection="row" marginTop={1}>
        <Box onClick={switchHere}>
          <Text bold color={switching ? t.color.muted : t.color.accent}>
            {switching ? `${icon('hourglass')} 切换中…` : `${icon('submit')} 切换到此目录`}
          </Text>
        </Box>
        <Text>{'   '}</Text>
        <Box onClick={openTerminalHere}>
          <Text color={t.color.text}>⌂ 打开终端</Text>
        </Box>
        <Text>{'   '}</Text>
        <Box onClick={openExplorer}>
          <Text color={t.color.muted}>{icon('copy')} 资源管理器</Text>
        </Box>
      </Box>

      <OverlayHint t={t}>↑/↓ 选择 · Enter 进入 · Esc 上级/关闭 · 点击目录/按钮 · q 关闭</OverlayHint>
    </Box>
  )
}
