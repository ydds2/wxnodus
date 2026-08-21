// src/wxnodus-ui/gatewayTypes.ts — gateway RPC 请求/响应类型契约
import type { SessionInfo, SlashCategory, SubagentStatus, Usage } from './types.js'

// ── W1-01 compatibility re-exports：协议类型单一事实源（现有 response DTO 保留不动）──
export type { GatewayError } from '../protocol/errors.js'
export type { OperationResult } from '../protocol/results.js'
export type { RunFinalStatus } from '../protocol/runs.js'
export type { GatewayEvent as ProtocolGatewayEvent } from '../protocol/events.js'

export interface GatewaySkin {
  banner_hero?: string
  banner_logo?: string
  branding?: Record<string, string>
  colors?: Record<string, string>
  help_header?: string
  tool_prefix?: string
}

export interface GatewayCompletionItem {
  display: string
  meta?: string
  text: string
}

export interface GatewayTranscriptMessage {
  context?: string
  name?: string
  role: 'assistant' | 'system' | 'tool' | 'user'
  text?: string
}

// ── Commands / completion ────────────────────────────────────────────

export interface CommandsCatalogResponse {
  canon?: Record<string, string>
  categories?: SlashCategory[]
  pairs?: [string, string][]
  skill_count?: number
  sub?: Record<string, string[]>
  warning?: string
}

export interface CompletionResponse {
  items?: GatewayCompletionItem[]
  replace_from?: number
}

export interface SlashExecResponse {
  output?: string
  warning?: string
}

export type CommandDispatchResponse =
  | { output?: string; type: 'exec' | 'plugin' }
  | { target: string; type: 'alias' }
  | { message?: string; name: string; type: 'skill' }
  | { message: string; notice?: string; type: 'send' }
  | { message: string; notice?: string; type: 'prefill' }

// ── Config ───────────────────────────────────────────────────────────

export interface ConfigDisplayConfig {
  bell_on_complete?: boolean
  busy_input_mode?: string
  details_mode?: string
  inline_diffs?: boolean
  mouse_tracking?: boolean | null | number | string
  sections?: Record<string, string>
  show_cost?: boolean
  show_reasoning?: boolean
  streaming?: boolean
  thinking_mode?: string
  /**
   * Nudge the user toward the /agents spawn-tree dashboard the first time a
   * turn starts delegating, via a one-time transient activity hint.  Opens
   * nothing — just advertises the command.  Default true.
   */
  tui_agents_nudge?: boolean
  tui_auto_resume_recent?: boolean
  tui_compact?: boolean
  /** Legacy alias for display.mouse_tracking. */
  tui_mouse?: boolean | null | number | string
  // Forward-compat: backend may send styles this client doesn't know yet —
  // `normalizeIndicatorStyle` falls back to 'kaomoji' for those — but the
  // wire type is documented as `string` so consumers don't get a false
  // narrowing-and-autocomplete contract on a value that requires runtime
  // validation anyway.
  tui_status_indicator?: string
  tui_statusbar?: 'bottom' | 'off' | 'on' | 'top' | boolean
}

export interface ConfigVoiceConfig {
  // Raw `yaml.safe_load()` value from config; may be non-string if hand-edited.
  // Callers must normalize/validate at runtime (parseVoiceRecordKey()).
  record_key?: unknown
}

export interface ConfigFullResponse {
  config?: { display?: ConfigDisplayConfig; voice?: ConfigVoiceConfig; paste_collapse_threshold?: number; paste_collapse_char_threshold?: number; keymap?: unknown }
}

export interface ConfigMtimeResponse {
  mtime?: number
}

export interface ConfigGetValueResponse {
  display?: string
  home?: string
  value?: string
}

export interface ConfigSetResponse {
  confirm_message?: string
  confirm_required?: boolean
  credential_warning?: string
  history_reset?: boolean
  info?: SessionInfo
  value?: string
  warning?: string
}

export interface SetupStatusResponse {
  provider_configured?: boolean
}

// ── Session lifecycle ────────────────────────────────────────────────

export interface SessionCreateResponse {
  info?: SessionInfo & { config_warning?: string; credential_warning?: string }
  session_id: string
  /** W3 Session：工件闸门 fail-closed 时 ok:false（无 session_id） */
  ok?: boolean
  message?: string
}

export interface SessionResumeResponse {
  inflight?: null | SessionInflightTurn
  info?: SessionInfo
  message_count?: number
  messages: GatewayTranscriptMessage[]
  resumed?: string
  running?: boolean
  session_id: string
  started_at?: number
  status?: LiveSessionStatus
  /** W3 Session：工件闸门 fail-closed 时 ok:false */
  ok?: boolean
  message?: string
}

export type LiveSessionStatus = 'idle' | 'starting' | 'waiting' | 'working'

export interface SessionActiveItem {
  /** 每会话成本估算（USD；全部模型有定价才给——未知省略） */
  cost_usd?: number
  current?: boolean
  id: string
  last_active?: number
  message_count?: number
  model?: string
  preview?: string
  session_key?: string
  started_at?: number
  status: LiveSessionStatus
  title?: string
}

export interface SessionActiveListResponse {
  sessions?: SessionActiveItem[]
}

export interface SessionInflightTurn {
  assistant?: string
  streaming?: boolean
  user?: string
}

export interface SessionActivateResponse {
  inflight?: null | SessionInflightTurn
  info?: SessionInfo
  message_count?: number
  messages: GatewayTranscriptMessage[]
  running?: boolean
  session_id: string
  session_key?: string
  started_at?: number
  status?: LiveSessionStatus
  /** W3 Session：工件闸门 fail-closed 时 ok:false */
  ok?: boolean
  message?: string
}

export interface SessionListItem {
  id: string
  message_count: number
  preview: string
  source?: string
  started_at: number
  title: string
}

export interface SessionListResponse {
  sessions?: SessionListItem[]
}

export interface SessionDeleteResponse {
  deleted: string
}

export interface SessionMostRecentResponse {
  session_id?: null | string
  source?: string
  started_at?: number
  title?: string
}

export interface SessionTitleResponse {
  pending?: boolean
  session_key?: string
  title?: string
}

export interface SessionSaveResponse {
  file?: string
}

export interface SessionUndoResponse {
  removed?: number
}

export interface SessionCompressResponse {
  after_messages?: number
  after_tokens?: number
  before_messages?: number
  before_tokens?: number
  info?: SessionInfo
  messages?: GatewayTranscriptMessage[]
  removed?: number
  summary?: {
    headline?: string
    noop?: boolean
    note?: null | string
    token_line?: string
  }
  usage?: Usage
}

export interface SessionBranchResponse {
  session_id?: string
  title?: string
}

export interface SessionCloseResponse {
  closed?: boolean
  ok?: boolean
}

export interface SessionInterruptResponse {
  ok?: boolean
}

export interface SessionSteerResponse {
  status?: 'queued' | 'rejected'
  text?: string
}

// ── Prompt / submission ──────────────────────────────────────────────

export interface PromptSubmitResponse {
  ok?: boolean
}

export interface BackgroundStartResponse {
  task_id?: string
}

export interface ClarifyRespondResponse {
  ok?: boolean
}

export interface ApprovalRespondResponse {
  ok?: boolean
}

export interface SudoRespondResponse {
  ok?: boolean
}

export interface SecretRespondResponse {
  ok?: boolean
}

// ── Shell / clipboard / input ────────────────────────────────────────

export interface ShellExecResponse {
  code: number
  stderr?: string
  stdout?: string
}

export interface ClipboardPasteResponse {
  attached?: boolean
  count?: number
  height?: number
  message?: string
  token_estimate?: number
  width?: number
}

export interface InputDetectDropResponse {
  height?: number
  is_image?: boolean
  matched?: boolean
  name?: string
  text?: string
  token_estimate?: number
  width?: number
}

export interface TerminalResizeResponse {
  ok?: boolean
}

// ── Image attach ─────────────────────────────────────────────────────

export interface ImageAttachResponse {
  height?: number
  name?: string
  remainder?: string
  token_estimate?: number
  width?: number
}

// ── Voice ────────────────────────────────────────────────────────────

export interface VoiceToggleResponse {
  audio_available?: boolean
  available?: boolean
  details?: string
  enabled?: boolean
  record_key?: string
  stt_available?: boolean
  tts?: boolean
  /** A20：唤醒模式（wake word 持续监听）状态 */
  wake?: boolean
}

export interface VoiceRecordResponse {
  status?: 'busy' | 'recording' | 'stopped'
  text?: string
}

// ── Tools (TS keeps configure since it resets local history) ─────────

export interface ToolsConfigureResponse {
  changed?: string[]
  enabled_toolsets?: string[]
  info?: SessionInfo
  missing_servers?: string[]
  reset?: boolean
  unknown?: string[]
}

// ── Model picker ─────────────────────────────────────────────────────

export interface ModelOptionProvider {
  auth_type?: string
  authenticated?: boolean
  is_current?: boolean
  key_env?: string
  models?: string[]
  name: string
  /** 参考价目（USD/1M token；未收录定价的模型不在表内——诚实不显示） */
  prices?: Record<string, { in: number; out: number }>
  slug: string
  total_models?: number
  warning?: string
}

export interface ModelOptionsResponse {
  model?: string
  provider?: string
  providers?: ModelOptionProvider[]
}

// ── MCP ──────────────────────────────────────────────────────────────

export interface ReloadMcpResponse {
  status?: string
  message?: string
}

export interface ReloadEnvResponse {
  updated?: number
}

export interface ProcessStopResponse {
  killed?: number
}

export interface RollbackCheckpoint {
  hash: string
  message?: string
  timestamp?: string
}

export interface RollbackListResponse {
  checkpoints?: RollbackCheckpoint[]
  enabled?: boolean
}

export interface RollbackDiffResponse {
  diff?: string
  rendered?: string
  stat?: string
}

export interface RollbackRestoreResponse {
  error?: string
  history_removed?: number
  message?: string
  reason?: string
  restored_to?: string
  success?: boolean
}

// ── Subagent events ──────────────────────────────────────────────────

export interface SubagentEventPayload {
  api_calls?: number
  cost_usd?: number
  depth?: number
  duration_seconds?: number
  files_read?: string[]
  files_written?: string[]
  goal: string
  input_tokens?: number
  iteration?: number
  model?: string
  output_tail?: { is_error?: boolean; preview?: string; tool?: string }[]
  output_tokens?: number
  parent_id?: null | string
  reasoning_tokens?: number
  status?: SubagentStatus
  subagent_id?: string
  summary?: string
  task_count?: number
  task_index: number
  text?: string
  tool_count?: number
  tool_name?: string
  tool_preview?: string
  toolsets?: string[]
}

// ── Delegation control RPCs ──────────────────────────────────────────

export interface DelegationStatusResponse {
  active?: {
    depth?: number
    goal?: string
    model?: null | string
    parent_id?: null | string
    started_at?: number
    status?: string
    subagent_id?: string
    tool_count?: number
  }[]
  max_concurrent_children?: number
  max_spawn_depth?: number
  paused?: boolean
}

export interface DelegationPauseResponse {
  paused?: boolean
}

export interface SubagentInterruptResponse {
  found?: boolean
  subagent_id?: string
  ok?: boolean
  interrupted?: boolean
  status?: string
  message?: string
}

// A24：后台活动状态（终端/任务/定时——后台面板轮询数据源）
export interface BackgroundStatusResponse {
  cron?: Array<{ action: string; enabled: boolean; id: number; last_run: number | null; schedule: string }>
  jobs?: Array<{
    created_at: number
    done_at: number | null
    exit_code: number | null
    goal: string
    id: string
    kind: string
    status: string
  }>
  terms?: Array<{ cwd: string; exitCode: number | null; id: string; shell: string; startedAt: number; status: string }>
}

// A24：目录选择器（dir.list 浏览 / cwd.set 切换）
export interface DirListResponse {
  entries?: Array<{ isDir: boolean; name: string }>
  error?: string
  ok?: boolean
  path?: string
}

export interface CwdSetResponse {
  cwd?: string
  error?: string
  ok?: boolean
}

// ── Spawn-tree snapshots ─────────────────────────────────────────────

export interface SpawnTreeListEntry {
  count: number
  finished_at?: number
  label?: string
  path: string
  session_id?: string
  started_at?: number | null
}

export interface SpawnTreeListResponse {
  entries?: SpawnTreeListEntry[]
}

export interface SpawnTreeLoadResponse {
  finished_at?: number
  label?: string
  session_id?: string
  started_at?: null | number
  subagents?: unknown[]
}

export type GatewayEvent =
  | { payload?: { skin?: GatewaySkin }; session_id?: string; type: 'gateway.ready' }
  | { payload?: GatewaySkin; session_id?: string; type: 'skin.changed' }
  | { payload?: { name?: string }; session_id?: string; type: 'theme.changed' }
  | { payload: SessionInfo; session_id?: string; type: 'session.info' }
  | { payload?: { todos?: unknown[] }; session_id?: string; type: 'message.start' }
  | { payload?: { kind?: string; text?: string }; session_id?: string; type: 'status.update' }
  | {
      payload?: {
        id?: string
        key?: string
        kind?: 'sticky' | 'ttl'
        level?: 'error' | 'info' | 'success' | 'warn'
        text?: string
        ttl_ms?: null | number
      }
      session_id?: string
      type: 'notification.show'
    }
  | { payload?: { state?: 'idle' | 'listening' | 'transcribing' }; session_id?: string; type: 'voice.status' }
  | { payload?: { no_speech_limit?: boolean; text?: string }; session_id?: string; type: 'voice.transcript' }
  | { payload: { line: string }; session_id?: string; type: 'gateway.stderr' }
  | {
      payload?: { cwd?: string; python?: string; stderr_tail?: string }
      session_id?: string
      type: 'gateway.start_timeout'
    }
  | { payload?: { preview?: string }; session_id?: string; type: 'gateway.protocol_error' }
  | { payload?: { text?: string; verbose?: boolean }; session_id?: string; type: 'reasoning.delta' }
  | {
      payload: { args_text?: string; context?: string; name?: string; tool_id: string; todos?: unknown[] }
      session_id?: string
      type: 'tool.start'
    }
  | {
      payload: {
        duration_s?: number
        error?: string
        inline_diff?: string
        name?: string
        result_text?: string
        summary?: string
        tool_id: string
        todos?: unknown[]
      }
      session_id?: string
      type: 'tool.complete'
    }
  | {
      payload: { choices: string[] | null; question: string; request_id: string }
      session_id?: string
      type: 'clarify.request'
    }
  | {
      payload: { allow_permanent?: boolean; command: string; description: string; tool?: string; category?: string; icon?: string }
      session_id?: string
      type: 'approval.request'
    }
  | { payload: { request_id: string }; session_id?: string; type: 'sudo.request' }
  | { payload: { env_var: string; prompt: string; request_id: string }; session_id?: string; type: 'secret.request' }
  | { payload: { request_id: string; fields: Array<{ name: string; label?: string; kind: string }>; prompt: string }; session_id?: string; type: 'credential.form' }
  | {
      payload: { task_id: string; text: string; status: 'success' | 'failed' | 'cancelled'; error?: string }
      session_id?: string
      type: 'background.complete'
    }
  | {
      payload?: { active?: boolean; cancelled?: boolean; done?: boolean; maxRounds?: number; round?: number; text?: string }
      session_id?: string
      type: 'background.goal'
    }
  | {
      payload: Array<{ created_at: number; done_at: number | null; exit_code: number | null; goal: string; id: string; kind: string; status: string }>
      session_id?: string
      type: 'background.jobs'
    }
  | { payload: SubagentEventPayload; session_id?: string; type: 'subagent.start' }
  | { payload: SubagentEventPayload; session_id?: string; type: 'subagent.thinking' }
  | { payload: SubagentEventPayload; session_id?: string; type: 'subagent.tool' }
  | { payload: SubagentEventPayload; session_id?: string; type: 'subagent.complete' }
  | { payload: { rendered?: string; text?: string; reset?: boolean }; session_id?: string; type: 'message.delta' }
  | {
      payload?: { reasoning?: string; rendered?: string; text?: string; todos?: unknown[]; usage?: Usage }
      session_id?: string
      type: 'message.complete'
    }
  | { payload?: { message?: string }; session_id?: string; type: 'error' }
