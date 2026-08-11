import { createAtom as atom, computed } from '../../app/stores/engine.js'
import { flushSync } from 'react-dom'
import { forceRedraw } from '@wxnodus/ink'

import type { OverlayState } from '../bridge/interfaces.js'

const buildOverlayState = (): OverlayState => ({
  agents: false,
  agentsInitialHistoryIndex: 0,
  approval: null,
  clarify: null,
  confirm: null,
  modelPicker: false,
  pager: null,
  pluginsHub: false,
  secret: null,
  form: null,
  sessions: false,
  skillsHub: false,
  sudo: null
})

export const $overlayState = atom<OverlayState>(buildOverlayState())

export const $isBlocked = computed(
  $overlayState,
  ({ agents, approval, clarify, confirm, modelPicker, pager, pluginsHub, secret, sessions, skillsHub, sudo, form }) =>
    Boolean(
      agents || approval || clarify || confirm || modelPicker || pager || pluginsHub || secret || sessions || skillsHub || sudo || form
    )
)

export const getOverlayState = () => $overlayState.get()

export const patchOverlayState = (next: Partial<OverlayState> | ((state: OverlayState) => OverlayState)) => {
  const before = $overlayState.get()
  try {
    flushSync(() => {
      $overlayState.set(typeof next === 'function' ? next($overlayState.get()) : { ...$overlayState.get(), ...next })
    })
  } catch (e: any) {
    // fallback: 直接设置（flushSync 失败时 store 更新仍要生效）
    $overlayState.set(typeof next === 'function' ? next(before) : { ...before, ...next })
  }

  // 桥接保障：强制下一帧完整重绘（覆盖 markDirty 链断的 blit 短路）
  setTimeout(() => forceRedraw(), 0)
  setTimeout(() => forceRedraw(), 120)
}

/** Full reset — used by session/turn teardown and tests. */
export const resetOverlayState = () => $overlayState.set(buildOverlayState())

/**
 * Soft reset: drop FLOW-scoped overlays (approval / clarify / confirm / sudo
 * / secret / pager) but PRESERVE user-toggled ones — agents dashboard, model
 * picker, skills hub, sessions overlay.  Those are opened deliberately and
 * shouldn't vanish when a turn ends.  Called from turnController.idle() on
 * every turn completion / interrupt; the old "reset everything" behaviour
 * silently closed /agents the moment delegation finished.
 */
export const resetFlowOverlays = () =>
  $overlayState.set({
    ...buildOverlayState(),
    agents: $overlayState.get().agents,
    agentsInitialHistoryIndex: $overlayState.get().agentsInitialHistoryIndex,
    modelPicker: $overlayState.get().modelPicker,
    pluginsHub: $overlayState.get().pluginsHub,
    sessions: $overlayState.get().sessions,
    skillsHub: $overlayState.get().skillsHub
  })
