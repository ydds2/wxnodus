// src/wxnodus-ui/bridge/setupHandoff.ts — W2-02：/setup 不再 spawn 外部 wxnodus 进程——
// 个性化初始化走 personalization.setup RPC（真实 PersonalizationService），
// 结果必须等待 OperationResult：仅 ok:true 显示成功，错误显示稳定 error.code。
import type { SlashHandlerContext } from './interfaces.js'
import { patchUiState } from '../runtime/viewStore.js'

export interface RunInProcessSetupOptions {
  ctx: Pick<SlashHandlerContext, 'gateway' | 'session' | 'transcript'>
}

export async function runInProcessSetup({ ctx }: RunInProcessSetupOptions) {
  const { gateway, session, transcript } = ctx

  patchUiState({ status: 'setup running…' })

  const result = await gateway.rpc<{ ok: boolean; value?: { profile?: Record<string, unknown> }; error?: { code: string } }>('personalization.setup', {
    scope: 'user',
    patch: { memory: { enabled: true, retention: 'persistent' } },
  })

  if (!result || !result.ok) {
    transcript.sys(`setup: ${result?.error?.code ?? 'PERSONALIZATION_SCHEMA_INVALID'}`)
    patchUiState({ status: 'setup required' })
    return
  }

  transcript.sys('setup complete — starting session…')
  session.newSession()
}
