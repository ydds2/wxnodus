import { describe, expect, it, vi } from 'vitest'

import { handleMouseEvent } from './components/App.js'
import { modifiersFromButton } from './events/click-event.js'
import { createSelectionState, hasSelection, startSelection, updateSelection } from './selection.js'

const makeApp = () => {
  const selection = createSelectionState()

  return {
    clickCount: 0,
    lastClickCol: -1,
    lastClickRow: -1,
    lastClickTime: 0,
    lastHoverCol: -1,
    lastHoverRow: -1,
    lastPressModifiers: modifiersFromButton(0),
    mouseCaptureTarget: undefined,
    pendingHyperlinkTimer: null,
    props: {
      getHyperlinkAt: vi.fn(() => undefined),
      getSelectedText: vi.fn(() => ''),
      onCopySelectionNoClear: vi.fn(async () => ''),
      onHoverAt: vi.fn(),
      onClickAt: vi.fn(() => false),
      onMouseDownAt: vi.fn(),
      onMouseDragAt: vi.fn(),
      onMouseUpAt: vi.fn(),
      // 模拟真实多击选词（ink 内部 selectWordAt 会设 anchor+focus）
      onMultiClick: vi.fn((col: number, row: number) => {
        startSelection(selection, col, row)
        updateSelection(selection, col + 2, row)
      }),
      onMultiClickAt: vi.fn(() => false),
      onOpenHyperlink: vi.fn(),
      onSelectionChange: vi.fn(),
      selection
    }
  } as any
}

/** press + release at the same cell — a single complete click. */
const click = (app: any, button = 0, col = 5, row = 2) => {
  handleMouseEvent(app, { action: 'press', button, col, kind: 'mouse', row })
  handleMouseEvent(app, { action: 'release', button, col, kind: 'mouse', row })
}

describe('modifiersFromButton — SGR 修饰键位映射', () => {
  it('bit 0x04 = shift', () => {
    expect(modifiersFromButton(0x04)).toEqual({ shiftKey: true, ctrlKey: false, altKey: false, metaKey: false })
  })

  it('bit 0x08 = alt', () => {
    expect(modifiersFromButton(0x08)).toEqual({ shiftKey: false, ctrlKey: false, altKey: true, metaKey: false })
  })

  it('bit 0x10 = ctrl', () => {
    expect(modifiersFromButton(0x10)).toEqual({ shiftKey: false, ctrlKey: true, altKey: false, metaKey: false })
  })

  it('组合位与无修饰', () => {
    expect(modifiersFromButton(0x14)).toEqual({ shiftKey: true, ctrlKey: true, altKey: false, metaKey: false })
    expect(modifiersFromButton(0x00)).toEqual({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false })
  })
})

describe('handleMouseEvent — 修饰键透传 DOM onClick', () => {
  it('Shift+单击 → onClickAt 收到 shiftKey', () => {
    const app = makeApp()

    click(app, 0x04)

    expect(app.props.onClickAt).toHaveBeenCalledWith(4, 1, expect.objectContaining({ shiftKey: true }))
  })

  it('Ctrl+单击 → onClickAt 收到 ctrlKey（与 shift 区分）', () => {
    const app = makeApp()

    click(app, 0x10)

    expect(app.props.onClickAt).toHaveBeenCalledWith(4, 1, expect.objectContaining({ ctrlKey: true, shiftKey: false }))
  })

  it('无修饰键单击 → onClickAt 收到全 false', () => {
    const app = makeApp()

    click(app, 0)

    expect(app.props.onClickAt).toHaveBeenCalledWith(4, 1, expect.objectContaining({ shiftKey: false, ctrlKey: false, altKey: false }))
  })
})

describe('handleMouseEvent — 多击 DOM 派发（onMultiClickAt）', () => {
  it('单击只走 onClickAt，不触发 onMultiClickAt', () => {
    const app = makeApp()

    click(app)

    expect(app.props.onClickAt).toHaveBeenCalledTimes(1)
    expect(app.props.onMultiClickAt).not.toHaveBeenCalled()
  })

  it('双击 → 第一击 onClickAt + 释放派发 onMultiClickAt(count=2)，且保留选词高亮', () => {
    const app = makeApp()

    click(app)
    click(app)

    expect(app.props.onClickAt).toHaveBeenCalledTimes(1)
    expect(app.props.onMultiClickAt).toHaveBeenCalledWith(4, 1, 2, expect.anything())
    // ink 内部选词仍活跃（拖拽可继续按词扩展）
    expect(hasSelection(app.props.selection)).toBe(true)
  })

  it('三击 → onMultiClickAt(count=3)（cap 上限）', () => {
    const app = makeApp()

    click(app)
    click(app)
    click(app)

    expect(app.props.onMultiClickAt).toHaveBeenCalledTimes(2)
    expect(app.props.onMultiClickAt).toHaveBeenLastCalledWith(4, 1, 3, expect.anything())
  })

  it('修饰键随多击透传（Ctrl+双击）', () => {
    const app = makeApp()

    click(app, 0x10)
    click(app, 0x10)

    expect(app.props.onMultiClickAt).toHaveBeenCalledWith(4, 1, 2, expect.objectContaining({ ctrlKey: true }))
  })

  it('间隔超过 500ms 的第二次单击不是多击（clickCount 重置）', () => {
    const app = makeApp()
    let fakeNow = 1_000_000

    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    click(app)
    fakeNow += 1000
    click(app)

    expect(app.props.onClickAt).toHaveBeenCalledTimes(2)
    expect(app.props.onMultiClickAt).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
