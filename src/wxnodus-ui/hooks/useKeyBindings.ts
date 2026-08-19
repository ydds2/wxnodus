import { getActiveKeymap, matchesAny } from '../config/keymap.js'
import { forceRedraw, useInput } from '@wxnodus/ink'
import { useAtom as useStore } from '../../app/stores/engine.js'
import { useEffect, useRef } from 'react'

import { TYPING_IDLE_MS } from '../config/timing.js'
import type {
  ApprovalRespondResponse,
  CommandDispatchResponse,
  SecretRespondResponse,
  SudoRespondResponse,
  VoiceRecordResponse
} from '../gatewayTypes.js'
import { isAction, isCopyShortcut, isMac, isVoiceToggleKey } from '../lib/platform.js'
import { hunkJump } from '../lib/wordDiff.js'
import { computePrecisionWheelStep, initPrecisionWheel } from '../lib/precisionWheel.js'
import { computeWheelStep, initWheelAccelForHost } from '../lib/wheelAccel.js'
import { nextPermMode } from '../lib/permCycle.js'

import { getInputSelection } from '../runtime/selectionStore.js'
import type { InputHandlerContext, InputHandlerResult } from '../bridge/interfaces.js'
import { $isBlocked, $overlayState, patchOverlayState } from '../runtime/promptStore.js'
import { turnController } from '../runtime/flowController.js'
import { clearSelectedMessage, showSelectionHint } from '../runtime/viewStore.js'
import { writeClipboardText } from '../lib/clipboard.js'
import { escCancelNext } from '../lib/escCancel.js'
import { patchTurnState } from '../runtime/flowStore.js'
import { getUiState } from '../runtime/viewStore.js'

const isCtrl = (key: { ctrl: boolean }, ch: string, target: string) => key.ctrl && ch.toLowerCase() === target

/**
 * Approval / clarify / confirm overlays mount their own `useInput` handlers
 * for the in-prompt keys (arrows, numbers, Enter, sometimes Esc).  The global
 * input handler used to early-return for any other key while one of those
 * overlays was up, which silently disabled transcript scrolling — the user
 * couldn't read context above the prompt that the prompt itself was asking
 * about.  Returns true when the key is a transcript-scroll input that should
 * fall through to the global scroll handlers even while a prompt is active.
 *
 * Modifier-held wheel (precision mode) is included — a user who wants to
 * scroll a single line at a time during a prompt expects it to work.
 */
export function shouldFallThroughForScroll(key: {
  downArrow: boolean
  pageDown: boolean
  pageUp: boolean
  shift: boolean
  upArrow: boolean
  wheelDown: boolean
  wheelUp: boolean
}): boolean {
  if (key.wheelUp || key.wheelDown) {
    return true
  }

  if (key.pageUp || key.pageDown) {
    return true
  }

  if (key.shift && (key.upArrow || key.downArrow)) {
    return true
  }

  return false
}

export function applyVoiceRecordResponse(
  response: null | VoiceRecordResponse,
  starting: boolean,
  voice: Pick<InputHandlerContext['voice'], 'setProcessing' | 'setRecording'>,
  sys: (text: string) => void
) {
  if (!starting || response?.status === 'recording') {
    return
  }

  voice.setRecording(false)

  if (response?.status === 'busy') {
    voice.setProcessing(true)
    sys('voice: still transcribing; try again shortly')
  } else {
    voice.setProcessing(false)
  }
}

export function useInputHandlers(ctx: InputHandlerContext): InputHandlerResult {
  const { actions, composer, gateway, terminal, voice, wheelStep } = ctx
  const { actions: cActions, refs: cRefs, state: cState } = composer

  const overlay = useStore($overlayState)
  const isBlocked = useStore($isBlocked)
  const pagerPageSize = Math.max(5, (terminal.stdout?.rows ?? 24) - 6)
  const scrollIdleTimer = useRef<null | ReturnType<typeof setTimeout>>(null)

  // Wheel accel ported from claude-code: inter-event timing drives step size,
  // direction flips reset. wheelStep (WHEEL_SCROLL_STEP) is the base; final
  // rows = wheelStep × accelMult. State mutates in place across renders.
  const wheelAccelRef = useRef(initWheelAccelForHost())

  const precisionWheelRef = useRef(initPrecisionWheel())

  // 双 Esc 取消武装时间（busy 时第一次 Esc 记录，窗口内第二次 Esc 确认中断）
  const escCancelArmedAtRef = useRef<number | null>(null)

  useEffect(() => () => clearTimeout(scrollIdleTimer.current ?? undefined), [])

  const scrollTranscript = (delta: number) => {
    if (getUiState().busy) {
      turnController.boostStreamingForScroll()
      clearTimeout(scrollIdleTimer.current ?? undefined)
      scrollIdleTimer.current = setTimeout(() => {
        scrollIdleTimer.current = null
        turnController.relaxStreaming()
      }, TYPING_IDLE_MS)
    }

    terminal.scrollWithSelection(delta)
  }

  const copySelection = () => {
    // ink's copySelection() already calls setClipboard() which handles
    // pbcopy (macOS), wl-copy/xclip (Linux), tmux, and OSC 52 fallback.
    terminal.selection.copySelection()
  }

  const clearSelection = () => {
    terminal.selection.clearSelection()
  }

  const cancelOverlayFromCtrlC = () => {
    if (overlay.clarify) {
      return actions.answerClarify('')
    }

    if (overlay.approval) {
      return gateway
        .rpc<ApprovalRespondResponse>('approval.respond', { choice: 'deny', session_id: getUiState().sid })
        .then(r => r && (patchOverlayState({ approval: null }), patchTurnState({ outcome: 'denied' })))
    }

    if (overlay.sudo) {
      return gateway
        .rpc<SudoRespondResponse>('sudo.respond', { password: '', request_id: overlay.sudo.requestId })
        .then(r => r && (patchOverlayState({ sudo: null }), actions.sys('sudo cancelled')))
    }

    if (overlay.secret) {
      return gateway
        .rpc<SecretRespondResponse>('secret.respond', { request_id: overlay.secret.requestId, value: '' })
        .then(r => r && (patchOverlayState({ secret: null }), actions.sys('secret entry cancelled')))
    }

    if (overlay.modelPicker) {
      return patchOverlayState({ modelPicker: false })
    }

    if (overlay.skillsHub) {
      return patchOverlayState({ skillsHub: false })
    }

    if (overlay.commandPalette) {
      return patchOverlayState({ commandPalette: false })
    }

    if (overlay.pluginsHub) {
      return patchOverlayState({ pluginsHub: false })
    }

    if (overlay.sessions) {
      return patchOverlayState({ sessions: false })
    }

    if (overlay.agents) {
      return patchOverlayState({ agents: false })
    }
  }

  const cycleQueue = (dir: 1 | -1) => {
    const len = cRefs.queueRef.current.length

    if (!len) {
      return false
    }

    const index = cState.queueEditIdx === null ? (dir > 0 ? 0 : len - 1) : (cState.queueEditIdx + dir + len) % len

    cActions.setQueueEdit(index)
    cActions.setHistoryIdx(null)
    cActions.setInput(cRefs.queueRef.current[index] ?? '')

    return true
  }

  const cycleHistory = (dir: 1 | -1) => {
    const h = cRefs.historyRef.current
    const cur = cState.historyIdx

    if (dir < 0) {
      if (!h.length) {
        return
      }

      if (cur === null) {
        cRefs.historyDraftRef.current = cState.input
      }

      const index = cur === null ? h.length - 1 : Math.max(0, cur - 1)

      cActions.setHistoryIdx(index)
      cActions.setQueueEdit(null)
      cActions.setInput(h[index] ?? '')

      return
    }

    if (cur === null) {
      return
    }

    const next = cur + 1

    if (next >= h.length) {
      cActions.setHistoryIdx(null)
      cActions.setInput(cRefs.historyDraftRef.current)
    } else {
      cActions.setHistoryIdx(next)
      cActions.setInput(h[next] ?? '')
    }
  }

  // CLI parity: Ctrl+B toggles a VAD-bounded push-to-talk capture
  // (NOT the voice-mode umbrella bit). The mode is enabled via /voice on;
  // Ctrl+B while the mode is off sys-nudges the user. While the mode is
  // on, the first press starts a single VAD-bounded capture
  // (gateway -> start_continuous(auto_restart=false), VAD auto-stop ->
  // transcribe -> idle), a subsequent press stops and transcribes it.
  // The gateway publishes voice.status + voice.transcript events that
  // createGatewayEventHandler turns into UI badges and composer injection.
  const voiceRecordToggle = () => {
    if (!voice.enabled) {
      return actions.sys('voice: mode is off — enable with /voice on')
    }

    const starting = !voice.recording
    const action = starting ? 'start' : 'stop'

    // Optimistic UI — flip the REC badge immediately so the user gets
    // feedback while the RPC round-trips; the voice.status event is the
    // authoritative source and may correct us.
    if (starting) {
      voice.setRecording(true)
    } else {
      voice.setRecording(false)
      voice.setProcessing(false)
    }

    gateway
      .rpc<VoiceRecordResponse>('voice.record', { action, session_id: getUiState().sid })
      .then(r => applyVoiceRecordResponse(r, starting, voice, actions.sys))
      .catch((e: Error) => {
        // Revert optimistic UI on failure.
        if (starting) {
          voice.setRecording(false)
        }

        actions.sys(`voice error: ${e.message}`)
      })
  }

  useInput((ch, key) => {
    const live = getUiState()

    // A19：开始输入（可打印字符/编辑键）即取消消息选中——选中态只在
    // 空闲交互时有效，避免 stale 选中截胡后续 Ctrl+C 语义。
    if (live.selectedMessage && (ch || key.enter || key.backspace || key.delete || key.tab)) {
      clearSelectedMessage()
    }

    // Ctrl+K 命令面板：全局最高优先级（面板开着时再按一次即关闭——toggle）
    if (isCtrl(key, ch, 'k')) {
      patchOverlayState(prev => ({ ...prev, commandPalette: !prev.commandPalette }))
      return
    }

    if (isBlocked) {
      // When approval/clarify/confirm overlays are active, their own useInput
      // handlers must receive keystrokes (arrow keys, numbers, Enter).  Only
      // intercept Ctrl+C here so the user can deny/dismiss — all other keys
      // fall through to the component-level handlers.
      //
      // Scroll inputs (wheel / PageUp / PageDown / Shift+↑↓) are special:
      // they must reach the transcript scroll handlers below even with a
      // prompt up.  Long-thread context the prompt is asking about often
      // lives above the visible viewport, and being unable to read it while
      // answering felt like the prompt had locked the entire UI.  Explicitly
      // skip the prompt-overlay early-return for scroll keys so they fall
      // through to the wheel / PageUp / Shift+arrow handlers below.
      const promptOverlay = overlay.approval || overlay.clarify || overlay.confirm
      const fallThroughForScroll = promptOverlay && shouldFallThroughForScroll(key)

      if (promptOverlay && !fallThroughForScroll) {
        if (isCtrl(key, ch, 'c')) {
          cancelOverlayFromCtrlC()
        }

        return
      }

      if (overlay.pager) {
        // supremacy 3.3：pager 键位走 settings.keymap 配置层（默认=既有行为零漂移；
        // /config set keymap '{"pagerClose":"ctrl+x"}' 等热生效）
        const km = getActiveKeymap()
        if (matchesAny(key, ch, km.pagerClose)) {
          return patchOverlayState({ pager: null })
        }

        // 2026-08-19 树面板形态：t 切换文件树索引视图（opencode 树面板的对等形态——
        // 滚动分节流 + 树索引跳转）；树视图内 ↑↓ 选文件、Enter 跳转、t 返回 diff
        if (overlay.pager.diff) {
          const d = overlay.pager.diff
          if (ch === 't') {
            patchOverlayState(prev => {
              if (!prev.pager?.diff) return prev
              const dd = prev.pager.diff
              if (dd.view === 'tree') {
                return { ...prev, pager: { title: prev.pager.title, lines: dd.diffLines ?? prev.pager.lines, offset: dd.returnOffset ?? 0, diff: { ...dd, view: 'diff', diffLines: undefined, returnOffset: undefined, treeSel: undefined } } }
              }
              const treeLines = ['文件树（↑↓ 选择 · Enter 跳转 · t 返回 diff）', '', ...dd.files.map((f, i) => `${i === 0 ? '▸ ' : '  '}${f.rel}（${f.hunks} hunk${f.hunks > 1 ? 's' : ''}）`)]
              return { ...prev, pager: { title: prev.pager.title, lines: treeLines, offset: 0, diff: { ...dd, view: 'tree', diffLines: prev.pager.lines, returnOffset: prev.pager.offset, treeSel: 0 } } }
            })
            return
          }
          if (d.view === 'tree') {
            const treeLinesFor = (dd: NonNullable<typeof d>, sel: number) => ['文件树（↑↓ 选择 · Enter 跳转 · t 返回 diff）', '', ...dd.files.map((f, i) => `${i === sel ? '▸ ' : '  '}${f.rel}（${f.hunks} hunk${f.hunks > 1 ? 's' : ''}）`)]
            const maxSel = Math.max(0, d.files.length - 1)
            if (key.upArrow) {
              return patchOverlayState(prev => {
                if (!prev.pager?.diff) return prev
                const dd = prev.pager.diff
                const sel = Math.max(0, (dd.treeSel ?? 0) - 1)
                return { ...prev, pager: { ...prev.pager, lines: treeLinesFor(dd, sel), diff: { ...dd, treeSel: sel } } }
              })
            }
            if (key.downArrow) {
              return patchOverlayState(prev => {
                if (!prev.pager?.diff) return prev
                const dd = prev.pager.diff
                const sel = Math.min(maxSel, (dd.treeSel ?? 0) + 1)
                return { ...prev, pager: { ...prev.pager, lines: treeLinesFor(dd, sel), diff: { ...dd, treeSel: sel } } }
              })
            }
            if (key.return) {
              patchOverlayState(prev => {
                if (!prev.pager?.diff) return prev
                const dd = prev.pager.diff
                const sel = dd.files[dd.treeSel ?? 0]
                if (!sel) return prev
                return { ...prev, pager: { title: prev.pager.title, lines: dd.diffLines ?? prev.pager.lines, offset: sel.start, diff: { ...dd, view: 'diff', diffLines: undefined, returnOffset: undefined, treeSel: undefined } } }
              })
              return
            }
          }
        }

        const move = (delta: number | 'top' | 'bottom') =>
          patchOverlayState(prev => {
            if (!prev.pager) {
              return prev
            }

            const { lines, offset } = prev.pager
            const max = Math.max(0, lines.length - pagerPageSize)
            const step = delta === 'top' ? -lines.length : delta === 'bottom' ? lines.length : delta
            const next = Math.max(0, Math.min(offset + step, max))

            return next === offset ? prev : { ...prev, pager: { ...prev.pager, offset: next } }
          })

        if (matchesAny(key, ch, km.pagerUp)) {
          return move(-1)
        }

        if (matchesAny(key, ch, km.pagerDown)) {
          return move(1)
        }

        if (matchesAny(key, ch, km.pagerHalfUp)) {
          return move(-pagerPageSize)
        }

        if (matchesAny(key, ch, km.pagerTop)) {
          return move('top')
        }

        if (matchesAny(key, ch, km.pagerBottom)) {
          return move('bottom')
        }

        // 波 2 ③：[/] hunk 跳转（opencode diff-viewer.tsx:282-315 对标——回滚 diff 等
        // 含 @@ hunk 的 pager 内容；无更多 hunk 保持原位）
        if (ch === '[' || ch === ']') {
          patchOverlayState(prev => {
            if (!prev.pager) {
              return prev
            }

            const dir: 1 | -1 = ch === ']' ? 1 : -1
            const next = hunkJump(prev.pager.lines, prev.pager.offset, dir, pagerPageSize)

            return next === null || next === prev.pager.offset
              ? prev
              : { ...prev, pager: { ...prev.pager, offset: next } }
          })

          return
        }

        // 2026-08-19 交互式 diff v2：r 回滚当前文件当前 hunk（分节元数据精确定位）；
        // m 标记已审（内容指纹持久化——变更即失效）。确认面板 onConfirm 真实执行。
        if ((ch === 'r' || ch === 'm') && overlay.pager.diff && overlay.pager.diff.view !== 'tree') {
          const { lines, offset, diff } = overlay.pager
          let section = diff.files[0]
          for (const s of diff.files) {
            if (s.start <= offset && offset < s.end) { section = s; break }
            if (s.start <= offset) section = s
          }

          if (!section) {
            return
          }

          let current = 0
          for (let i = section.start; i < Math.min(offset, section.end); i++) {
            if (/^@@ -\d/.test(lines[i]!.trim())) current++
          }

          const target = current === 0 ? 1 : current

          if (target > section.hunks) {
            return
          }

          const refresh = () => {
            void gateway
              .rpc<{ ok?: boolean; error?: string; sections?: Array<{ abs: string; rel: string; hunks: number; start: number; end: number }>; lines?: string[]; aggregate?: boolean }>(
                'diff.view',
                { ...(diff.arg ? { file: diff.arg } : {}), session_id: getUiState().sid }
              )
              .then(r => {
                patchOverlayState(prev => {
                  if (!prev.pager?.diff) {
                    return prev
                  }

                  if (r?.ok && r.lines?.length && r.sections?.length) {
                    return {
                      ...prev,
                      pager: {
                        title: prev.pager.title,
                        lines: r.lines,
                        offset: Math.min(prev.pager.offset, Math.max(0, r.lines.length - pagerPageSize)),
                        diff: { aggregate: Boolean(r.aggregate), arg: diff.arg, files: r.sections },
                      },
                    }
                  }

                  return prev
                })
              })
          }

          if (ch === 'm') {
            void gateway
              .rpc<{ ok?: boolean; output?: string; error?: string }>('diff.mark', { file: section.abs, hunk_index: target, session_id: getUiState().sid })
              .then(r => {
                if (r?.ok) {
                  if (r.output) actions.sys(r.output)
                  refresh()
                }
              })

            return
          }

          patchOverlayState({
            confirm: {
              title: `回滚 hunk ${target}/${section.hunks}？`,
              detail: `${section.rel}——该 hunk 恢复为快照内容（快照留存，/undo fs restore 可再滚回）`,
              confirmLabel: '回滚',
              cancelLabel: '取消',
              danger: true,
              onConfirm: () => {
                void gateway
                  .rpc<{ ok?: boolean; error?: string }>('diff.revert', { file: section.abs, hunk_index: target, session_id: getUiState().sid })
                  .then(r => {
                    if (r?.ok) {
                      refresh()
                    }
                  })
              },
            },
          })

          return
        }

        if (matchesAny(key, ch, km.pagerHalfDown) || key.return) {
          patchOverlayState(prev => {
            if (!prev.pager) {
              return prev
            }

            const { lines, offset } = prev.pager
            const max = Math.max(0, lines.length - pagerPageSize)

            // Auto-close only when already at the last page — otherwise clamp
            // to `max` so the offset matches what the line/page-back handlers
            // can reach (prevents a snap-back jump on the next ↑/↓/PgUp).
            return offset >= max
              ? { ...prev, pager: null }
              : { ...prev, pager: { ...prev.pager, offset: Math.min(offset + pagerPageSize, max) } }
          })
        }

        return
      }

      if (isCtrl(key, ch, 'c')) {
        cancelOverlayFromCtrlC()
      } else if (key.escape && overlay.sessions) {
        patchOverlayState({ sessions: false })
      }

      // Ctrl+R：历史反向搜索（bash readline 同款）——overlay 阻断 composer 输入，
      // 搜索组件自身 useInput 消费字符/Ctrl+R/Enter/Esc；此处只负责打开
      if (isCtrl(key, ch, 'r') && !overlay.histSearch && !cState.historyIdx) {
        return patchOverlayState({ histSearch: true })
      }

      // Ctrl+Shift+P：截图即问——一键全屏截图登记为待注入图片（下次提问经能力门：
      // 视觉模型直接看图 / 文本模型 GLM 先识别为文本）
      if (key.ctrl && key.shift && ch.toLowerCase() === 'p') {
        if (!live.sid) {
          return void actions.sys('截图即问需要活跃会话')
        }

        return void gateway.rpc<{ error?: string; ok?: boolean; file?: string }>('capture.attach', { session_id: live.sid }).then(r => {
          if (r?.ok) {
            actions.sys(`截图已附加（${r.file ? r.file.split(/[\\/]/).pop() : ''}）——直接提问，模型会看图（文本模型自动走 GLM 识别）`)
          } else if (r?.error) {
            actions.sys(`截图附加失败：${r.error}`)
          }
        })
      }

      // When a prompt overlay is up and the user pressed a scroll key, fall
      // through to the global scroll handlers below instead of returning.
      // Otherwise nothing above this comment matched, and there's nothing
      // useful to do for an arbitrary key while blocked.
      if (!fallThroughForScroll) {
        return
      }
    }

    // A3 修复：Ctrl+O 打开模型选择器（保留草稿；参考热键同款）
    if (isCtrl(key, ch, 'o')) {
      patchOverlayState({ modelPicker: true })
      return
    }

    if (cState.completions.length && cState.input && cState.historyIdx === null && (key.upArrow || key.downArrow || key.pageUp || key.pageDown)) {
      const len = cState.completions.length

      // PgUp/PgDn 翻页浏览建议（一次移动一个窗口，与建议面板 COMPLETION_WINDOW 对齐）
      if (key.pageUp || key.pageDown) {
        const PAGE = 16
        cActions.setCompIdx(i => (key.pageUp ? (i - PAGE + len) % len : (i + PAGE) % len))

        return
      }

      cActions.setCompIdx(i => (key.upArrow ? (i - 1 + len) % len : (i + 1) % len))

      return
    }

    if (key.wheelUp || key.wheelDown) {
      const dir: -1 | 1 = key.wheelUp ? -1 : 1
      const now = Date.now()
      // Modifier-held wheel = precision mode: one row per frame, no accel.
      // Smooth mice / trackpads emit tiny same-frame bursts; coalesce those
      // without the old 80ms throttle that made opt-scroll feel stepped.
      // SGR/X10 mouse encoding only carries shift/meta/ctrl bits; Cmd on
      // macOS is intercepted by the terminal, so we honor Option (meta) on
      // Mac / Alt (meta) on Win+Linux / Ctrl as a portable fallback. Shift
      // is reserved for selection extension.
      const hasModifier = key.meta || key.ctrl
      const precision = computePrecisionWheelStep(precisionWheelRef.current, dir, hasModifier, now)

      if (precision.active) {
        // Entering precision mode must discard any accelerated wheel state;
        // otherwise the next normal wheel event inherits stale momentum.
        if (precision.entered) {
          wheelAccelRef.current = initWheelAccelForHost()
        }

        return precision.rows ? scrollTranscript(dir * wheelStep) : undefined
      }

      // 0 = direction-flip bounce deferred; skip the no-op scroll.
      const rows = computeWheelStep(wheelAccelRef.current, dir, now)

      return rows ? scrollTranscript(dir * rows * wheelStep) : undefined
    }

    if (key.shift && key.upArrow) {
      return scrollTranscript(-1)
    }

    if (key.shift && key.downArrow) {
      return scrollTranscript(1)
    }

    if (key.pageUp || key.pageDown) {
      // Half-viewport keeps 50% continuity and stays under Ink's
      // `delta < innerHeight` DECSTBM fast-path threshold.
      const viewport = terminal.scrollRef.current?.getViewportHeight() ?? Math.max(6, (terminal.stdout?.rows ?? 24) - 8)
      const step = Math.max(4, Math.floor(viewport / 2))

      return scrollTranscript(key.pageUp ? -step : step)
    }

    // Escape-based voice bindings (ctrl/alt/super+escape) must win before the
    // generic Esc handlers below; otherwise queue-edit cancel / selection-clear
    // would swallow the chord and /voice would advertise a shortcut that never
    // actually toggles recording in those UI states.
    if (key.escape && isVoiceToggleKey(key, ch, voice.recordKey)) {
      return voiceRecordToggle()
    }

    // Queue-edit cancel beats selection-clear for plain Esc: the queue header
    // explicitly promises "Esc cancel", so honoring it takes priority over the
    // implicit selection-dismissal convention. Without an active edit, fall through.
    if (key.escape && cState.queueEditIdx !== null) {
      return cActions.clearIn()
    }

    if (key.escape && terminal.hasSelection) {
      return clearSelection()
    }

    // A19：Esc 取消消息选中（优先级低于 ink 选区——最近动作先清）。
    if (key.escape && getUiState().selectedMessage) {
      return clearSelectedMessage()
    }

    // 双 Esc 取消（用户需求）：busy 时第一次 Esc 武装，1.5s 窗口内第二次 Esc 确认中断
    // （与 Ctrl+C 同链路）；非 busy 或超时复位并落到下方常规 Esc 语义——非 busy/overlay
    // 场景零行为变化（overlay.sessions 等分支在上方已 return）。
    if (key.escape && live.busy && live.sid) {
      const decision = escCancelNext(
        { armedAt: escCancelArmedAtRef.current },
        { now: Date.now(), busy: live.busy }
      )
      if (decision === 'arm') {
        escCancelArmedAtRef.current = Date.now()
        // 迁移预期对齐（#10）：明示「中断」语义 + 回滚出口（Claude 用户找回滚 → /undo）
        showSelectionHint('再按 Esc 确认中断（1.5s）· 中断后 /undo 可回滚')

        return
      }
      if (decision === 'confirm') {
        escCancelArmedAtRef.current = null
        // 中断后立即指路回滚（Claude Code Esc-Esc 回滚肌肉记忆的等价出口）
        showSelectionHint('已中断 · /undo 回滚本次修改 · 输入继续对话')

        return turnController.interruptTurn({
          appendMessage: actions.appendMessage,
          gw: gateway.gw,
          sid: live.sid,
          sys: actions.sys
        })
      }
      escCancelArmedAtRef.current = null
    }

    if (key.upArrow && !cState.inputBuf.length) {
      const inputSel = getInputSelection()
      const cursor = inputSel && inputSel.start === inputSel.end ? inputSel.start : null

      const noLineAbove =
        !cState.input || (cursor !== null && cState.input.lastIndexOf('\n', Math.max(0, cursor - 1)) < 0)

      if (noLineAbove) {
        cycleQueue(1) || cycleHistory(-1)

        return
      }
    }

    if (key.downArrow && !cState.inputBuf.length) {
      const inputSel = getInputSelection()
      const cursor = inputSel && inputSel.start === inputSel.end ? inputSel.start : null
      const noLineBelow = !cState.input || (cursor !== null && cState.input.indexOf('\n', cursor) < 0)

      if (noLineBelow || cState.historyIdx !== null) {
        cycleQueue(-1) || cycleHistory(1)

        return
      }
    }

    if (isCopyShortcut(key, ch)) {
      if (terminal.hasSelection) {
        return copySelection()
      }

      // A19：消息选中 → 复制整条消息。优先级：ink 选区 > 消息选中 > 输入框选区。
      const selMsg = getUiState().selectedMessage

      if (selMsg) {
        void writeClipboardText(selMsg.text).then(ok => {
          clearSelectedMessage()

          if (ok) {
            showSelectionHint(`✓ 已复制 ${selMsg.text.length} 字符`)
          } else {
            showSelectionHint('⚠ 复制失败：无可用剪贴板通道')
          }
        })

        return
      }

      const inputSel = getInputSelection()

      if (inputSel && inputSel.end > inputSel.start) {
        inputSel.clear()

        return
      }

      // On macOS, Cmd+C with no selection is a no-op (Ctrl+C below handles interrupt).
      // On non-macOS, isAction uses Ctrl, so fall through to interrupt/clear/exit.
      if (isMac) {
        return
      }
    }

    if (isCtrl(key, ch, 'x') && cState.queueEditIdx !== null) {
      cActions.removeQueue(cState.queueEditIdx)

      return cActions.clearIn()
    }

    if (isCtrl(key, ch, 'x')) {
      return patchOverlayState({ sessions: true })
    }

    if (key.ctrl && ch.toLowerCase() === 'c') {
      if (live.busy && live.sid) {
        return turnController.interruptTurn({
          appendMessage: actions.appendMessage,
          gw: gateway.gw,
          sid: live.sid,
          sys: actions.sys
        })
      }

      if (cState.input || cState.inputBuf.length) {
        return cActions.clearIn()
      }

      // 空闲 + 空输入：无操作 + 一行提示（UX 修复：Ctrl+C 是复制/取消肌肉记忆——
      // 此前直接 die() 误杀整个会话，pty 下还曾出现渲染永久停摆；退出走 Ctrl+D / /quit）
      return actions.sys('按 Ctrl+D 或 /quit 退出；Esc 中断进行中的任务')
    }

    if (isAction(key, ch, 'd')) {
      return actions.die()
    }

    if (isAction(key, ch, 'l')) {
      clearSelection()
      forceRedraw(terminal.stdout ?? process.stdout)

      return
    }

    if (isVoiceToggleKey(key, ch, voice.recordKey)) {
      return voiceRecordToggle()
    }

    // Cmd/Ctrl+G, plus Alt+G fallback for VSCode/Cursor (they bind the
    // primary keystroke to "Find Next" before the TUI sees it; Alt+G
    // arrives as meta+g across platforms).
    if (ch.toLowerCase() === 'g' && (isAction(key, ch, 'g') || key.meta)) {
      return void cActions.openEditor().catch((err: unknown) => {
        actions.sys(err instanceof Error ? `failed to open editor: ${err.message}` : 'failed to open editor')
      })
    }

    // shift-tab 循环权限模式（claude-code parity 增强：#9 债——此前只翻转 yolo 布尔，
    // 现按 smart→auto→manual→plan→yolo→goal→smart 全序循环，状态栏徽章即时刷新）
    if (key.shift && key.tab && !cState.completions.length) {
      if (!live.sid) {
        return void actions.sys('模式循环需要活跃会话')
      }

      const next = nextPermMode(getUiState().info?.perm)
      // command.dispatch 走 /perm 命令（校验 + 审计 mode.changed），响应后
      // gateway 发布 session.info → 状态栏徽章即时刷新（T7 接线）
      return void gateway.rpc<CommandDispatchResponse>('command.dispatch', { name: 'perm', arg: next }).then(r => {
        if (r?.type === 'exec' && r.output) {
          return actions.sys(String(r.output))
        }
      })
    }

    // 波 2 ②：补全弹窗打开时 Enter 接受当前高亮（kimi prompt.py:1276-1290 双语义——
    // slash 接受即提交、path/agent 只替换；acceptCompletion 内部按 kind 区分）
    if (key.return && cState.completions.length && cState.historyIdx === null) {
      cActions.acceptCompletion(cState.compIdx)

      return
    }

    if (key.tab && cState.completions.length) {
      const row = cState.completions[cState.compIdx]

      if (row?.text) {
        const text =
          cState.input.startsWith('/') && row.text.startsWith('/') && cState.compReplace > 0
            ? row.text.slice(1)
            : row.text

        cActions.setInput(cState.input.slice(0, cState.compReplace) + text)
      }

      return
    }

    if (isAction(key, ch, 'k') && cRefs.queueRef.current.length && live.sid) {
      const next = cActions.dequeue()

      if (next) {
        cActions.setQueueEdit(null)
        actions.dispatchSubmission(next)
      }
    }
  })

  return { pagerPageSize }
}
