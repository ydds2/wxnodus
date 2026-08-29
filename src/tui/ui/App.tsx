// src/tui/ui/App.tsx — TUI 根组件：转录流 + 输入区 + 状态栏 + 浮层（原型 v12 简洁美学）
// 全自研：@wxnodus/ink 渲染（进程内——零 WS 零子进程，react 19.2.7+reconciler 0.33 钉死矩阵）。
import React, { useEffect, useReducer } from 'react'
import { Box, Text, useInput } from 'ink'
import { TuiStore } from '../store.js'
import { TuiRuntime } from '../runtime.js'
import { DEEP_SPACE } from '../theme.js'
import { Composer } from './Composer.js'
import { StatusBar } from './StatusBar.js'
import { Transcript } from './Transcript.js'
import { Overlays } from './Overlays.js'
import { Header } from './Header.js'
import { initTermcap } from '../termcap.js'

export function App({ store, runtime }: { store: TuiStore; runtime: TuiRuntime }): React.ReactElement {
  initTermcap()
  // ink 7 + React 19 下 useSyncExternalStore 渲染挂起（PTY 实测零帧）——改订阅强制重渲
  const [, forceUpdate] = useReducer(x => x + 1, 0)
  useEffect(() => store.subscribe(() => forceUpdate()), [store])
  const s = store.getSnapshot()
  const busy = s.running || s.overlay.kind !== 'none'

  useInput((input, key) => {
    // 退出保护（原型 30 三层）：浮层优先由 Overlays 消费，此处仅兜底
    if (key.ctrl && input === 'c') { runtime.sigint(); return }
    if (key.escape && !busy) { runtime.esc() }
  })

  return (
    <Box flexDirection="column">
      <Header s={s} />
      <Transcript entries={s.entries} thinking={s.running ? { ms: s.thinkingMs, toks: s.thinkingToks } : null} />
      <Composer runtime={runtime} s={s} />
      <StatusBar state={s} />
      <Overlays store={store} runtime={runtime} s={s} />
      {s.exitHint ? <Text color={DEEP_SPACE.warn}>再按一次 Ctrl+C 退出 wxnodus</Text> : null}
    </Box>
  )
}
