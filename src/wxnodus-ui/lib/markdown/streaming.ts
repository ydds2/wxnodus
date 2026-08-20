// src/ui/markdown/streaming.ts — L6-1 流式增量渲染（尾部缓冲 + 节流）
// 设计：已完成顶层块（闭合代码块/段落）为稳定前缀（memo 零重解析），最后未闭合块为不稳定后缀
//       16-80ms 节流发布（typing/滚动时加速由上层控制）
export function splitStablePrefix(text: string): { stable: string; unstable: string } {
  if (!text) return { stable: '', unstable: '' };
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    // 未闭合围栏：稳定部分到最后一个围栏之前
    const lastFenceIdx = text.lastIndexOf('```');
    const before = text.slice(0, lastFenceIdx);
    const beforeCount = (before.match(/```/g) ?? []).length;
    if (beforeCount % 2 === 0) {
      return { stable: before.replace(/\n+$/, ''), unstable: text.slice(lastFenceIdx) };
    }
  }
  // 无未闭合围栏：按最后一个 \n\n 段落边界切分（unstable 从边界后开始）
  const nl = text.lastIndexOf('\n\n');
  if (nl < 0) return { stable: '', unstable: text };
  return { stable: text.slice(0, nl), unstable: text.slice(nl + 2) };
}

export interface Throttle { schedule(fn: () => void): void; flush(): void }

export function throttleStreaming(ms = 16): Throttle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;
  return {
    schedule(fn) {
      pending = fn;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const f = pending;
        pending = null;
        f?.();
      }, ms);
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      const f = pending;
      pending = null;
      f?.();
    },
  };
}
