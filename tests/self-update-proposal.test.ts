// tests/self-update-proposal.test.ts — 自更新方案确认制契约（2026-09-04 用户裁决）
// 规格：30 天周期提示一次 · 方案 HTML 展示（/panel）· 仅用户确认后执行 · 可关闭推送。
// 纯函数表驱动（周期决策）+ /update proposal 命令往返（开关/记账）。
import { describe, it, expect } from 'vitest';
import { shouldPromptSelfUpdate, SELF_UPDATE_PROPOSAL_INTERVAL_MS } from '../src/kernel/selfUpdate.js';

const DAY = 86_400_000;

describe('shouldPromptSelfUpdate 纯决策（30 天确认制——表驱动锁死）', () => {
  it('从未提示 → 立即提示；30 天内 → 不提示（附下次时间）；到点 → 提示', () => {
    const now = 2_000_000_000_000;
    expect(shouldPromptSelfUpdate(undefined, now).prompt).toBe(true);            // 无状态=首次
    const prompted = { mode: '30d' as const, lastPromptAt: now };
    expect(shouldPromptSelfUpdate(prompted, now + 29 * DAY).prompt).toBe(false);  // 未到 30 天
    expect(shouldPromptSelfUpdate(prompted, now + 29 * DAY).nextAt).toBe(now + SELF_UPDATE_PROPOSAL_INTERVAL_MS);
    expect(shouldPromptSelfUpdate(prompted, now + 30 * DAY).prompt).toBe(true);   // 到点
  });
  it('off → 永不提示（附重开指引）', () => {
    const r = shouldPromptSelfUpdate({ mode: 'off', lastPromptAt: 0 }, Date.now() + 365 * DAY);
    expect(r.prompt).toBe(false);
    expect(r.reason).toContain('已关闭');
    expect(r.reason).toContain('proposal on');
  });
});

describe('/update proposal 命令往返（开关与记账）', () => {
  it('off → on → 展示（settings 写读真实往返）', async () => {
    const { createCommandBus } = await import('../src/app/CommandBus.js');
    const { registerCoreHandlers } = await import('../src/commands/handlers.js');
    const s: Record<string, unknown> = {};
    const ctx = {
      dataDir: process.cwd(), cwd: process.cwd(),
      db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
      config: { get: () => s, getKey: (_p: string, k: string) => s[k], setKey: (_p: string, k: string, v: unknown) => { s[k] = v } },
      setModel: () => {}, openModelPicker: () => {},
    } as never;
    const bus = createCommandBus();
    registerCoreHandlers(bus, ctx);
    const off = await bus.execute('/update proposal off');
    expect(off.ok).toBe(true);
    expect(off.output).toContain('已关闭');
    expect((s.selfUpdateProposal as { mode: string }).mode).toBe('off');
    const view = await bus.execute('/update proposal');
    expect(view.output).toContain('已关闭');
    const on = await bus.execute('/update proposal on');
    expect(on.output).toContain('重开');
    expect((s.selfUpdateProposal as { mode: string; lastPromptAt: number }).mode).toBe('30d');
    expect((s.selfUpdateProposal as { lastPromptAt: number }).lastPromptAt).toBe(0);
    // 到点查看 → 记账（lastPromptAt 写入 now）
    const view2 = await bus.execute('/update proposal');
    expect(view2.output).toContain('30 天确认');
    expect((s.selfUpdateProposal as { lastPromptAt: number }).lastPromptAt).toBeGreaterThan(0);
  });
});

describe('面板自更新区（HTML 展示裁决）', () => {
  it('panelPage 配置区含自更新方案按钮与关闭推送（30 天确认制文案锚定）', async () => {
    const { renderPanelPage } = await import('../src/presentation/http/panelPage.js');
    const html = renderPanelPage({ catalog: { slash: ['/update'], desc: { '/update': 'x' }, cat: { '/update': '⚙' }, core: [] } });
    expect(html).toContain('自更新方案（30 天确认制）');
    expect(html).toContain('关闭更新推送');
    expect(html).toContain('/update proposal');
  });
});
