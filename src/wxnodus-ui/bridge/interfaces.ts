import type { MouseTrackingMode, ScrollBoxHandle } from '@wxnodus/ink'
import type { MutableRefObject, ReactNode, RefObject, SetStateAction } from 'react'

import type { PasteEvent } from '../components/textInput.js'
import type { GatewayClient } from '../gatewayClient.js'
import type { ImageAttachResponse, SessionCloseResponse } from '../gatewayTypes.js'
import type { ParsedVoiceRecordKey } from '../lib/platform.js'
import type { RpcResult } from '../lib/rpc.js'
import type { Theme } from '../theme.js'
import type {
  ApprovalReq,
  ClarifyReq,
  ConfirmReq,
  DetailsMode,
  Msg,
  PanelSection,
  Role,
  SecretReq,
  SectionVisibility,
  SessionInfo,
  SlashCatalog,
  SudoReq,
  Usage
} from '../types.js'

export interface StateSetter<T> {
  (value: SetStateAction<T>): void
}

export type StatusBarMode = 'bottom' | 'off' | 'top'

export type BusyInputMode = 'interrupt' | 'queue' | 'steer'

export type NoticeLevel = 'error' | 'info' | 'success' | 'warn'

// Credits/usage notice surfaced in the status bar. Shape is snake_case to
// match the gateway WS wire (`notification.show` payload) and the existing
// `Usage` type — no camelCase mapping layer. The `text` already carries its
// own leading glyph (⚠ • ✕ ✓) from the Python policy, so the renderer only
// colours it by `level` and never adds another glyph.
export interface Notice {
  id?: string
  key?: string
  kind?: 'sticky' | 'ttl'
  level?: NoticeLevel
  text: string
  ttl_ms?: null | number
}

// Single source of truth for indicator style names.  Union type is
// derived from this tuple so adding/removing a style only touches one
// line — `useConfigSync` (validation) and `session.ts` (slash arg
// validation + usage hint) both import it.
export const INDICATOR_STYLES = ['ascii', 'emoji', 'kaomoji', 'unicode'] as const
export type IndicatorStyle = (typeof INDICATOR_STYLES)[number]
export const DEFAULT_INDICATOR_STYLE: IndicatorStyle = 'kaomoji'

export interface SelectionApi {
  captureScrolledRows: (firstRow: number, lastRow: number, side: 'above' | 'below') => void
  clearSelection: () => void
  copySelection: () => Promise<string>
  copySelectionNoClear: () => Promise<string>
  getState: () => unknown
  version: () => number
  shiftAnchor: (dRow: number, minRow: number, maxRow: number) => void
  shiftSelection: (dRow: number, minRow: number, maxRow: number) => void
}

export interface CompletionItem {
  display: string
  meta?: string
  text: string
}

export interface GatewayRpc {
  <T extends RpcResult = RpcResult>(method: string, params?: Record<string, unknown>): Promise<null | T>
}

export interface GatewayServices {
  gw: GatewayClient
  rpc: GatewayRpc
}

export interface GatewayProviderProps {
  children: ReactNode
  value: GatewayServices
}

export interface OverlayState {
  agents: boolean
  agentsInitialHistoryIndex: number
  approval: ApprovalReq | null
  clarify: ClarifyReq | null
  commandPalette: boolean
  confirm: ConfirmReq | null
  modelPicker: boolean
  pager: null | PagerState
  pluginsHub: boolean
  secret: null | SecretReq
  sessions: boolean
  skillsHub: boolean
  sudo: null | SudoReq
  /** 动态内容表（多字段敏感输入） */
  form: null | FormReq
}

export interface FormReq {
  requestId: string
  fields: Array<{ name: string; label?: string; kind: 'text' | 'password' | 'key' }>
  prompt: string
}

export interface PagerState {
  lines: string[]
  offset: number
  title?: string
}

export interface TranscriptRow {
  index: number
  key: string
  msg: Msg
}

export interface UiState {
  bgTasks: Set<string>
  busy: boolean
  busyInputMode: BusyInputMode
  compact: boolean
  detailsMode: DetailsMode
  detailsModeCommandOverride: boolean
  info: null | SessionInfo
  liveSessionCount: number
  inlineDiffs: boolean
  mouseTracking: MouseTrackingMode
  notice: Notice | null
  pasteCollapseLines: number
  pasteCollapseChars: number

  sections: SectionVisibility
  sessionTitle: string
  showCost: boolean
  showReasoning: boolean
  indicatorStyle: IndicatorStyle
  sid: null | string
  status: string
  statusBar: StatusBarMode
  streaming: boolean
  theme: Theme
  usage: Usage
  /** A7：系统电池（system.battery RPC 轮询；无电池/不可用 → null） */
  battery: BatteryInfo | null
  /**
   * A19：鼠标单击选中的消息快照（点击时固定——流式更新不影响副本）。
   * null 表示无选中。Esc / Ctrl+C / 点击空白 / 再次单击取消。
   */
  selectedMessage: null | SelectedMessage
  /** A19：鼠标辅助提示（选中/悬停/复制反馈，3s 自动清除）。 */
  selectionHint: null | string
}

/**
 * A19：消息区鼠标点选的快照。`key` 是虚拟行 key（appLayout row.key），
 * 用于选中高亮匹配；`text` 是点击瞬间的整条消息文本（复制用）。
 */
export interface SelectedMessage {
  key: string
  text: string
  role: Role
}

// A7：电池状态（参考 SystemBatteryResponse 同款形状）
export type BatteryCategory = 'bad' | 'critical' | 'dim' | 'good' | 'warn'

export interface BatteryInfo {
  available: boolean
  category: BatteryCategory
  percent: null | number
  plugged: null | boolean
}

export interface VirtualHistoryState {
  bottomSpacer: number
  end: number
  measureRef: (key: string) => (el: unknown) => void
  offsets: ArrayLike<number>
  start: number
  topSpacer: number
}

export interface ComposerPasteResult {
  cursor: number
  value: string
}

export type MaybePromise<T> = Promise<T> | T

export interface ComposerActions {
  /** A22 鼠标化：补全行点击接受（与 Tab 接受同语义——含 / 前缀剥离） */
  acceptCompletion: (index: number) => void
  clearIn: () => void
  dequeue: () => string | undefined
  enqueue: (text: string) => void
  handleTextPaste: (event: PasteEvent) => MaybePromise<ComposerPasteResult | null>
  openEditor: () => Promise<void>
  pushHistory: (text: string) => void
  removeQueue: (index: number) => void
  replaceQueue: (index: number, text: string) => void
  setCompIdx: StateSetter<number>
  setHistoryIdx: StateSetter<null | number>
  setInput: StateSetter<string>
  setInputBuf: StateSetter<string[]>
  setPasteSnips: StateSetter<PasteSnippet[]>
  setQueueEdit: (index: null | number) => void
  syncQueue: () => void
}

export interface ComposerRefs {
  historyDraftRef: MutableRefObject<string>
  historyRef: MutableRefObject<string[]>
  queueEditRef: MutableRefObject<null | number>
  queueRef: MutableRefObject<string[]>
  submitRef: MutableRefObject<(value: string) => void>
}

export interface ComposerState {
  compIdx: number
  compReplace: number
  completions: CompletionItem[]
  historyIdx: null | number
  input: string
  inputBuf: string[]
  pasteSnips: PasteSnippet[]
  queueEditIdx: null | number
  queuedDisplay: string[]
}

export interface UseComposerStateOptions {
  gw: GatewayClient
  onClipboardPaste: (quiet?: boolean) => Promise<void> | void
  onImageAttached?: (info: ImageAttachResponse) => void
  submitRef: MutableRefObject<(value: string) => void>
}

export interface UseComposerStateResult {
  actions: ComposerActions
  refs: ComposerRefs
  state: ComposerState
}

export interface InputHandlerActions {
  answerClarify: (answer: string) => void
  appendMessage: (msg: Msg) => void
  die: () => void
  dispatchSubmission: (full: string) => void
  guardBusySessionSwitch: (what?: string) => boolean
  newSession: (msg?: string, title?: string) => void
  sys: (text: string) => void
}

export interface InputHandlerContext {
  actions: InputHandlerActions
  composer: {
    actions: ComposerActions
    refs: ComposerRefs
    state: ComposerState
  }
  gateway: GatewayServices
  terminal: {
    hasSelection: boolean
    scrollRef: RefObject<null | ScrollBoxHandle>
    scrollWithSelection: (delta: number) => void
    selection: SelectionApi
    stdout?: NodeJS.WriteStream
  }
  voice: {
    enabled: boolean
    recordKey: ParsedVoiceRecordKey
    recording: boolean
    setProcessing: StateSetter<boolean>
    setRecording: StateSetter<boolean>
    setVoiceEnabled: StateSetter<boolean>
    setVoiceTts: StateSetter<boolean>
  }
  wheelStep: number
}

export interface InputHandlerResult {
  pagerPageSize: number
}

export interface GatewayEventHandlerContext {
  composer: {
    setInput: StateSetter<string>
  }
  gateway: GatewayServices
  session: {
    STARTUP_RESUME_ID: string
    colsRef: MutableRefObject<number>
    newSession: (msg?: string, title?: string) => void
    // Set by useMainApp's exit handler to the session that was live when the
    // gateway died unexpectedly; consumed once by the next `gateway.ready` so a
    // respawn resumes that session instead of forging a fresh one.
    recoverSidRef?: MutableRefObject<null | string>
    resetSession: () => void
    resumeById: (id: string) => void
    setCatalog: StateSetter<null | SlashCatalog>
  }
  submission: {
    submitRef: MutableRefObject<(value: string) => void>
  }
  system: {
    bellOnComplete: boolean
    stdout?: NodeJS.WriteStream
    sys: (text: string) => void
  }
  transcript: {
    appendMessage: (msg: Msg) => void
    panel: (title: string, sections: PanelSection[]) => void
    setHistoryItems: StateSetter<Msg[]>
  }
  voice: {
    setProcessing: StateSetter<boolean>
    setRecording: StateSetter<boolean>
    setVoiceEnabled: StateSetter<boolean>
    setVoiceTts: StateSetter<boolean>
  }
}

export interface SlashHandlerContext {
  composer: {
    enqueue: (text: string) => void
    hasSelection: boolean
    paste: (quiet?: boolean) => void
    queueRef: MutableRefObject<string[]>
    selection: SelectionApi
    setInput: StateSetter<string>
  }
  gateway: GatewayServices
  local: {
    catalog: null | SlashCatalog
    getHistoryItems: () => Msg[]
    getLastUserMsg: () => string
    maybeWarn: (value: unknown) => void
    setCatalog: StateSetter<null | SlashCatalog>
  }
  session: {
    closeSession: (targetSid?: null | string) => Promise<unknown>
    die: () => void
    dieWithCode: (code: number) => void
    guardBusySessionSwitch: (what?: string) => boolean
    newLiveSession: (msg?: string, title?: string) => void
    newSession: (msg?: string, title?: string) => void
    resetVisibleHistory: (info?: null | SessionInfo) => void
    resumeById: (id: string) => void
    setSessionStartedAt: StateSetter<number>
  }
  slashFlightRef: MutableRefObject<number>
  transcript: {
    page: (text: string, title?: string) => void
    panel: (title: string, sections: PanelSection[]) => void
    send: (text: string) => void
    setHistoryItems: StateSetter<Msg[]>
    sys: (text: string) => void
    trimLastExchange: (items: Msg[]) => Msg[]
  }
  voice: {
    setVoiceEnabled: StateSetter<boolean>
    setVoiceRecordKey: (v: ParsedVoiceRecordKey) => void
    setVoiceTts: StateSetter<boolean>
  }
}

export interface AppLayoutActions {
  answerApproval: (choice: string) => void
  answerClarify: (answer: string) => void
  answerSecret: (value: string) => void
  answerSudo: (pw: string) => void
  answerForm: (values: Record<string, string>) => void
  cancelForm: () => void
  clearSelection: () => void
  activateLiveSession: (id: string) => void
  closeLiveSession: (id: string) => Promise<null | SessionCloseResponse>
  newLiveSession: () => void
  newPromptSession: (prompt: string, modelArg?: string) => void
  onModelSelect: (value: string) => void
  resumeById: (id: string) => void
  setStickyPrompt: (value: string) => void
  /** A20：麦克风钮（缺键盘场景鼠标触发录音开关——与 Ctrl+B 同链路） */
  toggleVoice: () => void
}

export interface AppLayoutComposerProps {
  /** A22 鼠标化：补全行点击接受（与 Tab 接受同语义） */
  acceptCompletion: (index: number) => void
  cols: number
  compIdx: number
  completions: CompletionItem[]
  empty: boolean
  handleTextPaste: (event: PasteEvent) => MaybePromise<ComposerPasteResult | null>
  input: string
  inputBuf: string[]
  pagerPageSize: number
  queueEditIdx: null | number
  queuedDisplay: string[]
  submit: (value: string) => void
  updateInput: StateSetter<string>
  voiceRecordKey: ParsedVoiceRecordKey
}

export interface AppLayoutProgressProps {
  showProgressArea: boolean
}

export interface AppLayoutStatusProps {
  cwdLabel: string
  goodVibesTick: number
  lastTurnEndedAt: null | number
  sessionStartedAt: null | number
  showStickyPrompt: boolean
  statusColor: string
  stickyPrompt: string
  turnStartedAt: null | number
  voiceLabel: string
  /** A20：麦克风钮状态（语音模式开启/录音中） */
  voiceEnabled: boolean
  voiceRecording: boolean
}

export interface AppLayoutTranscriptProps {
  historyItems: Msg[]
  scrollRef: RefObject<null | ScrollBoxHandle>
  virtualHistory: VirtualHistoryState
  virtualRows: TranscriptRow[]
}

export interface AppLayoutProps {
  actions: AppLayoutActions
  composer: AppLayoutComposerProps
  mouseTracking: MouseTrackingMode
  progress: AppLayoutProgressProps
  status: AppLayoutStatusProps
  transcript: AppLayoutTranscriptProps
}

export interface AppOverlaysProps {
  cols: number
  compIdx: number
  completions: CompletionItem[]
  /** A22 鼠标化：补全行点击接受（与 Tab 接受同语义） */
  onCompletionSelect: (index: number) => void
  onApprovalChoice: (choice: string) => void
  onClarifyAnswer: (value: string) => void
  onActiveSessionSelect: (sessionId: string) => void
  onActiveSessionClose: (sessionId: string) => Promise<null | SessionCloseResponse>
  onModelSelect: (value: string) => void
  onNewLiveSession: () => void
  onNewPromptSession: (prompt: string, modelArg?: string) => void
  /** Ctrl+K 命令面板执行（命令/技能 → 提交输入流） */
  onPaletteSubmit: (text: string) => void
  onResumeSelect: (sessionId: string) => void
  onSecretSubmit: (value: string) => void
  onSudoSubmit: (pw: string) => void
  /** 动态内容表提交/取消（敏感输入——值仅内存回传） */
  onFormSubmit: (values: Record<string, string>) => void
  onFormCancel: () => void
  pagerPageSize: number
}

export interface PasteSnippet {
  label: string
  path?: string
  text: string
}
