// src/tui/mouse.ts — ⅩⅩⅪⅡ：TUI 鼠标支持基础（xterm SGR 编码）
// DECSET 1002h（按钮事件）+ 1006h（SGR 编码）——Windows Terminal / ConEmu 支持。
// 事件面：click（左键）/ wheelup / wheeldown；解析后回调 App 层消费。
export interface MouseEvent {
  type: 'click' | 'wheelup' | 'wheeldown' | 'mousedown' | 'mouseup';
  button: number; // 0=左 1=中 2=右
  col: number;    // 1-based
  row: number;    // 1-based
  shift: boolean;
  ctrl: boolean;
}

/** SGR 编码解析：[<button;col;row M（按下）/ m（释放） */
export function parseSgrMouse(data: string): MouseEvent | null {
  const m = /\[<(\d+);(\d+);(\d+)([Mm])/.exec(data);
  if (!m) return null;
  const cb = Number(m[1]);
  const col = Number(m[2]);
  const row = Number(m[3]);
  const release = m[4] === 'm';
  const button = (cb & 3) === 3 ? -1 : (cb & 3); // 3=释放无按钮
  const shift = (cb & 4) !== 0;
  const ctrl = (cb & 16) !== 0;
  if (button === -1) return { type: 'mouseup', button: 0, col, row, shift, ctrl };
  if (button === 0) return { type: release ? 'mouseup' : 'click', button: 0, col, row, shift, ctrl };
  if (cb & 64) { // 滚轮
    return { type: button === 0 ? 'wheelup' : 'wheeldown', button, col, row, shift, ctrl };
  }
  return { type: release ? 'mouseup' : 'mousedown', button, col, row, shift, ctrl };
}

/** 启用鼠标（DECSET 1002h + 1006h——仅 TTY） */
export function enableMouse(out: NodeJS.WriteStream): void {
  if (out.isTTY) { out.write('[?1002h'); out.write('[?1006h'); }
}

/** 禁用鼠标（退出前必调） */
export function disableMouse(out: NodeJS.WriteStream): void {
  if (out.isTTY) { out.write('[?1002l'); out.write('[?1006l'); }
}
