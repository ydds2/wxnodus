// src/commands/memorySalience.ts — W3 Memory：legacy 倍率语义 → modern salience[0,1] 的确定性映射
// legacy：1=默认、3=置顶、0.3=淡化（倍率语义，上限不封顶）；
// modern 领域：salience ∈ [0,1]（P0-05 契约 clamp）。
// 单调映射 mult → mult/(1+mult)：1→0.5（默认）、3→0.75（置顶）、0.3→0.23（淡化）、∞→1。
export function salienceFromMultiplier(mult: number): number {
  const m = Number.isFinite(mult) && mult > 0 ? mult : 1;
  return m / (1 + m);
}

/** 列表/检索展示旗标：★ 置顶（>0.55）、☆ 淡化（<0.45）、' ' 默认 */
export function salienceFlag(salience: number): '★' | '☆' | ' ' {
  return salience > 0.55 ? '★' : salience < 0.45 ? '☆' : ' ';
}
