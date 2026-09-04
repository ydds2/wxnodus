// src/tui/ui/stableInput.ts — ink useInput 稳定身份包装（Windows ConPTY 吞键/卡顿根因修复）
// ink 6 use-input.js:121 的 effect deps 含 inputHandler——每次渲染新闭包 → 每次渲染重订阅 stdin
// （App/Composer/Transcript/面板多实例叠加，订阅缝隙丢键 + batchedUpdates 抖动 = 偶发吞 ↑/卡顿）。
// 本包装：useRef 中转最新闭包 + useCallback 稳定身份——订阅零 churn；处理逻辑仍每渲染最新（快照读最新值不变）。
import { useCallback, useRef } from 'react'
import { useInput } from 'ink'

export function useStableInput(handler: (input: string, key: any) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useInput(useCallback((input: string, key: any) => {
    ref.current(input, key)
  }, []))
}
