// src/kernel/computer/guards.ts — L3-3b computer use 安全护栏
// 设计：动作串行队列语义 + 坐标校验 + 全局中止（防止与真人抢鼠标/越界操作）
import { inBounds, type CuAction } from './actionLayer.js';

export class ActionGuard {
  private aborted = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private viewport: { width: number; height: number }) {}

  abort(): void { this.aborted = true; }

  check(a: CuAction): void {
    if (this.aborted) throw new Error('computer use 已中止');
    if (a.type === 'click' && !inBounds(a.x, a.y, this.viewport)) {
      throw new Error(`坐标越界 (${a.x},${a.y})，视口 ${this.viewport.width}x${this.viewport.height}`);
    }
  }

  // 串行执行：动作排队，防并发抢鼠标
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}
