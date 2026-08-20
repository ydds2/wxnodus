// src/infrastructure/computer/virtualDesktop.ts — PMv2 多屏 DPI 坐标变换（计划原文）：
// 唯一合法变换 physical = physicalOrigin + scaledLocal（负原点/混合 DPI 精确映射）
export interface Rect { x: number; y: number; width: number; height: number }
export interface MonitorSnapshot {
  id: string;
  logicalBounds: Rect;
  physicalBounds: Rect;
  physicalOrigin: { x: number; y: number };
  scale: number;
}
export interface VirtualDesktopSnapshot {
  dpiAwareness: 'per-monitor-v2';
  monitors: MonitorSnapshot[];
}

const contains = (bounds: Rect, point: { x: number; y: number }): boolean =>
  point.x >= bounds.x && point.x < bounds.x + bounds.width &&
  point.y >= bounds.y && point.y < bounds.y + bounds.height;

export function toPhysicalPoint(desktop: VirtualDesktopSnapshot, point: { x: number; y: number }) {
  if (desktop.dpiAwareness !== 'per-monitor-v2') throw new Error('DPI_AWARENESS_REQUIRED');
  const monitor = desktop.monitors.find(candidate => contains(candidate.logicalBounds, point));
  if (!monitor) throw new Error('COORDINATE_OUTSIDE_VIRTUAL_DESKTOP');
  if (monitor.physicalOrigin.x !== monitor.physicalBounds.x || monitor.physicalOrigin.y !== monitor.physicalBounds.y ||
      monitor.scale <= 0 || monitor.physicalBounds.width <= 0 || monitor.physicalBounds.height <= 0) {
    throw new Error('COORDINATE_PHYSICAL_BOUNDS_INVALID');
  }
  const scaledLocal = {
    x: Math.round((point.x - monitor.logicalBounds.x) * monitor.scale),
    y: Math.round((point.y - monitor.logicalBounds.y) * monitor.scale),
  };
  const physical = {
    x: monitor.physicalOrigin.x + scaledLocal.x,
    y: monitor.physicalOrigin.y + scaledLocal.y,
  };
  if (!contains(monitor.physicalBounds, physical)) throw new Error('COORDINATE_TRANSFORM_INVALID');
  return { monitorId: monitor.id, physicalOrigin: monitor.physicalOrigin, scaledLocal, ...physical };
}
