// capabilities.ts — W8-22：渲染器能力插管（cmd/conhost 风险第三道防线）
// 渲染器发射哪些序列/颜色由「能力集」决定：modern 档 = 现状零变化（默认值即模块加载时的环境探测）；
// cmd 档由宿主注入（sync2026/decstbm/truecolor/osc8/oscNotify/mouse/extendedKeys 全关，256 色钳制）。
import chalk from 'chalk'
import { isSynchronizedOutputSupported, supportsExtendedKeys } from './terminal.js'
import { DISABLE_MOUSE_TRACKING, enableMouseTrackingFor, type MouseTrackingMode } from './termio/dec.js'

export interface RendererCapabilities {
  /** DEC 2026 同步输出（BSU/ESU 帧包裹） */
  sync2026: boolean
  /** DECSTBM 硬件滚动（需 2026 原子性——conhost 两者皆无） */
  decstbm: boolean
  /** 24 位真彩 SGR；false → chalk 钳到 level 2（256 色） */
  truecolor: boolean
  /** OSC 8 超链接发射 */
  osc8: boolean
  /** OSC 9/99/777/21337 通知/进度发射 */
  oscNotify: boolean
  /** 鼠标跟踪（cmd 需 QuickEdit 已关才为 true） */
  mouse: boolean
  /** Kitty 键盘协议 + modifyOtherKeys 扩展键 */
  extendedKeys: boolean
}

// 缺省 = 模块加载时的既有环境探测结果（modern 行为零变化）
export const DEFAULT_RENDERER_CAPABILITIES: RendererCapabilities = {
  sync2026: isSynchronizedOutputSupported(),
  decstbm: isSynchronizedOutputSupported(),
  truecolor: true,
  osc8: true,
  oscNotify: true,
  mouse: true,
  extendedKeys: supportsExtendedKeys(),
}

let currentCapabilities: RendererCapabilities = DEFAULT_RENDERER_CAPABILITIES

/** 宿主（CLI 引导层）注入能力集；null 重置为缺省。缺省之外的部分与 DEFAULT 合并。 */
export function setRendererCapabilities(capabilities: Partial<RendererCapabilities> | null): void {
  currentCapabilities = { ...DEFAULT_RENDERER_CAPABILITIES, ...(capabilities ?? {}) }
  // cmd 档：256 色钳制——conhost（1511+）支持 256 色；hex 主题由 chalk 自动映射到 6×6×6 色立方。
  // modern 档不动 chalk.level（supports-color 既有行为零变化）。
  if (!currentCapabilities.truecolor) {
    chalk.level = 2
  }
}

export function getRendererCapabilities(): RendererCapabilities {
  return currentCapabilities
}

/** 鼠标预设发射门控：能力集 mouse=false → 空串（绝不发跟踪序列）。
 *  mouse=true 时保持既有语义（先 DISABLE 落地精确状态；off 也发 DISABLE——与现状一致）。 */
export function mousePresetFor(mode: MouseTrackingMode): string {
  if (!currentCapabilities.mouse) return ''
  return DISABLE_MOUSE_TRACKING + enableMouseTrackingFor(mode)
}
