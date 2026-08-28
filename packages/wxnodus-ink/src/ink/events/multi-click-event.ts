import { Event } from './event.js'
import type { ClickModifiers } from './click-event.js'
import { NO_MODIFIERS } from './click-event.js'

/**
 * DOM multi-click event. Fired on the RELEASE of a double/triple click on
 * top of ink's own word/line selection — the word/line highlight from
 * `onMultiClick` stays live so a subsequent drag can still extend it.
 *
 * Only nodes that declare an `onMultiClick` handler receive it (it is a
 * separate channel from `onClick`, so existing single-click handlers are
 * never invoked twice by a double-click). Bubbles like ClickEvent; call
 * stopImmediatePropagation() to stop bubbling.
 */
export class MultiClickEvent extends Event {
  /** 0-indexed screen column of the click */
  readonly col: number
  /** 0-indexed screen row of the click */
  readonly row: number
  /** Column relative to the current handler's Box (recomputed per handler). */
  localCol = 0
  /** Row relative to the current handler's Box (recomputed per handler). */
  localRow = 0
  /** True if the clicked cell has no visible content. */
  readonly cellIsBlank: boolean
  /** 2 = double-click, 3 = triple-click (capped at 3 for quadruple+). */
  readonly clickCount: 2 | 3

  /** Shift was held at press time (SGR bit 0x04). */
  readonly shiftKey: boolean
  /** Ctrl was held at press time (SGR bit 0x10). */
  readonly ctrlKey: boolean
  /** Alt was held at press time (SGR bit 0x08). */
  readonly altKey: boolean
  /** Always false — the SGR encoding has no meta bit. */
  readonly metaKey: boolean

  constructor(
    col: number,
    row: number,
    cellIsBlank: boolean,
    clickCount: 2 | 3,
    modifiers: ClickModifiers = NO_MODIFIERS
  ) {
    super()
    this.col = col
    this.row = row
    this.cellIsBlank = cellIsBlank
    this.clickCount = clickCount
    this.shiftKey = modifiers.shiftKey
    this.ctrlKey = modifiers.ctrlKey
    this.altKey = modifiers.altKey
    this.metaKey = modifiers.metaKey
  }
}
