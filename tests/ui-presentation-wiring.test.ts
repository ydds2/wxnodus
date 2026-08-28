// tests/ui-presentation-wiring.test.ts — 阶段 2b：eventAdapter → presentation read-model 喂入合同
// 验证：gateway 事件在既有 side effect 路径之外平行投影进 presentationStore；
// 迟到（跨会话）事件被 adapter 守卫丢弃；秘密值不进投影。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGatewayEventHandler } from '../src/wxnodus-ui/bridge/eventAdapter.js';
import type { GatewayEventHandlerContext } from '../src/wxnodus-ui/bridge/interfaces.js';
import type { GatewayEvent } from '../src/wxnodus-ui/gatewayTypes.js';
import { resetTurnState } from '../src/wxnodus-ui/runtime/flowStore.js';
import { getPresentationState, resetPresentationState } from '../src/wxnodus-ui/runtime/presentationStore.js';
import { patchUiState, resetUiState } from '../src/wxnodus-ui/runtime/viewStore.js';
import { resetOverlayState } from '../src/wxnodus-ui/runtime/promptStore.js';

const makeCtx = (): GatewayEventHandlerContext => ({
  composer: { setInput: () => {} },
  gateway: { rpc: async () => null } as never,
  session: {
    STARTUP_RESUME_ID: 'none',
    colsRef: { current: 80 },
    newSession: () => {},
    resetSession: () => {},
    resumeById: () => {},
    setCatalog: () => {}
  },
  submission: { submitRef: { current: () => {} } },
  system: { bellOnComplete: false, sys: () => {} },
  transcript: { appendMessage: () => {}, panel: () => {}, setHistoryItems: () => {} },
  voice: {
    setProcessing: () => {},
    setRecording: () => {},
    setVoiceEnabled: () => {},
    setVoiceTts: () => {}
  }
})

let handler: ReturnType<typeof createGatewayEventHandler>

beforeEach(() => {
  resetUiState()
  resetTurnState()
  resetOverlayState()
  resetPresentationState()
  patchUiState({ sid: 's1' })
  handler = createGatewayEventHandler(makeCtx())
})

afterEach(() => {
  resetUiState()
  resetTurnState()
  resetOverlayState()
  resetPresentationState()
})

const fire = (ev: GatewayEvent) => handler(ev)
import { flushDeltaBatch } from '../src/wxnodus-ui/runtime/deltaBatcher.js'

describe('eventAdapter → presentation read-model 喂入', () => {
  it('message.start/delta/complete 投影 turn 生命周期', () => {
    fire({ type: 'message.start', session_id: 's1' })
    expect(getPresentationState()).toMatchObject({ busy: true, phase: 'planning' })

    fire({ type: 'message.delta', session_id: 's1', payload: { text: '你' } })
    fire({ type: 'message.delta', session_id: 's1', payload: { text: '好' } })
    // V4 UI 闭环：delta 经 50ms 微批（deltaBatcher——闪屏根治）——测试显式冲刷后断言
    flushDeltaBatch()
    expect(getPresentationState().streaming).toBe('你好')

    fire({ type: 'message.complete', session_id: 's1', payload: { text: '你好，完成' } })
    const s = getPresentationState()
    expect(s.streaming).toBe('')
    expect(s.history.map(m => m.text)).toEqual(['你好，完成'])
    expect(s.busy).toBe(false)
  })

  it('tool.start/complete 投影活动生命周期（失败工具不伪装成功）', () => {
    fire({ type: 'message.start', session_id: 's1' })
    fire({ type: 'tool.start', session_id: 's1', payload: { tool_id: 't1', name: 'bash', context: 'npm test' } })
    fire({ type: 'tool.complete', session_id: 's1', payload: { tool_id: 't1', name: 'bash', error: 'exit 1' } })

    expect(getPresentationState().activity).toMatchObject([
      { toolId: 't1', status: 'running' },
      { toolId: 't1', status: 'failed', summary: undefined }
    ])
  })

  it('审批/表单事件投影为 blocking prompt（按严格优先级）', () => {
    fire({ type: 'credential.form', session_id: 's1', payload: { request_id: 'f1', fields: [], prompt: '填表' } })
    expect(getPresentationState().blockingPrompt?.kind).toBe('form')

    fire({
      type: 'approval.request', session_id: 's1',
      payload: { command: 'rm -rf x', description: '危险命令', allow_permanent: false }
    })
    expect(getPresentationState().blockingPrompt?.kind).toBe('approval')

    // 新回合开始清空 flow prompt
    fire({ type: 'message.start', session_id: 's1' })
    expect(getPresentationState().blockingPrompt).toBeNull()
  })

  it('error 投影为 failed 阶段', () => {
    fire({ type: 'message.start', session_id: 's1' })
    fire({ type: 'error', session_id: 's1', payload: { message: 'boom' } })
    expect(getPresentationState().phase).toBe('failed')
  })

  it('跨会话迟到事件被 adapter 守卫丢弃（不修改当前会话投影）', () => {
    fire({ type: 'message.start', session_id: 's1' })
    const before = getPresentationState()

    fire({ type: 'message.delta', session_id: 's-other', payload: { text: '迟到' } })
    expect(getPresentationState()).toEqual(before)
  })

  it('秘密值不进投影（只投影变量名）', () => {
    fire({ type: 'secret.request', session_id: 's1', payload: { env_var: 'TOKEN', prompt: '输入令牌', request_id: 'sec-1' } })
    const prompt = getPresentationState().blockingPrompt

    expect(prompt?.kind).toBe('secret')
    expect(prompt?.summary).toBe('TOKEN')
    expect(JSON.stringify(getPresentationState())).not.toContain('super-secret-value')
  })
})
