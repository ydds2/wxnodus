// src/kernel/computer/actionLayer.ts — L3-3b computer use 动作层
// 设计（参考 Claude computer_use 协议 + playwright-mcp ref 模式）：
//   统一动作 schema：click/type/key/paste/scroll/open；坐标 DPI 换算；边界校验
export type CuAction =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'double' }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'paste'; text: string }
  | { type: 'scroll'; x: number; y: number; amount: number }
  | { type: 'open'; url: string };

const VALID = new Set(['click', 'type', 'key', 'paste', 'scroll', 'open']);

export function validateAction(a: CuAction): boolean {
  if (!VALID.has(a.type)) return false;
  switch (a.type) {
    case 'click': return typeof a.x === 'number' && typeof a.y === 'number';
    case 'type': return typeof a.text === 'string' && a.text.length > 0;
    case 'paste': return typeof a.text === 'string';
    case 'key': return typeof a.key === 'string' && a.key.length > 0;
    case 'scroll': return typeof a.x === 'number' && typeof a.y === 'number' && typeof a.amount === 'number';
    case 'open': return typeof a.url === 'string' && a.url.startsWith('http');
    default: return false;
  }
}

export function inBounds(x: number, y: number, viewport: { width: number; height: number }): boolean {
  return x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
}

/** @deprecated ⅩⅩⅩ（C-1）：截图像素=物理像素=robotjs/SetCursorPos 像素——本转换在
 *  clickOnScreen 中是多余的错误变换（DPI>1 偏向左上）；保留供 actionLayer 测试/单一屏幕
 *  逻辑坐标计算场景，生产 click 链不再消费。 */
export function convertCoords(x: number, y: number, dpi: { scale: number }): { x: number; y: number } {
  return { x: Math.round(x / dpi.scale), y: Math.round(y / dpi.scale) };
}
