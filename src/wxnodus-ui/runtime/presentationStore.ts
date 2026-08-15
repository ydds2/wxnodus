// src/wxnodus-ui/runtime/presentationStore.ts — 阶段 2：presentation read-model 的存取 seam
// view-only：只读快照 + 经 reducer 的事件分发。迁移期与 flowStore/viewStore 并行，
// 不夺走 operational source of truth；组件经 usePresentationSelector 读取。
import { useSyncExternalStore } from 'react'

import { createAtom as atom } from '../../app/stores/engine.js'

import {
  initialPresentationState,
  presentationReducer,
  type PresentationEvent,
  type PresentationState
} from './presentationReducer.js'

export const $presentation = atom<PresentationState>(initialPresentationState())

export const getPresentationState = (): PresentationState => $presentation.get()

/** 经 reducer 分发（纯函数确定性快照）；迟到事件由 reducer 守卫丢弃。 */
export const dispatchPresentationEvent = (event: PresentationEvent): void =>
  $presentation.set(presentationReducer($presentation.get(), event))

export const resetPresentationState = (): void => $presentation.set(initialPresentationState())

const subscribePresentation = (cb: () => void) => $presentation.listen(() => cb())

export const usePresentationSelector = <T>(selector: (state: PresentationState) => T): T =>
  useSyncExternalStore(
    subscribePresentation,
    () => selector($presentation.get()),
    () => selector($presentation.get())
  )
