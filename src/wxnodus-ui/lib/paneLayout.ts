// src/wxnodus-ui/lib/paneLayout.ts — 双栏布局（右侧详情面板）纯函数
// 设计：面板固定宽（右侧），主对话区弹性（左侧）——固定宽避免两栏 flex 互相拉扯
//       （agentsOverlay DiffView 曾注释「两栏 Yoga flex 打架」：固定右栏、左栏弹性即规避）。
//       终端过窄（< MIN_COLS）自动隐藏（show=false），不挤兑对话区。
import type { PaneTab } from '../types.js'

export const PANE_TABS: readonly PaneTab[] = ['todo', 'tools', 'context', 'subagents']

export const PANE_TAB_LABEL: Record<PaneTab, string> = {
  todo: '清单',
  tools: '工具',
  context: '上下文',
  subagents: '子代理',
}

/** 面板展示的最小终端宽度（列）；低于此宽度即使开启也不渲染 */
export const PANE_MIN_COLS = 110

const PANE_WIDTH_MIN = 30
const PANE_WIDTH_MAX = 46

export interface DualPaneWidths {
  /** 主对话区可用宽度（扣除面板与边框后的消息渲染宽度） */
  left: number
  /** 面板本体宽度（不含边框） */
  right: number
  /** 是否实际渲染（终端宽度足够） */
  show: boolean
}

/** 双栏宽度分配：right 固定（clamp(cols/3, 30, 46)），left 弹性。 */
export function dualPaneWidths(cols: number): DualPaneWidths {
  const width = Math.max(1, Math.floor(cols || 1))
  if (width < PANE_MIN_COLS) {
    return { left: width, right: 0, show: false }
  }
  const right = Math.min(PANE_WIDTH_MAX, Math.max(PANE_WIDTH_MIN, Math.floor(width / 3)))
  // 2 = 面板左右边框各 1 列
  return { left: Math.max(1, width - right - 2), right, show: true }
}

/** 是否为合法面板标签（/pane tab <name> 校验） */
export function isPaneTab(v: unknown): v is PaneTab {
  return typeof v === 'string' && (PANE_TABS as readonly string[]).includes(v)
}
