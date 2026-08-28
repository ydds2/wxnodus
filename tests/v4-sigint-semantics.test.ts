// tests/v4-sigint-semantics.test.ts — V4 P2-11：SIGINT 双语义（busy 首按中断/再按退出/空闲退出）
// 驱动：直接构造 SIGINT handler 所需最小面（gateway.running/kill + shutdown），模拟时钟推进。
import { describe, it, expect, vi } from 'vitest';

// handler 逻辑与 cli/index.ts 同构（该处闭包 ctx 不可注入——用行为等价镜像测试 + 源锚点核对）
function makeSigintState() {
  const state = {
    exitRequested: false,
    firstSigintAt: 0,
    gateway: { running: false, kills: 0 },
    shutdownCalls: [] as string[],
    logs: [] as string[],
    onSigint() {
      if (this.exitRequested) { this.shutdownCalls.push('sigint'); return; }
      const now = Date.now();
      const busy = this.gateway.running === true;
      if (busy && now - this.firstSigintAt > 1_500) {
        this.firstSigintAt = now;
        this.gateway.kills += 1;
        this.logs.push('已中断当前任务——再按 Ctrl+C 退出 wxnodus');
        return;
      }
      this.exitRequested = true;
      this.shutdownCalls.push('sigint');
    },
  };
  return state;
}

describe('V4 P2-11 SIGINT 双语义', () => {
  it('busy 首按：仅中断（gateway.kill×1 + 提示），不 shutdown 不退出', () => {
    const s = makeSigintState();
    s.gateway.running = true;
    s.onSigint();
    expect(s.gateway.kills).toBe(1);
    expect(s.exitRequested).toBe(false);
    expect(s.shutdownCalls).toEqual([]);
    expect(s.logs[0]).toContain('再按 Ctrl+C 退出');
  });

  it('busy 1.5s 内第二次：真正退出（shutdown sigint）', () => {
    const s = makeSigintState();
    s.gateway.running = true;
    s.onSigint();
    s.onSigint(); // 立即再按
    expect(s.exitRequested).toBe(true);
    expect(s.shutdownCalls).toEqual(['sigint']);
  });

  it('空闲态单击：直接退出（不中断任何 Run）', () => {
    const s = makeSigintState();
    s.gateway.running = false;
    s.onSigint();
    expect(s.exitRequested).toBe(true);
    expect(s.gateway.kills).toBe(0);
    expect(s.shutdownCalls).toEqual(['sigint']);
  });

  it('busy 中断后超 1.5s 再按：视为新一轮首按（仍只中断）', async () => {
    vi.useFakeTimers();
    try {
      const s = makeSigintState();
      s.gateway.running = true;
      s.onSigint();
      vi.advanceTimersByTime(2_000);
      s.onSigint();
      expect(s.exitRequested).toBe(false); // 再次只中断
      expect(s.gateway.kills).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('源锚点：cli/index.ts SIGINT 含双语义关键行（busy 判定 + 1.5s 窗口 + 再按提示）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/cli/index.ts', 'utf8');
    expect(src).toContain("gateway?.running === true");
    expect(src).toContain("now - firstSigintAt > 1_500");
    expect(src).toContain('再按 Ctrl+C 退出');
    expect(src).not.toContain("setTimeout(() => { void shutdown('sigint')", ); // 300ms 无条件强退已删
  });
});
