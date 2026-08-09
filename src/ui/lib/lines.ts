// src/ui/lib/lines.ts — 终端文本行数估算（纯函数，可单测，零测量循环）
// 用途：消息区自制滚动裁剪（Kimi/Claude Code 式全屏 TUI，不依赖 ScrollView/测量，
//       用字符宽度估算每条消息占多少行——中文字符按 2 列计算）。
export function strWidth(s: string): number {
  let w = 0;
  for (const c of s) w += c.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

// 估算文本在 width 列内渲染的行数（\n 分段；每段至少 1 行，超宽向上取整）
export function estimateLines(text: string, width: number): number {
  if (!text) return 0;
  const w = Math.max(width, 10);
  let lines = 0;
  for (const seg of text.split('\n')) {
    lines += Math.max(1, Math.ceil(strWidth(seg) / w));
  }
  return lines;
}

// 从后往前裁剪 history：返回能在 areaLines 行内显示的尾部消息（含流式占用行数）
export interface TrimResult<T> { items: T[]; overflow: number }

export function trimTail<T extends { text: string; ms?: number }>(
  items: T[],
  areaLines: number,
  width: number,
  extraLines = 0,
): TrimResult<T> {
  if (areaLines <= 0) return { items: [], overflow: items.length };
  let budget = areaLines - extraLines;
  const out: T[] = [];
  let firstIdx = items.length; // 第一条可见消息的索引（被裁掉 = firstIdx 条）
  for (let i = items.length - 1; i >= 0 && budget > 0; i--) {
    const m = items[i]!;
    const h = estimateLines(m.text, width) + (m.ms !== undefined && m.ms > 0 ? 1 : 0);
    if (out.length === 0 && budget - h < 0) {
      // 单条消息就超高：至少显示这条（截断显示）
      out.unshift(m);
      firstIdx = i;
      break;
    }
    if (budget - h < 0) break;
    out.unshift(m);
    firstIdx = i;
    budget -= h;
  }
  return { items: out, overflow: firstIdx };
}

// 应用内滚动视图：offsetLines 为从底部往上偏移的行数（0 = 最新在底）。
// 全屏 TUI（alternateScreen）无终端滚动缓冲，历史回看靠这个纯函数
// 计算「可见行区间 → 可见消息切片」——零测量循环。
export interface ScrollViewport<T> {
  visible: T[];       // 可见消息（从可见第一条到末尾）
  totalLines: number; // 全部消息（含流式 extraLines）总行数
  atBottom: boolean;  // offset 为 0（最新在底）
  maxOffset: number;  // 可上滑的最大行数
  overflow: number;   // 被裁掉的消息数（无上滑时从尾裁剪的条数）
}

export function scrollTail<T extends { text: string; ms?: number }>(
  items: T[],
  offsetLines: number,
  areaLines: number,
  width: number,
  extraLines = 0,
): ScrollViewport<T> {
  const heights = items.map(m => estimateLines(m.text, width) + (m.ms !== undefined && m.ms > 0 ? 1 : 0));
  const total = heights.reduce((a, b) => a + b, 0) + extraLines;
  const maxOffset = Math.max(0, total - areaLines);
  const off = Math.max(0, Math.min(offsetLines, maxOffset));
  const viewTop = total - off - areaLines; // 可见区顶部行号（相对内容顶部，可负）
  // 找第一条可见消息：行区间 (viewTop, viewTop + areaLines] 覆盖的消息
  let acc = 0;
  let start = items.length;
  for (let i = 0; i < items.length; i++) {
    if (start === items.length && acc + heights[i]! > viewTop) start = i;
    acc += heights[i]!;
    if (acc >= viewTop + areaLines) break;
  }
  const visible = start < items.length ? items.slice(start) : [];
  return { visible, totalLines: total, atBottom: off === 0, maxOffset, overflow: start };
}
