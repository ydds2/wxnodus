import { Event } from './event.js'

/**
 * Modifier keys observed at press time. Decoded from the SGR mouse button
 * code (0x04 = shift, 0x08 = alt, 0x10 = ctrl). metaKey is always false —
 * the SGR encoding has no meta bit (xterm.js drops metaKey before encoding).
 */
export interface ClickModifiers {
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
}

export const NO_MODIFIERS: ClickModifiers = {
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false
}

/** Decode SGR button-code modifier bits (0x04 shift / 0x08 alt / 0x10 ctrl). */
export function modifiersFromButton(button: number): ClickModifiers {
  return {
    shiftKey: (button & 0x04) !== 0,
    ctrlKey: (button & 0x10) !== 0,
    altKey: (button & 0x08) !== 0,
    metaKey: false
  }
}

/**
 * Mouse click event. Fired on left-button release without drag, only when
 * mouse tracking is enabled (i.e. inside <AlternateScreen>).
 *
 * Bubbles from the deepest hit node up through parentNode. Call
 * stopImmediatePropagation() to prevent ancestors' onClick from firing.
 */
export class ClickEvent extends Event {
  /** 0-indexed screen column of the click */
  readonly col: number
  /** 0-indexed screen row of the click */
  readonly row: number
  /**
   * Click column relative to the current handler's Box (col - box.x).
   * Recomputed by dispatchClick before each handler fires, so an onClick
   * on a container sees coords relative to that container, not to any
   * child the click landed on.
   */
  localCol = 0
  /** Click row relative to the current handler's Box (row - box.y). */
  localRow = 0
  /**
   * True if the clicked cell has no visible content (unwritten in the
   * screen buffer — both packed words are 0). Handlers can check this to
   * ignore clicks on blank space to the right of text, so accidental
   * clicks on empty terminal space don't toggle state.
   */
  readonly cellIsBlank: boolean

  /** Shift was held at press time (SGR bit 0x04). */
  readonly shiftKey: boolean
  /** Ctrl was held at press time (SGR bit 0x10). */
  readonly ctrlKey: boolean
  /** Alt was held at press time (SGR bit 0x08). */
  readonly altKey: boolean
  /** Always false — the SGR encoding has no meta bit. */
  readonly metaKey: boolean

  constructor(col: number, row: number, cellIsBlank: boolean, modifiers: ClickModifiers = NO_MODIFIERS) {
    super()
    this.col = col
    this.row = row
    this.cellIsBlank = cellIsBlank
    this.shiftKey = modifiers.shiftKey
    this.ctrlKey = modifiers.ctrlKey
    this.altKey = modifiers.altKey
    this.metaKey = modifiers.metaKey
  }
}
