// src/kernel/computer/index.ts — L3-3b computer use 主入口
// 设计（可视化 AI 技能）：observe(截图→GLM-4V 理解) → plan → act(护栏+串行) → verify
//   桌面域：robotjs（鼠标/键盘/中文剪贴板）；浏览器域：playwright-core（CDP）
//   截屏：node-screenshots（DPI 感知多显示器）
import { ActionGuard } from './guards.js';
import { validateAction, convertCoords, type CuAction } from './actionLayer.js';
import { createRequire } from 'node:module';

// robotjs 为 CommonJS 包——ESM 下经 createRequire 加载（Node-API 预编译，Unicode 中文支持）
const requireCjs = createRequire(import.meta.url);

export interface ScreenShot { png: Buffer; width: number; height: number; scale: number }

// 桌面控制（robotjs 0.9.1 封装——Node-API 预编译，Unicode 中文支持）
let robot: any = null;
function getRobot(): any {
  if (!robot) { robot = requireCjs('robotjs'); }
  return robot;
}

// 截屏（node-screenshots：XCap Rust 原生，多显示器 scaleFactor）
// opts.region：用户所需切片界面信息——指定屏幕区域裁剪（x/y/width/height，
// 物理像素坐标）；缺省全屏。敏感操作留证/界面切片分析共用此入口
export interface CaptureRegion { x: number; y: number; width: number; height: number }
export async function captureScreen(opts: { region?: CaptureRegion } = {}): Promise<ScreenShot | null> {
  try {
    const { Monitor } = await import('node-screenshots');
    const monitors = await Monitor.all();
    if (!monitors.length) return null;
    const m = monitors[0];
    let img = m.captureImageSync();
    const scale = Number(m.scaleFactor()) || 1;
    let width = (m as any).width;
    let height = (m as any).height;
    if (opts.region) {
      const r = opts.region;
      // 越界裁剪为有效区（与屏幕边界求交）
      const x = Math.max(0, Math.floor(r.x));
      const y = Math.max(0, Math.floor(r.y));
      const w = Math.min(Math.floor(r.width), width - x);
      const h = Math.min(Math.floor(r.height), height - y);
      if (w > 0 && h > 0) {
        img = img.cropSync(x, y, w, h);
        width = w;
        height = h;
      }
    }
    const png = await img.toPng();
    return { png: Buffer.from(png), width, height, scale };
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
            // 审查修复（P1 注入）：exec(`start "" "${url}"`) 的 shell 拼接可被
            // `" & <命令> & "` 闭合逃逸为任意命令执行——改 spawn 参数数组（不经 shell 解释）
            // + URL 形态校验（拒绝引号/控制字符/空格后的命令拼接）
            const u = String(a.url ?? '');
            if (/[\x00-\x1f"']/.test(u) || !/^https?:\/\//i.test(u)) {
              return `动作非法：open 仅接受 http/https URL（拒绝引号与控制字符）`;
            }
            const { spawn } = await import('node:child_process');
            await new Promise<void>((resolve, reject) => {
              const c = spawn('cmd', ['/c', 'start', '', u], { shell: false, windowsHide: true });
              c.on('error', reject);
              c.on('exit', () => resolve());
            });
            return `已打开 ${u}`;
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
