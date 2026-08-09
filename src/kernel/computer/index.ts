// src/kernel/computer/index.ts — L3-3b computer use 主入口
// 设计（可视化 AI 技能）：observe(截图→GLM-4V 理解) → plan → act(护栏+串行) → verify
//   桌面域：robotjs（鼠标/键盘/中文剪贴板）；浏览器域：playwright-core（CDP）
//   截屏：node-screenshots（DPI 感知多显示器）
import { ActionGuard } from './guards.js';
import { validateAction, convertCoords, type CuAction } from './actionLayer.js';

export interface ScreenShot { png: Buffer; width: number; height: number; scale: number }

// 桌面控制（robotjs 0.9.1 封装——Node-API 预编译，Unicode 中文支持）
let robot: any = null;
function getRobot(): any {
  if (!robot) { robot = require('robotjs'); }
  return robot;
}

// 截屏（node-screenshots：XCap Rust 原生，多显示器 scaleFactor）
export async function captureScreen(): Promise<ScreenShot | null> {
  try {
    const { Monitor } = await import('node-screenshots');
    const monitors = await Monitor.all();
    if (!monitors.length) return null;
    const m = monitors[0];
    const img = await m.captureImageSync();
    return { png: Buffer.from(img.toPng()), width: m.width, height: m.height, scale: m.scaleFactor() };
  } catch { return null; } // 原生模块不可用（CI/无桌面）→ null
}

export class ComputerUse {
  constructor(private guard: ActionGuard) {}

  async observe(): Promise<ScreenShot | null> {
    return captureScreen();
  }

  // 可视化理解：截图 → base64 → GLM-4V（vision 模块）
  async observeWithVision(describe: (png: Buffer) => Promise<string | null>): Promise<string | null> {
    const shot = await captureScreen();
    if (!shot) return null;
    return describe(shot.png);
  }

  async act(a: CuAction): Promise<string> {
    if (!validateAction(a)) return `动作非法：${JSON.stringify(a)}`;
    this.guard.check(a);
    return this.guard.run(async () => {
      try {
        switch (a.type) {
          case 'click': {
            const r = getRobot();
            r.moveMouse(a.x, a.y);
            r.mouseClick(a.button === 'right' ? 'right' : a.button === 'double' ? 'double' : 'left');
            return `已点击 (${a.x},${a.y})`;
          }
          case 'type': {
            // 中文走剪贴板粘贴（调研结论：typeString 对 CJK 不可靠）
            if (/[\u4e00-\u9fff]/.test(a.text)) {
              const { pasteText } = await import('./clipboard.js');
              await pasteText(a.text);
              getRobot().keyTap('v', ['control']);
            } else {
              getRobot().typeString(a.text);
            }
            return `已输入 ${a.text.length} 字符`;
          }
          case 'key': {
            getRobot().keyTap(a.key);
            return `已按键 ${a.key}`;
          }
          case 'paste': {
            const { pasteText } = await import('./clipboard.js');
            await pasteText(a.text);
            getRobot().keyTap('v', ['control']);
            return '已粘贴';
          }
          case 'scroll': {
            getRobot().scrollMouse(a.x, a.y, a.amount);
            return `已滚动 ${a.amount}`;
          }
          case 'open': {
            const { exec } = await import('node:child_process');
            exec(`start "" "${a.url}"`);
            return `已打开 ${a.url}`;
          }
          default: return `未支持动作：${(a as any).type}`;
        }
      } catch (e: any) {
        return `动作失败：${e?.message?.slice(0, 200)}`;
      }
    });
  }
}

// DPI 感知动作：截图坐标 → 换算 → 点击
export async function clickOnScreen(x: number, y: number, shot: ScreenShot, cu: ComputerUse): Promise<string> {
  const { x: lx, y: ly } = convertCoords(x, y, { scale: shot.scale });
  return cu.act({ type: 'click', x: lx, y: ly });
}
