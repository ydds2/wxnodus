// src/wxnodus-ui/runtime/overlayStack.ts — 栈式浮层模型（UI 重设计 P0-2，2026-08-19）
// 纯函数（无 React/无副作用）：OverlayState 由 17 布尔位重构为 stack + inline。
// - stack：LIFO 浮层（工作台/面板/选择器/pager）——z 序 = 栈序；Esc 统一出栈。
// - inline：行内提示（审批/澄清/确认/sudo/secret/form）——附着消息行，非栈（同屏至多 1 个）。
// 互斥组：panel（右侧面板互斥）、picker（选择器互斥）——push 同组替换而非叠加
// （行为变化点：此前可同时开两个面板，见 audit §13.9x 如实记录）。
// 机制参考：opencode/inc 栈式 overlay（LIFO + 互斥组）——实现按 wxnodus 架构原创。
import type { OverlayEntry, OverlayStackState } from '../bridge/interfaces.js'

export type { OverlayEntry, OverlayStackState }

/** 右侧面板互斥组（config/model/skills/plugins——分栏同一块屏幕） */
export const PANEL_KINDS = ['configPanel', 'modelPicker', 'skillsHub', 'pluginsHub'] as const

/** 选择器互斥组（会话/目录/历史搜索/命令面板——同一时刻只开一个选择器） */
export const PICKER_KINDS = ['sessions', 'dirPicker', 'histSearch', 'commandPalette'] as const

/**
 * 全局 Esc 兜底出栈的 kind 集合（P0-2 实测 + P1 扩展）：这些浮层的渲染组件没有
 * 组件级 Esc 处理（skillsHub/pluginsHub 实测无；workspace 在 appOverlays 内渲染），
 * 由 useKeyBindings 全局 Esc 统一 popTop；其余 kind 组件自行 closeOverlay——
 * 全局再弹会造成一次 Esc 弹两层。
 */
export const ESC_GLOBAL_KINDS = ['skillsHub', 'pluginsHub', 'workspace'] as const

export const KIND_GROUPS: ReadonlyArray<{ name: 'panel' | 'picker'; kinds: readonly string[] }> = [
  { name: 'panel', kinds: PANEL_KINDS },
  { name: 'picker', kinds: PICKER_KINDS },
]

/** 栈内当前面板 kind（互斥组保证至多 1 个——P2 右分栏渲染数据源）；无 → null */
export function findPanelKind(state: OverlayStackState): 'configPanel' | 'modelPicker' | 'skillsHub' | 'pluginsHub' | null {
  for (const e of state.stack) {
    if ((PANEL_KINDS as readonly string[]).includes(e.kind)) {
      return e.kind as 'configPanel' | 'modelPicker' | 'skillsHub' | 'pluginsHub'
    }
  }
  return null
}

/** 浮层所属互斥组（不在组内 → null：pager/agents 各自独立，可压栈叠加） */
export function groupOf(kind: OverlayEntry['kind']): 'panel' | 'picker' | null {
  if ((PANEL_KINDS as readonly string[]).includes(kind)) return 'panel'
  if ((PICKER_KINDS as readonly string[]).includes(kind)) return 'picker'
  return null
}

/**
 * 入栈：同 kind 先出栈（替换）；同互斥组旧项出栈（互斥）；新项压栈顶。
 * 不变式：栈内任意 kind 至多 1 个；任意互斥组至多 1 个成员。
 */
export function pushInto(state: OverlayStackState, entry: OverlayEntry): OverlayStackState {
  const group = groupOf(entry.kind)
  const stack = state.stack.filter(e => {
    if (e.kind === entry.kind) return false
    if (group && groupOf(e.kind) === group) return false
    return true
  })
  return { ...state, stack: [...stack, entry] }
}

/** 关闭指定 kind（不存在 → 原状态返回，等值引用） */
export function closeKind(state: OverlayStackState, kind: OverlayEntry['kind']): OverlayStackState {
  if (!state.stack.some(e => e.kind === kind)) return state
  return { ...state, stack: state.stack.filter(e => e.kind !== kind) }
}

/** 出栈顶（空栈 → 原状态返回）——Esc 统一出栈语义 */
export function popTop(state: OverlayStackState): OverlayStackState {
  if (!state.stack.length) return state
  return { ...state, stack: state.stack.slice(0, -1) }
}

/** 栈顶条目（空栈 → null） */
export function topEntry(state: OverlayStackState): OverlayEntry | null {
  return state.stack.length ? state.stack[state.stack.length - 1]! : null
}

/** 按 kind 查找条目 */
export function findEntry<K extends OverlayEntry['kind']>(
  state: OverlayStackState,
  kind: K
): Extract<OverlayEntry, { kind: K }> | null {
  const e = state.stack.find(x => x.kind === kind)
  return (e as Extract<OverlayEntry, { kind: K }>) ?? null
}

/**
 * 函数式更新指定 kind 的条目（pager 滚动/树视图/hunk 等内部态）。
 * fn 返回 null → 出栈（如「末页 Enter 关闭」）；kind 不存在 → 原状态返回。
 */
export function updateKind<K extends OverlayEntry['kind']>(
  state: OverlayStackState,
  kind: K,
  fn: (entry: Extract<OverlayEntry, { kind: K }>) => Extract<OverlayEntry, { kind: K }> | null
): OverlayStackState {
  const idx = state.stack.findIndex(e => e.kind === kind)
  if (idx === -1) return state
  const next = fn(state.stack[idx] as Extract<OverlayEntry, { kind: K }>)
  const stack = [...state.stack]
  if (next === null) stack.splice(idx, 1)
  else stack[idx] = next
  return { ...state, stack }
}

/** 开关切换：存在 → 出栈；不存在 → 入栈（Ctrl+K 命令面板 toggle 语义） */
export function toggleInto(state: OverlayStackState, entry: OverlayEntry): OverlayStackState {
  return state.stack.some(e => e.kind === entry.kind) ? closeKind(state, entry.kind) : pushInto(state, entry)
}

/**
 * 流程重置（turn 结束/中断）：丢弃流程性浮层（pager），保留用户主动打开的
 * 面板/选择器（agents/modelPicker/pluginsHub/sessions/skillsHub——沿用旧 resetFlowOverlays
 * 保留集）；行内提示全部清空（审批/澄清/确认/sudo/secret/form 属流程态）。
 */
export const FLOW_KEEP_KINDS = ['agents', 'modelPicker', 'pluginsHub', 'sessions', 'skillsHub'] as const

export function flowReset(state: OverlayStackState): OverlayStackState {
  return {
    stack: state.stack.filter(e => (FLOW_KEEP_KINDS as readonly string[]).includes(e.kind)),
    inline: {},
    agentsInitialHistoryIndex: state.agentsInitialHistoryIndex
  }
}
