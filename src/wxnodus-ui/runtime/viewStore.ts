import { createAtom as atom, computed } from '../../app/stores/engine.js'

import { MOUSE_TRACKING } from '../config/env.js'
import { ZERO } from '../domain/usage.js'
import { DEFAULT_THEME } from '../theme.js'

import { DEFAULT_INDICATOR_STYLE, type UiState } from '../bridge/interfaces.js'
import type { Role } from '../types.js'

const buildUiState = (): UiState => ({
  bgTasks: new Set(),
  busy: false,
  busyInputMode: 'queue',
  compact: false,
  detailsMode: 'collapsed',
  detailsModeCommandOverride: false,
  indicatorStyle: DEFAULT_INDICATOR_STYLE,
  info: null,
  liveSessionCount: 0,
  inlineDiffs: true,
  mouseTracking: MOUSE_TRACKING,
  notice: null,
  pasteCollapseLines: 5,
  pasteCollapseChars: 2000,
  sections: {},
  selectedMessage: null,
  selectionHint: null,
  sessionTitle: '',
  showCost: false,
  battery: null,
  showReasoning: false,
  sid: null,
  status: '正在初始化 WxNodus…',
  statusBar: 'top',
  streaming: true,
  theme: DEFAULT_THEME,
  usage: ZERO
})

export const $uiState = atom<UiState>(buildUiState())

export const $uiTheme = computed($uiState, state => state.theme)
export const $uiSessionId = computed($uiState, state => state.sid)

/** A19：鼠标选中的消息快照（单独 computed，避免 hint 变化重渲染全部消息行）。 */
export const $selectedMessage = computed($uiState, state => state.selectedMessage)

export const getUiState = () => $uiState.get()

export const patchUiState = (next: Partial<UiState> | ((state: UiState) => UiState)) =>
  $uiState.set(typeof next === 'function' ? next($uiState.get()) : { ...$uiState.get(), ...next })

export const resetUiState = () => $uiState.set(buildUiState())

// ── A19：鼠标点选辅助（消息选中 / 悬停 / 复制反馈）──────────────────────

/** 单击选中消息（快照文本，流式更新不影响副本）。 */
export const selectMessage = (key: string, text: string, role: Role) =>
  patchUiState({ selectedMessage: { key, text, role } })

/** 取消消息选中（无选中时不触发重渲染）。 */
export const clearSelectedMessage = () =>
  patchUiState(s => (s.selectedMessage === null ? s : { ...s, selectedMessage: null }))

let hintTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 状态条提示：立即显示并在 3s 后自动清除（unref 保证测试进程不挂起）。
 * 连续调用会重置计时——鼠标扫过消息区时提示始终是最新一条。
 */
export const showSelectionHint = (text: string) => {
  patchUiState({ selectionHint: text })

  if (hintTimer) {
    clearTimeout(hintTimer)
  }

  hintTimer = setTimeout(() => {
    hintTimer = null
    patchUiState({ selectionHint: null })
  }, 3000)
  hintTimer.unref?.()
}
