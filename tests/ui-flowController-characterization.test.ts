import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearSpawnHistory, getSpawnHistory } from '../src/wxnodus-ui/runtime/delegationArchive.js'
import { getTurnState, patchTurnState, resetTurnState } from '../src/wxnodus-ui/runtime/flowStore.js'
import type { InterruptDeps, TurnController as TurnControllerType } from '../src/wxnodus-ui/runtime/flowController.js'
import { getUiState, patchUiState, resetUiState } from '../src/wxnodus-ui/runtime/viewStore.js'

let controller: TurnControllerType

beforeEach(async () => {
  vi.useFakeTimers()
  resetUiState()
  resetTurnState()
  clearSpawnHistory()

  const { TurnController } = await import('../src/wxnodus-ui/runtime/flowController.js')
  controller = new TurnController()
})

afterEach(() => {
  controller?.fullReset()
  clearSpawnHistory()
  vi.useRealTimers()
})

describe('runtime TurnController characterization', () => {
  it('accumulates streaming deltas, preserves the final response, and returns idle', () => {
    controller.startMessage()
    controller.recordMessageDelta({ text: '你' })
    controller.recordMessageDelta({ text: '好' })
    controller.flushStreamingSegment()

    expect(getUiState().busy).toBe(true)
    expect(getTurnState().streamSegments).toMatchObject([{ role: 'assistant', text: '你好' }])

    const result = controller.recordMessageComplete({ text: '你好，完成' })

    expect(result.finalText).toBe('，完成')
    expect(result.finalMessages).toMatchObject([
      { role: 'assistant', text: '你好' },
      { role: 'assistant', text: '，完成' }
    ])
    expect(getUiState().busy).toBe(false)
    expect(getTurnState().streamSegments).toEqual([])
  })

  it('preserves buffered partial output when the completion omits text', () => {
    controller.startMessage()
    controller.recordMessageDelta({ text: '部分输出' })

    const result = controller.recordMessageComplete({})

    expect(result.finalText).toBe('部分输出')
    expect(result.finalMessages).toContainEqual({ role: 'assistant', text: '部分输出' })
  })

  it('keeps failed tool output attached to the final trail', () => {
    controller.startMessage()
    controller.recordToolStart('tool-1', 'bash', 'npm test')
    controller.recordToolComplete('tool-1', 'bash', 'exit 1', 'tests failed', 1.25)

    const result = controller.recordMessageComplete({ text: '测试失败' })
    const trail = result.finalMessages.find(msg => msg.tools?.length)

    expect(trail?.tools?.join('\n')).toContain('Bash')
    expect(trail?.tools?.join('\n')).toContain('exit 1')
    expect(result.finalText).toBe('测试失败')
  })

  it('interrupts fail-closed while preserving partial output', () => {
    const messages: Array<{ role: string; text: string }> = []
    const sys: string[] = []
    const request = vi.fn(async () => ({ interrupted: true }))
    const gw = { request } as InterruptDeps['gw']

    controller.startMessage()
    controller.recordMessageDelta({ text: '尚未完成' })
    controller.interruptTurn(
      {
        appendMessage: msg => messages.push({ role: msg.role, text: msg.text }),
        gw,
        sid: 'session-1',
        sys: text => sys.push(text)
      },
      { keepBusy: false }
    )

    expect(request).toHaveBeenCalledWith('session.interrupt', { session_id: 'session-1' })
    expect(messages).toContainEqual({ role: 'assistant', text: '尚未完成\n\n*[interrupted]*' })
    expect(sys).toEqual([])
    expect(getUiState()).toMatchObject({ busy: false, status: 'interrupted' })

    vi.advanceTimersByTime(1500)
    expect(getUiState().status).toBe('ready')
  })

  it('holds a notice while busy and starts its TTL only after completion', () => {
    controller.startMessage()
    controller.showNotice({ id: 'notice-1', key: 'credits.restored', kind: 'ttl', text: '额度已恢复', ttl_ms: 1000 })

    expect(getUiState().notice).toBeNull()

    controller.recordMessageComplete({ text: '完成' })
    expect(getUiState().notice?.text).toBe('额度已恢复')

    vi.advanceTimersByTime(999)
    expect(getUiState().notice?.text).toBe('额度已恢复')
    vi.advanceTimersByTime(1)
    expect(getUiState().notice).toBeNull()
  })

  it('archives incomplete todos without presenting them as completed', () => {
    controller.startMessage()
    controller.recordTodos([{ id: 'todo-1', content: '仍待验证', status: 'in_progress' }])

    const result = controller.recordMessageComplete({ text: '当前进度' })
    const archived = result.finalMessages.find(msg => msg.todos?.length)

    expect(archived).toMatchObject({ todoIncomplete: true })
    expect(archived?.todoCollapsedByDefault).toBeUndefined()
    expect(getTurnState().todos).toEqual([])
  })

  it('deduplicates consecutive inline diff segments', () => {
    controller.startMessage()
    controller.pushInlineDiffSegment('--- a/file\n+++ b/file\n@@\n-old\n+new')
    controller.pushInlineDiffSegment('--- a/file\n+++ b/file\n@@\n-old\n+new')

    const diffs = getTurnState().streamSegments.filter(msg => msg.kind === 'diff')
    expect(diffs).toHaveLength(1)
  })

  it('removes an inline diff when the final response contains the same fenced patch', () => {
    const patch = '--- a/file\n+++ b/file\n@@\n-old\n+new'
    controller.startMessage()
    controller.pushInlineDiffSegment(patch)

    const result = controller.recordMessageComplete({ text: `修改如下：\n\n\`\`\`diff\n${patch}\n\`\`\`` })

    expect(result.finalMessages.filter(msg => msg.kind === 'diff')).toHaveLength(0)
    expect(result.finalText).toContain(patch)
  })

  it('keeps unrelated inline diffs when the final response includes a different fenced patch', () => {
    const earlierPatch = '--- a/first\n+++ b/first\n@@\n-old\n+new'
    const finalPatch = '--- a/second\n+++ b/second\n@@\n-before\n+after'
    controller.startMessage()
    controller.pushInlineDiffSegment(earlierPatch)

    const result = controller.recordMessageComplete({ text: `另一处修改：\n\n\`\`\`diff\n${finalPatch}\n\`\`\`` })

    expect(result.finalMessages.filter(msg => msg.kind === 'diff')).toHaveLength(1)
    expect(result.finalMessages.find(msg => msg.kind === 'diff')?.text).toContain(earlierPatch)
  })

  it('archives subagents before idle clears the live tree', () => {
    patchUiState({ sid: 'session-1' })
    controller.startMessage()
    controller.upsertSubagent(
      { goal: '审查代码', subagent_id: 'agent-1', task_count: 1, task_index: 0 },
      () => ({ status: 'completed', summary: '完成审查' })
    )

    controller.recordMessageComplete({ text: '已汇总' })

    expect(getTurnState().subagents).toEqual([])
    expect(getSpawnHistory()).toHaveLength(1)
    expect(getSpawnHistory()[0]?.sessionId).toBe('session-1')
    expect(getSpawnHistory()[0]?.subagents[0]).toMatchObject({ id: 'agent-1', status: 'completed' })
  })

  it('drops late subagent events when creation is disabled', () => {
    controller.startMessage()
    controller.upsertSubagent(
      { goal: '过期任务', subagent_id: 'late-agent', task_index: 0 },
      () => ({ status: 'completed' }),
      { createIfMissing: false }
    )

    expect(getTurnState().subagents).toEqual([])
  })

  it('idle clears live tools, trail, segments, activity, and busy state', () => {
    controller.startMessage()
    controller.recordToolStart('tool-1', 'bash', 'pwd')
    patchTurnState({ activity: [{ id: 1, text: '运行中', tone: 'info' }], turnTrail: ['bash'] })
    controller.hydrateStreamingText('流式文本')

    controller.idle()

    expect(getUiState().busy).toBe(false)
    expect(getTurnState()).toMatchObject({ streamSegments: [], streaming: '', subagents: [], tools: [], turnTrail: [] })
  })
})

describe('doneTools 结构化完成记录（活动分区数据源）', () => {
  it('工具成功/失败分别落 succeeded/failed 记录（含摘要与耗时）', () => {
    controller.startMessage()
    controller.recordToolStart('t1', 'bash', 'npm install')
    controller.recordToolComplete('t1', 'bash', undefined, 'ok', 0.8)
    controller.recordToolStart('t2', 'bash', 'npm test')
    controller.recordToolComplete('t2', 'bash', 'exit 1', undefined, 1.25)

    expect(getTurnState().doneTools).toMatchObject([
      { id: 't1', name: 'bash', status: 'succeeded', summary: 'ok', durationSeconds: 0.8 },
      { id: 't2', name: 'bash', status: 'failed', summary: 'exit 1', durationSeconds: 1.25 },
    ])
  })

  it('progress 更新把运行中工具标为 hasProgress（输出中）', () => {
    controller.startMessage()
    controller.recordToolStart('t1', 'bash', 'pwd')
    controller.recordToolProgress('bash', '安装中 50%')
    // progress 状态发布经 toolProgressTimer 节流（STREAM_BATCH_MS）——推进定时器后读回
    vi.advanceTimersByTime(200)

    expect(getTurnState().tools[0]?.hasProgress).toBe(true)
    expect(getTurnState().tools[0]?.context).toBe('安装中 50%')
  })

  it('中断把在飞工具如实标记 cancelled（不伪装成功）', () => {
    const messages: Array<{ role: string; text: string }> = []
    const gw = { request: vi.fn(async () => ({})) } as InterruptDeps['gw']
    controller.startMessage()
    controller.recordToolStart('t1', 'bash', 'npm test')
    controller.interruptTurn(
      {
        appendMessage: msg => messages.push({ role: msg.role, text: msg.text }),
        gw,
        sid: 's1',
        sys: () => {}
      },
      { keepBusy: false }
    )

    expect(getTurnState().doneTools).toMatchObject([{ id: 't1', name: 'bash', status: 'cancelled' }])
    expect(getTurnState().tools).toEqual([])
  })

  it('startMessage 清空 doneTools；turn 结束（idle）保留供分区展示', () => {
    controller.startMessage()
    controller.recordToolStart('t1', 'bash', 'pwd')
    controller.recordToolComplete('t1', 'bash', undefined, 'ok', 0.5)
    expect(getTurnState().doneTools).toHaveLength(1)

    controller.recordMessageComplete({ text: '完成' })
    expect(getTurnState().doneTools).toHaveLength(1)

    controller.startMessage()
    expect(getTurnState().doneTools).toEqual([])
  })
})
