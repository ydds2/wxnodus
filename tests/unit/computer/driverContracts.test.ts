// tests/unit/computer/driverContracts.test.ts — W3-06 Step 1：坐标变换/URL 策略/UIA 边界契约（计划原文）
import { describe, expect, it, vi } from 'vitest';
import { toPhysicalPoint } from '../../../src/infrastructure/computer/virtualDesktop.js';
import { UrlPolicy } from '../../../src/infrastructure/computer/urlPolicy.js';
import { WindowsUiaDriver } from '../../../src/infrastructure/computer/windowsUiaDriver.js';

it('maps PMv2 logical points through monitor physical origin on negative-origin mixed-DPI monitors', () => {
  const desktop = { dpiAwareness: 'per-monitor-v2' as const, monitors: [
    {
      id: 'left',
      logicalBounds: { x: -1280, y: 0, width: 1280, height: 1024 },
      physicalBounds: { x: -1280, y: 0, width: 1280, height: 1024 },
      physicalOrigin: { x: -1280, y: 0 },
      scale: 1,
    },
    {
      id: 'main',
      logicalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      physicalBounds: { x: 0, y: 0, width: 2880, height: 1620 },
      physicalOrigin: { x: 0, y: 0 },
      scale: 1.5,
    },
    {
      id: 'top',
      logicalBounds: { x: 0, y: -900, width: 1600, height: 900 },
      physicalBounds: { x: 0, y: -1125, width: 2000, height: 1125 },
      physicalOrigin: { x: 0, y: -1125 },
      scale: 1.25,
    },
  ] };
  expect(toPhysicalPoint(desktop, { x: -100, y: 100 })).toEqual({
    monitorId: 'left', physicalOrigin: { x: -1280, y: 0 }, scaledLocal: { x: 1180, y: 100 }, x: -100, y: 100,
  });
  expect(toPhysicalPoint(desktop, { x: 100, y: 100 })).toEqual({
    monitorId: 'main', physicalOrigin: { x: 0, y: 0 }, scaledLocal: { x: 150, y: 150 }, x: 150, y: 150,
  });
  expect(toPhysicalPoint(desktop, { x: 100, y: -100 })).toEqual({
    monitorId: 'top', physicalOrigin: { x: 0, y: -1125 }, scaledLocal: { x: 125, y: 1000 }, x: 125, y: -125,
  });
  expect(() => toPhysicalPoint(desktop, { x: 9000, y: 9000 })).toThrowError('COORDINATE_OUTSIDE_VIRTUAL_DESKTOP');
});

it('applies URL policy to public-to-private redirects and resolved addresses', async () => {
  const policy = new UrlPolicy({ resolve: async host => host === 'public.example' ? ['203.0.113.8'] : ['127.0.0.1'] });
  await expect(policy.authorize('https://public.example/start')).resolves.toMatchObject({ ok: true });
  await expect(policy.authorize('http://localhost/admin')).resolves.toMatchObject({
    ok: false,
    error: { code: 'BROWSER_URL_POLICY_DENIED' },
  });
});

it.each([
  ['service session', { interactive: false }, 'UIA_SESSION_NOT_INTERACTIVE'],
  ['locked session', { unlocked: false }, 'UIA_SESSION_LOCKED'],
  ['secure desktop', { inputDesktop: 'Winlogon' }, 'SECURE_DESKTOP_BLOCKED'],
  ['higher integrity target', { targetIntegrity: 'high' }, 'UIA_TARGET_INTEGRITY_BLOCKED'],
  ['protected system UI', { protectedUi: true }, 'UIA_PROTECTED_UI_BLOCKED'],
] as const)('fails closed before %s actions and never calls coordinate fallback', async (_name, patch, code) => {
  const coordinateFallback = vi.fn(async () => ({ acted: true, receiptId: 'coordinate-1' }));
  const driver = new WindowsUiaDriver({
    inspectBoundary: async () => ({
      interactive: true, unlocked: true, inputDesktop: 'Default', runnerIntegrity: 'medium', targetIntegrity: 'medium', protectedUi: false,
      ...patch,
    }),
    invoke: async () => false,
    select: async () => false,
    coordinateFallback,
  });
  await expect(driver.act({ runtimeId: '42', action: 'activate' }, {}, AbortSignal.timeout(100))).resolves.toMatchObject({
    ok: false,
    error: { code },
  });
  expect(coordinateFallback).not.toHaveBeenCalled();
});

it('does not report success when Invoke and Selection fail and a coordinate fallback is not explicitly safe', async () => {
  const driver = new WindowsUiaDriver({
    inspectBoundary: async () => ({
      interactive: true, unlocked: true, inputDesktop: 'Default', runnerIntegrity: 'medium', targetIntegrity: 'medium', protectedUi: false,
    }),
    invoke: async () => false,
    select: async () => false,
    coordinateFallback: async () => ({ acted: false, receiptId: null }),
  });
  await expect(driver.act({ runtimeId: '42', action: 'activate' }, {}, AbortSignal.timeout(100))).resolves.toMatchObject({
    ok: false,
    error: { code: 'UIA_ACTION_NOT_PERFORMED' },
  });
});
