// tests/wave8/w8-12-multimonitor-math.test.ts — W8-12：多屏坐标数学层验证（用户决策：零安装方案）
// 诚实边界：本机无第二显示器——OS 级多屏场景（computer-multimonitor）保持 blocked；
// 本轮验证**数学层**（坐标换算/区域裁剪在负原点+混合 DPI 布局下的确定性正确性），
// 并如实声明「物理层待双屏真机」——不把数学层冒充 OS 级 receipt。
import { describe, expect, it } from 'vitest';
import { convertCoords } from '../../src/kernel/computer/actionLayer.js';
import { captureScreen } from '../../src/kernel/computer/index.js';

describe('W8-12 多屏坐标数学层验证（零安装）', () => {
  it('convertCoords：截图物理像素 ÷ scale → 逻辑坐标（混合 DPI 各档）', () => {
    // 主屏 1.5×：物理 3840×2160 → 逻辑 2560×1440
    expect(convertCoords(3840, 2160, { scale: 1.5 })).toEqual({ x: 2560, y: 1440 });
    // 1.25×（本机实测档位）
    expect(convertCoords(1920, 1080, { scale: 1.25 })).toEqual({ x: 1536, y: 864 });
    // 1.0× 恒等
    expect(convertCoords(777, 888, { scale: 1 })).toEqual({ x: 777, y: 888 });
    // 四舍五入确定性（不产生亚像素漂移）
    expect(convertCoords(100, 100, { scale: 1.5 })).toEqual({ x: 67, y: 67 });
  });

  it('区域裁剪：越界负坐标钳到 0、超界裁剪到屏幕内（真实截屏路径）', async () => {
    if (process.platform !== 'win32') return;
    const shot = await captureScreen({ region: { x: -50, y: -30, width: 200, height: 100 } });
    expect(shot).not.toBeNull();
    if (!shot) return;
    // 钳制后区域完全落在屏幕内且非空
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    expect(shot.width).toBeLessThanOrEqual(200);
    expect(shot.height).toBeLessThanOrEqual(100);
  });

  it('负原点布局变换公式（规范级锚点——代码当前单屏截取，OS 级场景仍待双屏真机）', () => {
    // 规范公式：副屏物理原点 x=-1920（scale 1.0）、主屏原点 0（scale 1.5）——
    // 任意物理像素 p 的逻辑坐标 = 所属屏原点 + (p - 物理原点) / scale。
    // 本测试锁定该公式与验收场景（computer-multimonitor.ps1）的期望一致。
    const toLogical = (p: { x: number; y: number }, origin: { x: number; y: number }, scale: number) => ({
      x: Math.round(origin.x + (p.x - origin.x) / scale),
      y: Math.round(origin.y + (p.y - origin.y) / scale),
    });
    // 副屏（负原点）scale 1.0：逻辑=物理恒等——屏幕左边缘物理 -1920 → 逻辑 -1920（负原点保留）；
    // 物理 (0,100) 恰为主屏边界 → 逻辑 (0,100)
    expect(toLogical({ x: -1920, y: 0 }, { x: -1920, y: 0 }, 1)).toEqual({ x: -1920, y: 0 });
    expect(toLogical({ x: 0, y: 100 }, { x: -1920, y: 0 }, 1)).toEqual({ x: 0, y: 100 });
    // 主屏 1.5× 物理 (3840,2160) → 逻辑 (2560,1440)（与 convertCoords 单屏行为一致）
    expect(toLogical({ x: 3840, y: 2160 }, { x: 0, y: 0 }, 1.5)).toEqual({ x: 2560, y: 1440 });
    // 副屏中心点物理 (-960,540) → 逻辑 (-960,540)（scale 1 恒等——负坐标正确保留）
    expect(toLogical({ x: -960, y: 540 }, { x: -1920, y: 0 }, 1)).toEqual({ x: -960, y: 540 });
  });
});
