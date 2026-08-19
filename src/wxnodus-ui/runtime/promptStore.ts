import { createAtom as atom, computed } from '../../app/stores/engine.js'
import { flushSync } from 'react-dom'
import { forceRedraw } from '@wxnodus/ink'

import type { InlineState, OverlayEntry, OverlayState } from '../bridge/interfaces.js'
import { closeKind, flowReset, popTop, pushInto, toggleInto, updateKind } from './overlayStack.js'

const buildOverlayState = (): OverlayState => ({
  stack: [],
  inline: {},
  agentsInitialHistoryIndex: 0
})

export const $overlayState = atom<OverlayState>(buildOverlayState())

export const $isBlocked = computed(
  $overlayState,
  s => s.stack.length > 0 || Object.values(s.inline).some(v => v !== null && v !== undefined)
)

export const getOverlayState = () => $overlayState.get()

// 桥接保障：强制重绘（S3 优化——模块级尾沿合并：高频 overlay 变更只挂 1 个定时器而非
// 每次 2 个；双帧语义保留：尾沿触发首帧 + 120ms 二帧兜底，覆盖 markDirty 链断的 blit 短路）
let redrawTimer: null | ReturnType<typeof setTimeout> = null

const scheduleForceRedraw = () => {
  if (redrawTimer !== null) {
    return
  }

  redrawTimer = setTimeout(() => {
    redrawTimer = null
    forceRedraw()
    // 第二帧兜底：个别 blit 短路场景需下一帧再刷一次（原 0ms+120ms 双帧语义）
    setTimeout(() => forceRedraw(), 120)
  }, 0)
}

/** 统一提交：flushSync 应用函数式更新 + 尾沿强制重绘 */
const commit = (fn: (state: OverlayState) => OverlayState) => {
  const before = $overlayState.get()
  try {
    flushSync(() => {
      $overlayState.set(fn($overlayState.get()))
    })
  } catch (e: any) {
    // fallback: 直接设置（flushSync 失败时 store 更新仍要生效）
    $overlayState.set(fn(before))
  }

  scheduleForceRedraw()
}

/** 入栈（同 kind 替换 + 互斥组替换——语义见 overlayStack.pushInto） */
export const pushOverlay = (entry: OverlayEntry) => commit(s => pushInto(s, entry))

/** 关闭指定 kind（不存在 → no-op） */
export const closeOverlay = (kind: OverlayEntry['kind']) => commit(s => closeKind(s, kind))

/** 出栈顶（Esc 统一出栈；空栈 no-op） */
export const popOverlay = () => commit(s => popTop(s))

/** 开关切换（存在 → 关；不存在 → 开）——Ctrl+K 命令面板 toggle 语义 */
export const toggleOverlay = (entry: OverlayEntry) => commit(s => toggleInto(s, entry))

/** 函数式更新指定 kind 条目（fn 返回 null → 出栈）——pager 滚动/树视图等内部态 */
export const updateOverlay = <K extends OverlayEntry['kind']>(
  kind: K,
  fn: (entry: Extract<OverlayEntry, { kind: K }>) => Extract<OverlayEntry, { kind: K }> | null
) => commit(s => updateKind(s, kind, fn))

/** 行内提示合并更新（审批/澄清/确认/sudo/secret/form——附着消息行，非栈） */
export const patchInline = (next: Partial<InlineState>) => commit(s => ({ ...s, inline: { ...s.inline, ...next } }))

/** Full reset — used by session/turn teardown and tests. */
export const resetOverlayState = () => $overlayState.set(buildOverlayState())

/**
 * Soft reset: drop FLOW-scoped overlays (inline prompts + pager) but PRESERVE
 * user-toggled ones — agents dashboard, model picker, skills hub, sessions
 * overlay, plugins hub.  Those are opened deliberately and shouldn't vanish
 * when a turn ends.  Called from turnController.idle() on every turn
 * completion / interrupt; the old "reset everything" behaviour silently
 * closed /agents the moment delegation finished.
 */
export const resetFlowOverlays = () => $overlayState.set(flowReset($overlayState.get()))
