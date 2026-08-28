// src/wxnodus-ui/lib/escCancel.ts — 双 Esc 取消判定器（纯函数，可单测）
// 语义：busy 时第一次 Esc 武装（arm，调用方记录 armedAt），窗口内第二次 Esc 确认（confirm）；
// 非 busy / 超时 → 复位（none，调用方清 armedAt）。窗口与 flowController 的
// INTERRUPT_COOLDOWN_MS 同源（1.5s）——超时不自动重武装，隔很久的单次 Esc 不会误取消。
export const ESC_CANCEL_WINDOW_MS = 1500;

export interface EscCancelState {
  armedAt: number | null;
}

export type EscCancelDecision = 'arm' | 'confirm' | 'none';

export function escCancelNext(
  state: EscCancelState,
  input: { now: number; busy: boolean; windowMs?: number }
): EscCancelDecision {
  if (!input.busy) return 'none';
  const windowMs = input.windowMs ?? ESC_CANCEL_WINDOW_MS;
  if (state.armedAt === null) return 'arm';
  if (input.now - state.armedAt <= windowMs) return 'confirm';
  return 'none'; // 超时复位（确定性行为）
}
