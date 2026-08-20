// src/infrastructure/computer/robotComputerDriver.ts — 坐标驱动（robotjs 后端注入）：PMv2 变换 → 物理坐标 → move/click；
// 可选 verify 端口验证动作效果——fallback 执行了却无法验证即 DRIVER_FALLBACK_UNVERIFIED
import type { OperationResult } from '../../protocol/results.js';
import type { VirtualDesktopSnapshot } from './virtualDesktop.js';
import { toPhysicalPoint } from './virtualDesktop.js';

export interface RobotComputerPorts {
  desktop(): Promise<VirtualDesktopSnapshot>;
  move(x: number, y: number): Promise<boolean>;
  click(): Promise<boolean>;
  /** 动作后验证端口；缺失时坐标 fallback 的动作效果视为未验证 */
  verify?(point: { x: number; y: number }): Promise<{ ok: boolean }>;
}

const err = <T = never>(code: string, details?: Record<string, unknown>): OperationResult<T> => ({
  ok: false,
  error: { code, message: code, messageKey: code, retryable: false, details },
});

export class RobotComputerDriver {
  constructor(private readonly ports: RobotComputerPorts) {}

  async act(action: { kind: 'move' | 'click'; point: { x: number; y: number } }, _context: unknown, _signal: AbortSignal): Promise<OperationResult<{ acted: boolean; receiptId: string | null }>> {
    let desktop: VirtualDesktopSnapshot;
    try { desktop = await this.ports.desktop(); } catch { return err('COORDINATE_PHYSICAL_BOUNDS_INVALID'); }
    let physical: { x: number; y: number };
    try {
      physical = toPhysicalPoint(desktop, action.point);
    } catch (error) {
      return err((error as Error)?.message ?? 'COORDINATE_TRANSFORM_INVALID', { point: action.point });
    }
    const moved = await this.ports.move(physical.x, physical.y);
    if (!moved) return { ok: true, value: { acted: false, receiptId: null } };
    if (action.kind === 'click') {
      const clicked = await this.ports.click();
      if (!clicked) return { ok: true, value: { acted: false, receiptId: null } };
    }
    if (this.ports.verify) {
      const verified = await this.ports.verify(physical);
      if (!verified.ok) return err('DRIVER_FALLBACK_UNVERIFIED', { point: physical });
    }
    return { ok: true, value: { acted: true, receiptId: `coordinate-${physical.x}-${physical.y}` } };
  }
}
