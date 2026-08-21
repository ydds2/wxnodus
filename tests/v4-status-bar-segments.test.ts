// tests/v4-status-bar-segments.test.ts — V4 L0-4：状态栏六段内容模块（纯函数）
// 六段构建 / 密度显隐 / 结构化着色（低余额红·水位色·预算余量·重连态）/ 缺数据省略
import { describe, it, expect } from 'vitest';
import { buildStatusSegments, segmentById, type StatusBarState } from '../src/wxnodus-ui/components/statusBarSegments.js';

const base: StatusBarState = { state: 'ready', statusText: '就绪' };

describe('V4 L0-4 六段构建', () => {
  it('model 段：短名（去 provider 前缀）+ fast/effort 徽标（effort 仅 cozy）', () => {
    const segs = buildStatusSegments({ ...base, model: 'zhipu/glm-4.7-flash', modelFast: true, modelEffort: 'high' })
    expect(segmentById(segs, 'model')?.text).toBe('glm-4.7-flash·fast·high')
    const compact = buildStatusSegments({ ...base, model: 'zhipu/glm-4.7-flash', modelFast: true, modelEffort: 'high', density: 'compact' })
    expect(segmentById(compact, 'model')?.text).toBe('glm-4.7-flash·fast')
  });

  it('cost 段：成本 + 上下文用量；水位着色（≥85 error / ≥75 warn / 常规 muted）', () => {
    const ok = buildStatusSegments({ ...base, usage: { cost_usd: 0.0123, context_used: 40000, context_max: 128000, context_percent: 31 } })
    expect(segmentById(ok, 'cost')?.text).toBe('$0.0123 40.0k/128.0k')
    expect(segmentById(ok, 'cost')?.color).toBe('muted')
    const warn = buildStatusSegments({ ...base, usage: { context_percent: 76, context_used: 97000, context_max: 128000 } })
    expect(segmentById(warn, 'cost')?.color).toBe('warn')
    const danger = buildStatusSegments({ ...base, usage: { context_percent: 90, context_used: 115000, context_max: 128000 } })
    expect(segmentById(danger, 'cost')?.color).toBe('error')
  });

  it('balance：低余额红 / stale 黄 / 正常 muted（结构化标记，零文本猜测）', () => {
    const low = buildStatusSegments({ ...base, balance: { label: '¥2.1', low: true } })
    const costSegs = low.filter(s => s.id === 'cost')
    expect(costSegs.some(s => s.color === 'error')).toBe(true)
    const stale = buildStatusSegments({ ...base, balance: { label: '¥9', stale: true } })
    expect(stale.filter(s => s.id === 'cost').some(s => s.color === 'warn')).toBe(true)
  });

  it('budget 段（仅 cozy）：最紧工具类 used/limit；余量 <20% warn', () => {
    const cozy = buildStatusSegments({
      ...base,
      budget: { used: { processSpawns: 48, networkRequests: 10 }, limits: { processSpawns: 50, networkRequests: 100 } },
    })
    const budget = segmentById(cozy, 'budget')
    expect(budget?.text).toContain('48/50')
    expect(budget?.color).toBe('warn') // 剩 2/50 = 4% <20%
    const compact = buildStatusSegments({ ...base, density: 'compact', budget: { used: { processSpawns: 48 }, limits: { processSpawns: 50 } } })
    expect(segmentById(compact, 'budget')).toBeUndefined()
  });

  it('net 段：重连可见（↻ 重连中 第N次 Ns后）；dense 隐藏', () => {
    const segs = buildStatusSegments({ ...base, net: { reconnecting: true, attempt: 3, nextRetryMs: 20000 } })
    expect(segmentById(segs, 'net')?.text).toBe('↻ 重连中 第3次 20s后')
    expect(segmentById(segs, 'net')?.color).toBe('warn')
    const dense = buildStatusSegments({ ...base, density: 'dense', net: { reconnecting: true } })
    expect(segmentById(dense, 'net')).toBeUndefined()
  });

  it('state 段：busy accent / error error / ready muted；session 段 cozy+compact 可见、dense 隐藏', () => {
    expect(segmentById(buildStatusSegments({ ...base, state: 'busy', statusText: '正在推理…' }), 'state')?.color).toBe('accent')
    expect(segmentById(buildStatusSegments({ ...base, state: 'error', statusText: '失败' }), 'state')?.color).toBe('error')
    const withSession = buildStatusSegments({ ...base, session: { liveCount: 3 } })
    expect(segmentById(withSession, 'session')?.text).toBe('3 会话')
    const dense = buildStatusSegments({ ...base, density: 'dense', session: { liveCount: 3 } })
    expect(segmentById(dense, 'session')).toBeUndefined()
  });

  it('缺数据段自然省略（无 model/usage/balance/budget/net 时仅 state）', () => {
    const segs = buildStatusSegments(base)
    expect(segs.map(s => s.id)).toEqual(['state'])
  });

  it('密度显隐总表：cozy 全段 / compact 隐 budget+net+effort / dense 仅 model+cost+state', () => {
    const full: StatusBarState = {
      state: 'ready', statusText: 'x', model: 'm', modelEffort: 'h',
      usage: { cost_usd: 0.01 },
      session: { liveCount: 2 },
      budget: { used: { a: 1 }, limits: { a: 10 } },
      net: { reconnecting: true },
    }
    const ids = (d: 'cozy' | 'compact' | 'dense') => new Set(buildStatusSegments({ ...full, density: d }).map(s => s.id))
    expect(ids('cozy')).toEqual(new Set(['model', 'cost', 'session', 'budget', 'net', 'state']))
    // compact 保留 net（重连可见性优先于密度简化——断网自愈是关键信息）
    expect(ids('compact')).toEqual(new Set(['model', 'cost', 'session', 'net', 'state']))
    expect(ids('dense')).toEqual(new Set(['model', 'cost', 'state']))
  });
});
