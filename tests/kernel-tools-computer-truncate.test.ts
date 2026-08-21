// tests/kernel-tools-computer-truncate.test.ts — Computer Use 输出诚实性（uia 窗口/控件树截断标注）
// 口径：枚举类工具输出必须有界且显式标注「共 N / 剩余 M」——绝不静默截断或无限输出（上下文爆破）
import { describe, expect, it, vi } from 'vitest';

// uia 桥 mock：枚举输出可控（真实 PowerShell 桥由 uia.ps1 真机场景验收）
vi.mock('../src/kernel/computer/uia.js', () => ({
  uiaWindows: vi.fn(),
  uiaTree: vi.fn(),
}));
import { uiaWindows, uiaTree } from '../src/kernel/computer/uia.js';

describe('computer_uia_windows 窗口枚举诚实截断', () => {
  it('超 30 个窗口 → 前 30 + 总数标注（模型知道还有更多）', async () => {
    vi.mocked(uiaWindows).mockResolvedValue({
      ok: true,
      windows: Array.from({ length: 35 }, (_, i) => ({ focused: i === 0, name: `窗${i}`, className: 'X', pid: i, handle: `h${i}` })),
    });
    const { coreTools } = await import('../src/kernel/tools.js');
    const out = await coreTools().computer_uia_windows!.run({}, {} as any);
    expect(out).toContain('共 35');
    expect(out).toContain('已截断');
    expect(out).not.toContain('窗34');
    expect(out).toContain('窗0');
  });
  it('30 个以内 → 无截断标注', async () => {
    vi.mocked(uiaWindows).mockResolvedValue({
      ok: true,
      windows: Array.from({ length: 5 }, (_, i) => ({ focused: false, name: `窗${i}`, className: '', pid: i, handle: `h${i}` })),
    });
    const { coreTools } = await import('../src/kernel/tools.js');
    const out = await coreTools().computer_uia_windows!.run({}, {} as any);
    expect(out).not.toContain('已截断');
    expect(out).toContain('窗4');
  });
});

describe('computer_uia_tree 控件树有界输出', () => {
  it('超 60 项 → 前 60 + 总数标注 + find 指引（防上下文爆破）', async () => {
    vi.mocked(uiaTree).mockResolvedValue({
      ok: true,
      elements: Array.from({ length: 70 }, (_, i) => ({ name: `e${i}`, id: '', ct: 'Button', x: 0, y: 0, w: 10, h: 10, enabled: true, offscreen: false })),
    });
    const { coreTools } = await import('../src/kernel/tools.js');
    const out = await coreTools().computer_uia_tree!.run({}, {} as any);
    expect(out).toContain('共 70');
    expect(out).toContain('已截断');
    expect(out).toContain('computer_uia_find');
    expect(out).not.toContain('e69');
    expect(out).toContain('e0');
  });
  it('60 项以内 → 全量无标注', async () => {
    vi.mocked(uiaTree).mockResolvedValue({
      ok: true,
      elements: Array.from({ length: 3 }, (_, i) => ({ name: `e${i}`, id: '', ct: 'Text', x: 0, y: 0, w: 5, h: 5, enabled: true, offscreen: false })),
    });
    const { coreTools } = await import('../src/kernel/tools.js');
    const out = await coreTools().computer_uia_tree!.run({}, {} as any);
    expect(out).not.toContain('已截断');
    expect(out).toContain('e2');
  });
});
