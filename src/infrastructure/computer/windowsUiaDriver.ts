// src/infrastructure/computer/windowsUiaDriver.ts — UIA 驱动（计划原文）：
// 每个动作（不只初始化）重新证明 interactive/unlocked/Default input desktop/完整性与受保护 UI 边界；
// Secure Desktop/UAC/login/lock/高完整性/受保护 UI 一律 fail-closed，禁止坐标 fallback
import type { OperationResult } from '../../protocol/results.js';

type IntegrityLevel = 'low' | 'medium' | 'high' | 'system';
interface ActionBoundary {
  interactive: boolean;
  unlocked: boolean;
  inputDesktop: string;
  runnerIntegrity: IntegrityLevel;
  targetIntegrity: IntegrityLevel;
  protectedUi: boolean;
}
interface UiaPorts {
  inspectBoundary(runtimeId: string): Promise<ActionBoundary>;
  invoke(runtimeId: string): Promise<boolean>;
  select(runtimeId: string): Promise<boolean>;
  coordinateFallback(runtimeId: string): Promise<{ acted: boolean; receiptId: string | null }>;
}
const rank: Record<IntegrityLevel, number> = { low: 0, medium: 1, high: 2, system: 3 };
const blocked = (code: string): OperationResult<never> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false },
});

export class WindowsUiaDriver {
  constructor(private readonly ports: UiaPorts) {}
  async act(action: { runtimeId: string; action: 'activate' }, _context: unknown, _signal: AbortSignal): Promise<OperationResult<{ acted: true; receiptId: string }>> {
    // Re-run this preflight before every UIA pattern or coordinate action; never cache it for a session.
    const boundary = await this.ports.inspectBoundary(action.runtimeId);
    if (!boundary.interactive) return blocked('UIA_SESSION_NOT_INTERACTIVE');
    if (!boundary.unlocked) return blocked('UIA_SESSION_LOCKED');
    if (boundary.inputDesktop !== 'Default') return blocked('SECURE_DESKTOP_BLOCKED');
    if (boundary.protectedUi) return blocked('UIA_PROTECTED_UI_BLOCKED');
    if (rank[boundary.targetIntegrity] > rank[boundary.runnerIntegrity]) return blocked('UIA_TARGET_INTEGRITY_BLOCKED');
    if (await this.ports.invoke(action.runtimeId)) return { ok: true, value: { acted: true, receiptId: `uia-invoke-${action.runtimeId}` } };

    const beforeSelect = await this.ports.inspectBoundary(action.runtimeId);
    if (!beforeSelect.interactive || !beforeSelect.unlocked || beforeSelect.inputDesktop !== 'Default' ||
        beforeSelect.protectedUi || rank[beforeSelect.targetIntegrity] > rank[beforeSelect.runnerIntegrity]) {
      return blocked(beforeSelect.inputDesktop !== 'Default' ? 'SECURE_DESKTOP_BLOCKED' : 'UIA_COORDINATE_FALLBACK_FORBIDDEN');
    }
    if (await this.ports.select(action.runtimeId)) return { ok: true, value: { acted: true, receiptId: `uia-select-${action.runtimeId}` } };

    // Coordinate fallback is only eligible for ordinary Default-desktop app UI. SecureDesktop/UAC/login/lock/protected/high-integrity failures never reach it.
    const beforeCoordinate = await this.ports.inspectBoundary(action.runtimeId);
    if (!beforeCoordinate.interactive || !beforeCoordinate.unlocked || beforeCoordinate.inputDesktop !== 'Default' ||
        beforeCoordinate.protectedUi || rank[beforeCoordinate.targetIntegrity] > rank[beforeCoordinate.runnerIntegrity]) {
      return blocked('UIA_COORDINATE_FALLBACK_FORBIDDEN');
    }
    const fallback = await this.ports.coordinateFallback(action.runtimeId);
    if (fallback.acted && fallback.receiptId) return { ok: true, value: { acted: true, receiptId: fallback.receiptId } };
    return blocked('UIA_ACTION_NOT_PERFORMED');
  }
}
