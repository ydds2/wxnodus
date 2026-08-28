// src/wxnodus-ui/output/bridge.ts — V4 L0-3：Msg → OutputEvent 映射桥（纯函数）
//
// 新旧体系的过渡桥：既有消息模型（Msg）经此转为 spec 事件，再走 renderEvent 纯函数。
// L0-3 切片覆盖：tool 结果 / timeline 事件 / trail（推理 + 回合摘要）三类；
// user/assistant/diff/command 由 L0-6 全量切换时并入。
// 本文件不做任何渲染决策——形态/颜色全部出自 spec。
import type { Msg } from '../types.js'
import type { Density, OutputEvent, ToolOutcome } from './spec.js'

export interface MsgBridgeOptions {
  density?: Density
  /** 工具调用名（tool 结果行归属；缺省从消息文本前缀「name: 」提取） */
  toolName?: string
  streaming?: boolean
}

/** 从「name: xxx」形态的 tool 消息文本提取工具名（mem.append 的既有格式） */
function toolNameOf(text: string, fallback: string): string {
  const m = text.match(/^([A-Za-z_][\w.]*):\s/)
  return m?.[1] ?? fallback
}

/**
 * Msg → OutputEvent[]（trail 一条消息产出 reasoning + turn-summary 两事件）。
 * 返回空数组 = 该消息暂不归 spec 管（走既有渲染路径）。
 */
export function msgToOutputEvents(msg: Msg, opts: MsgBridgeOptions = {}): OutputEvent[] {
  const density = opts.density ?? 'cozy'

  // timeline 事件（◈）：eventType 结构化着色（L0-2 已删内容正则）
  if (msg.kind === 'event') {
    return [{ kind: 'session-event', type: msg.eventType ?? '', text: msg.text }]
  }

  // 工具结果：toolOutcome 结构化（L0-2 贯通；未标注按 ok 处理但 preview 保留原文——
  // 旧数据无 outcome 不猜失败，与新渲染规则一致：未标注一律中性）
  if (msg.role === 'tool') {
    const outcome: ToolOutcome = (msg.toolOutcome as ToolOutcome | undefined) ?? 'ok'
    return [{
      kind: 'tool-result',
      name: toolNameOf(msg.text, opts.toolName ?? 'tool'),
      outcome,
      preview: msg.text,
    }]
  }

  // trail：推理折叠 + 回合尾摘要（V4 新增 turn-summary 行）
  if (msg.kind === 'trail') {
    const events: OutputEvent[] = []
    const thinking = (msg.thinking ?? '').trim()
    if (thinking) {
      events.push({
        kind: 'reasoning',
        text: thinking,
        tokens: msg.thinkingTokens ?? Math.ceil(thinking.length / 3),
      })
    }
    const s = msg.turnSummary
    const tokens = s?.tokens ?? ((msg.toolTokens ?? 0) + (msg.thinkingTokens ?? 0))
    if (tokens > 0 || s) {
      events.push({
        kind: 'turn-summary',
        turns: s?.turns ?? 0,
        tokens,
        costUsd: s?.costUsd ?? 0,
        durationMs: s?.durationMs ?? 0,
      })
    }
    void density // 密度由 renderEvent 消费（此处仅映射）
    return events
  }

  return []
}
