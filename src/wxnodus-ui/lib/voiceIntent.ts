// src/wxnodus-ui/lib/voiceIntent.ts — 语音意图解析（免提模式）
// 语音转写文本 → 意图。纯函数——直接单测。
// 确认/取消词库匹配：仅对短文本（≤12 字符）判定，避免把
// "我确认一下这个方案" 这类完整句子误判为审批确认。

export const CONFIRM_WORDS = ['确认', '同意', '可以', '执行', '允许', '确定', '是', '好的', 'yes', 'ok']
export const REJECT_WORDS = ['不允许', '取消', '拒绝', '不行', '不要', '停止', 'no']

export type VoiceConfirmChoice = 'approve' | 'deny' | null

/** 语音确认意图：命中确认词库 → approve；拒绝词库 → deny；否则 null。 */
export function voiceConfirmChoice(text: string): VoiceConfirmChoice {
  const t = String(text ?? '')
    .trim()
    .toLowerCase()

  if (!t || t.length > 12) {
    return null
  }

  // 拒绝词先查（"不允许" 含确认词 "允许"——否定必须优先）
  for (const w of REJECT_WORDS) {
    if (t.includes(w.toLowerCase())) {
      return 'deny'
    }
  }

  for (const w of CONFIRM_WORDS) {
    if (t.includes(w.toLowerCase())) {
      return 'approve'
    }
  }

  return null
}
