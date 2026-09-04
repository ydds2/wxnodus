// src/tui/ui/App.tsx — TUI 根组件：三明治边界（上沿/下沿双细线）· 转录视口 · 底部固定区
// 钉底布局（用户裁决：输入框和参数固定在 cmd 底部）：固定区 = 头部 3 + 输入区(动态) + 状态栏 2 + 安全边距 2；
// 转录区 = 终端行数 − 固定区——渲染行数可预测（markdown-lite 硬换行），底栏永不漂出。
// 浮层打开时替换输入区+状态栏（原型 05「黄框覆盖输入区」）——面板即输入面。
import React, { useEffect, useReducer } from 'react'
import { Box, Text } from 'ink'
import { TuiStore } from '../store.js'
import { TuiRuntime } from '../runtime.js'
import { DEEP_SPACE } from '../theme.js'
import { Composer, composerRows } from './Composer.js'
import { StatusBar } from './StatusBar.js'
import { Transcript } from './Transcript.js'
import { Overlays, overlayRows } from './Overlays.js'
import { Header } from './Header.js'
import { initTermcap } from '../termcap.js'
import { transcriptBudget } from '../viewport.js'
import { useStableInput } from './stableInput.js'

export function App({ store, runtime }: { store: TuiStore; runtime: TuiRuntime }): React.ReactElement {
  initTermcap()
  // 官方 ink 6 + React 19 下 useSyncExternalStore 渲染挂起（PTY 实测零帧）——改订阅强制重渲
  const [, forceUpdate] = useReducer(x => x + 1, 0)
  useEffect(() => store.subscribe(() => forceUpdate()), [store])
  const s = store.getSnapshot()

  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24

  useStableInput((input, key) => {
    // 退出保护（原型 30 三层）：浮层优先由 Overlays 消费，此处仅兜底
    if (key.ctrl && input === 'c') { runtime.sigint(); return }
    // Esc：浮层态由浮层组件自消费；其余（含运行中中断——占位符广告的「Esc 中断」必须真实）转发 runtime
    if (key.escape && s.overlay.kind === 'none') { runtime.esc() }
  })

  // 固定区行数：头部 +（输入区+状态栏 | 浮层）+ 退出提示
  // 转录区经底部填充占满 maxRows → 整树高度恰 = 终端行数（输入框+参数恒落窗口最后两行）
  // T79：浮层估计带 rows 封顶（短终端面板收缩——估计恒 ≥ 实际渲染）
  const fixedRows = 3
    + (s.overlay.kind === 'none' ? composerRows(s, cols, runtime.commandIndex()) + 2 : overlayRows(s.overlay.kind, rows))
    + (s.exitHint ? 1 : 0)
  const maxRows = transcriptBudget(rows, fixedRows)

  return (
    <Box flexDirection="column">
      <Header s={s} cols={cols} />
      <Transcript
        store={store}
        entries={s.entries}
        thinking={s.running ? { ms: s.thinkingMs, toks: s.thinkingToks, stage: s.stage } : null}
        retry={s.retry}
        command={s.command}
        cols={cols}
        maxRows={maxRows}
      />
      {s.overlay.kind === 'none' ? (
        <Box flexDirection="column">
          <Composer runtime={runtime} s={s} cols={cols} />
          <StatusBar state={s} cols={cols} />
        </Box>
      ) : (
        <Overlays store={store} runtime={runtime} s={s} rows={rows} />
      )}
      {s.exitHint ? <Text color={DEEP_SPACE.warn}>再按一次 Ctrl+C 退出 wxnodus</Text> : null}
    </Box>
  )
}
