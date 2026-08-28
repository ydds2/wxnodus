// src/wxnodus-ui/runtime/deltaBatcher.ts — V4 UI 闭环（症状A 闪屏根治）：流式 delta 微批
// 根因（用户实测报告 2026-08-22）：agent.token 每 token 一事件 → presentationStore 每
// 事件一次 $presentation.set → React 整树重渲染 + ink 整帧 diff 输出。deepseek 流速下
// 每秒几十帧全量 diff——终端高频重绘即「闪屏」。
// 修法（ink/zui 流式惯例）：message.delta 按帧窗（DELTA_FRAME_MS）合并——窗口内多个
// delta 拼接为单事件再 dispatch，其余事件类型即时透传（顺序保持：批 flush 先于后续
// 非 delta 事件，时序语义不变）。reset 语义：批内 reset 直接清空待批缓冲。
import type { PresentationEvent } from './presentationReducer.js'
import { dispatchPresentationEvent } from './presentationStore.js'

const DELTA_FRAME_MS = 50 // 20fps 渲染上限——肉眼流畅且终端写入量降 ~10-50×

type DeltaEvent = PresentationEvent & { type: 'message.delta'; text: string; reset?: boolean }

let pending: { parts: string[]; hasReset: boolean; sessionId: string; generation: number } | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

const isDelta = (e: PresentationEvent): e is DeltaEvent => e.type === 'message.delta'

const flush = (): void => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  if (!pending) return
  const p = pending
  pending = null
  // reset 语义（V4 P0-9）：先清空再接续 reset 后的文本——单事件保持顺序等价
  if (p.hasReset) {
    dispatchPresentationEvent({ type: 'message.delta', text: '', reset: true, sessionId: p.sessionId, generation: p.generation } as PresentationEvent)
  }
  const text = p.parts.join('')
  if (text) {
    dispatchPresentationEvent({ type: 'message.delta', text, sessionId: p.sessionId, generation: p.generation } as PresentationEvent)
  }
}

/** 分发入口：delta 微批、其余即时透传（批优先 flush 保顺序） */
export const dispatchBatched = (event: PresentationEvent): void => {
  if (!isDelta(event)) {
    flush()
    dispatchPresentationEvent(event)
    return
  }
  if (!pending) {
    pending = { parts: [], hasReset: false, sessionId: (event as any).sessionId, generation: (event as any).generation }
  }
  if (event.reset) {
    pending.hasReset = true
    pending.parts = [] // reset 后旧文本作废
    if (event.text) pending.parts.push(event.text)
    return
  }
  if (event.text) pending.parts.push(event.text)
  if (!flushTimer) {
    flushTimer = setTimeout(flush, DELTA_FRAME_MS)
  }
}

/** 流结束/会话切换时立即冲刷（防尾批滞留 50ms） */
export const flushDeltaBatch = (): void => flush()
