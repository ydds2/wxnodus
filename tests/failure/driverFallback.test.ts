// tests/failure/driverFallback.test.ts — W3-06：fallback 路径的失败边界（坐标越界/DPI 缺失/降级禁止/未验证 fallback）
import { describe, expect, it, vi } from 'vitest';
import { RobotComputerDriver } from '../../src/infrastructure/computer/robotComputerDriver.js';
import { WindowsUiaDriver } from '../../src/infrastructure/computer/windowsUiaDriver.js';

const desktop = {
  dpiAwareness: 'per-monitor-v2' as const,
  monitors: [{
    id: 'main',
    logicalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    physicalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    physicalOrigin: { x: 0, y: 0 },
    scale: 1,
  }],
};

describe('driver fallback failures', () => {
  it('maps out-of-desktop coordinates to COORDINATE_OUTSIDE_VIRTUAL_DESKTOP', async () => {
    const driver = new RobotComputerDriver({
      desktop: async () => desktop,
      move: vi.fn(async () => true),
      click: vi.fn(async () => true),
    });
    const result = await driver.act({ kind: 'click', point: { x: 9000, y: 9000 } }, {}, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'COORDINATE_OUTSIDE_VIRTUAL_DESKTOP' } });
  });

  it('requires PMv2 awareness before any cursor transform', async () => {
    const driver = new RobotComputerDriver({
      desktop: async () => ({ ...desktop, dpiAwareness: 'system' as never }),
      move: vi.fn(async () => true),
      click: vi.fn(async () => true),
    });
    const result = await driver.act({ kind: 'move', point: { x: 10, y: 10 } }, {}, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'DPI_AWARENESS_REQUIRED' } });
  });

  it('forbids coordinate fallback when the boundary degrades mid-action', async () => {
    let call = 0;
    const coordinateFallback = vi.fn(async () => ({ acted: true, receiptId: 'c1' }));
    const driver = new WindowsUiaDriver({
      inspectBoundary: async () => {
        call += 1;
        return call === 1
          ? { interactive: true, unlocked: true, inputDesktop: 'Default', runnerIntegrity: 'medium', targetIntegrity: 'medium', protectedUi: false }
          : { interactive: false, unlocked: true, inputDesktop: 'Default', runnerIntegrity: 'medium', targetIntegrity: 'medium', protectedUi: false };
      },
      invoke: async () => false,
      select: async () => false,
      coordinateFallback,
    });
    const result = await driver.act({ runtimeId: '42', action: 'activate' }, {}, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'UIA_COORDINATE_FALLBACK_FORBIDDEN' } });
    expect(coordinateFallback).not.toHaveBeenCalled();
  });

  it('reports DRIVER_FALLBACK_UNVERIFIED when a coordinate action cannot be verified', async () => {
    const driver = new RobotComputerDriver({
      desktop: async () => desktop,
      move: vi.fn(async () => true),
      click: vi.fn(async () => true),
      verify: vi.fn(async () => ({ ok: false })),
    });
    const result = await driver.act({ kind: 'click', point: { x: 10, y: 10 } }, {}, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: false, error: { code: 'DRIVER_FALLBACK_UNVERIFIED' } });
  });

  it('does not act when the backend refuses the move', async () => {
    const click = vi.fn(async () => true);
    const driver = new RobotComputerDriver({
      desktop: async () => desktop,
      move: vi.fn(async () => false),
      click,
    });
    const result = await driver.act({ kind: 'click', point: { x: 10, y: 10 } }, {}, AbortSignal.timeout(100));
    expect(result).toMatchObject({ ok: true, value: { acted: false, receiptId: null } });
    expect(click).not.toHaveBeenCalled();
  });
});
