// src/wxnodus-ui/components/configPanel.tsx — 配置面板（真实 settings 清单 + 布尔一键切换）
// 纯逻辑在 lib/configPanel.ts（可单测）；本组件只做数据装载与渲染（modelPicker 同款分层）
import { Box, Text, useInput } from '@wxnodus/ink'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import { configRows, handleConfigPanelKey, initConfigPanel, toggleBoolean } from '../lib/configPanel.js'
import type { Theme } from '../theme.js'
import { OverlayHint } from './overlayControls.js'

interface ConfigPanelProps {
  gw: GatewayClient
  onClose(): void
  t: Theme
}

const WINDOW = 14

export function ConfigPanel({ gw, onClose, t }: ConfigPanelProps) {
  const [rows, setRows] = useState<ReturnType<typeof configRows>>([])
  const [state, setState] = useState(initConfigPanel())
  const [hint, setHint] = useState('')

  const load = useCallback(() => {
    gw.request<{ settings: Record<string, unknown>; known: string[] }>('config.listSettings', {})
      .then(r => setRows(configRows(r?.settings ?? {}, r?.known ?? [])))
      .catch(e => setHint(`配置读取失败：${String(e ?? '').slice(0, 80)}`))
  }, [gw])

  useEffect(() => { load() }, [load])

  const start = Math.max(0, Math.min(state.sel - Math.floor(WINDOW / 2), Math.max(rows.length - WINDOW, 0)))
  const visible = useMemo(() => rows.slice(start, start + WINDOW), [rows, start])

  useInput((_input, key) => {
    const r = handleConfigPanelKey(state, { upArrow: key.upArrow, downArrow: key.downArrow, return: key.return, escape: key.escape }, rows.length)
    if (r.action === 'cancel') { onClose(); return }
    if (r.action === 'edit') {
      const row = rows[state.sel]
      if (!row) return
      if (row.boolean) {
        const next = toggleBoolean(JSON.parse(row.value))
        setHint(`正在设置 ${row.key} = ${next} …`)
        gw.request('config.setSetting', { key: row.key, value: String(next) })
          .then(() => { setHint(`已设置 ${row.key} = ${next}`); load() })
          .catch(e => setHint(`设置失败：${String(e ?? '').slice(0, 80)}`))
      } else {
        setHint(`非布尔键不支持面板直接编辑——用 /config set ${row.key} <value>`)
      }
      return
    }
    setState(r.next)
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.color.border} paddingX={1}>
      <Text color={t.color.accent}> 配置面板（↑↓ 选择 · Enter 布尔切换 · Esc 关闭）</Text>
      {rows.length === 0 && <Text dimColor> 加载中…</Text>}
      {visible.map((row) => {
        const selected = rows.indexOf(row) === state.sel
        return (
          <Text key={row.key} color={selected ? t.color.accent : undefined} bold={selected}>
            {selected ? '▶' : ' '} {row.key}: {row.value}{row.known ? '' : ' ⚠未知键'}
          </Text>
        )
      })}
      {hint ? <Text color={t.color.warn ?? t.color.accent}>{hint}</Text> : <OverlayHint t={t}>Enter 切换/编辑 · Esc 关闭</OverlayHint>}
    </Box>
  )
}
