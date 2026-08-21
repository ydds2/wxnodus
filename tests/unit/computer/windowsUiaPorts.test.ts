// tests/unit/computer/windowsUiaPorts.test.ts — 真实端口装配（Gate E 接线）：边界分类 + 单能力端口映射
import { describe, expect, it, vi } from 'vitest';
import { createWindowsUiaPorts, parseBoundaryProbe } from '../../../src/infrastructure/computer/windowsUiaPorts.js';

// uia 桥 mock：单能力动作映射不依赖真实 PowerShell（桥本身由 uia.ps1 真机场景验收）
vi.mock('../../../src/kernel/computer/uia.js', () => ({
  uiaInvokeOnly: vi.fn(),
  uiaSelectOnly: vi.fn(),
  uiaMouseOnly: vi.fn(),
}));
import { uiaInvokeOnly, uiaSelectOnly, uiaMouseOnly } from '../../../src/kernel/computer/uia.js';

const baseProbe = (patch: Record<string, unknown> = {}) => ({
  interactive: true, desktop: 'Default', lockAppRunning: false, runnerElevated: false, targetPid: 0, targetElevated: false,
  ...patch,
});

describe('createWindowsUiaPorts 边界分类', () => {
  it('正常解锁桌面 → 全过（medium/medium/Default/无保护）', async () => {
    const ports = createWindowsUiaPorts(() => baseProbe());
    expect(await ports.inspectBoundary('a|b|123')).toEqual({
      interactive: true, unlocked: true, inputDesktop: 'Default',
      runnerIntegrity: 'medium', targetIntegrity: 'medium', protectedUi: false,
    });
  });

  it('锁屏（LockApp 在场）→ unlocked=false', async () => {
    const ports = createWindowsUiaPorts(() => baseProbe({ lockAppRunning: true }));
    expect((await ports.inspectBoundary('x')).unlocked).toBe(false);
  });

  it('Winlogon 桌面 → protectedUi=true + inputDesktop=Winlogon + unlocked=false', async () => {
    const ports = createWindowsUiaPorts(() => baseProbe({ desktop: 'Winlogon' }));
    expect(await ports.inspectBoundary('x')).toMatchObject({ inputDesktop: 'Winlogon', protectedUi: true, unlocked: false });
  });

  it('目标令牌打不开（null）→ targetIntegrity=high（fail-closed）', async () => {
    const ports = createWindowsUiaPorts(() => baseProbe({ targetElevated: null }));
    expect((await ports.inspectBoundary('x')).targetIntegrity).toBe('high');
  });

  it('runner 提权 → runnerIntegrity=high', async () => {
    const ports = createWindowsUiaPorts(() => baseProbe({ runnerElevated: true }));
    expect((await ports.inspectBoundary('x')).runnerIntegrity).toBe('high');
  });

  it('runtimeId 三段解析：handle 透传探测', async () => {
    const seen: string[] = [];
    const ports = createWindowsUiaPorts(handle => { seen.push(String(handle)); return baseProbe(); });
    await ports.inspectBoundary('name|id|9999');
    expect(seen).toEqual(['9999']);
  });
});

describe('createWindowsUiaPorts 单能力端口映射', () => {
  it('invoke 端口只认 method=invoke（无跨模式回落）', async () => {
    vi.mocked(uiaInvokeOnly).mockResolvedValue({ ok: true, element: { method: 'invoke' } });
    const ports = createWindowsUiaPorts(() => baseProbe());
    expect(await ports.invoke('btn|id|42')).toBe(true);
    vi.mocked(uiaInvokeOnly).mockResolvedValue({ ok: true, element: { method: 'select' } });
    expect(await ports.invoke('btn|id|42')).toBe(false);
    expect(uiaInvokeOnly).toHaveBeenLastCalledWith('btn|id', '42');
  });

  it('select 端口只认 method=select', async () => {
    vi.mocked(uiaSelectOnly).mockResolvedValue({ ok: true, element: { method: 'select' } });
    const ports = createWindowsUiaPorts(() => baseProbe());
    expect(await ports.select('item|id|42')).toBe(true);
    vi.mocked(uiaSelectOnly).mockResolvedValue({ ok: false, reason: 'no selection pattern' });
    expect(await ports.select('item|id|42')).toBe(false);
  });

  it('coordinateFallback：真实 mouse 结果 → acted+receipt；失败 → acted=false', async () => {
    const ports = createWindowsUiaPorts(() => baseProbe());
    vi.mocked(uiaMouseOnly).mockResolvedValue({ ok: true, element: { method: 'mouse', x: 10, y: 20 } });
    expect(await ports.coordinateFallback('el|id|42')).toEqual({ acted: true, receiptId: 'uia-mouse-10-20' });
    vi.mocked(uiaMouseOnly).mockResolvedValue({ ok: false, reason: 'element not found' });
    expect(await ports.coordinateFallback('el|id|42')).toEqual({ acted: false, receiptId: null });
  });
});

describe('parseBoundaryProbe（探测解析 fail-closed）', () => {
  it('正常 JSON → 字段映射', () => {
    expect(parseBoundaryProbe('{"interactive":true,"desktop":"Default","lockAppRunning":false,"runnerElevated":false,"targetPid":0,"targetElevated":false}'))
      .toEqual({ interactive: true, desktop: 'Default', lockAppRunning: false, runnerElevated: false, targetPid: 0, targetElevated: false });
  });

  it('坏输出 → 最严边界（非交互/锁定/受保护/高完整性）', () => {
    expect(parseBoundaryProbe('powershell error garbage'))
      .toEqual({ interactive: false, desktop: '', lockAppRunning: true, runnerElevated: false, targetPid: 0, targetElevated: true });
  });

  it('targetElevated:null 保留 null（分类层转 high）', () => {
    expect(parseBoundaryProbe('{"interactive":true,"desktop":"Default","lockAppRunning":false,"runnerElevated":false,"targetPid":0,"targetElevated":null}').targetElevated).toBe(null);
  });
});
