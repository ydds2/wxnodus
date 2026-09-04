// src/kernel/computer/index.ts — L3-3b computer use 主入口
// 设计（可视化 AI 技能）：observe(截图→GLM-4V 理解) → plan → act(护栏+串行) → verify
//   桌面域：robotjs（鼠标/键盘/中文剪贴板）；浏览器域：playwright-core（CDP）
//   截屏：node-screenshots（DPI 感知多显示器）
import { ActionGuard } from './guards.js';
import { validateAction, type CuAction } from './actionLayer.js';
import { createRequire } from 'node:module';

// robotjs 为 CommonJS 包——ESM 下经 createRequire 加载（Node-API 预编译，Unicode 中文支持）
const requireCjs = createRequire(import.meta.url);

export interface ScreenShot { png: Buffer; width: number; height: number; scale: number }

// 桌面控制（robotjs 0.9.1 封装——Node-API 预编译，Unicode 中文支持）
// W8-10：加载失败记忆（robotFailed）——不反复抛；各动作分支在 getRobot() 为空时
// 兜底系统 user32 SendInput（nativeInput.ts，零原生模块单点）
let robot: any = null;
let robotFailed = false;
function getRobot(): any {
  if (!robot && !robotFailed) {
    try {
      robot = requireCjs('robotjs');
    } catch {
      robotFailed = true;
      robot = null;
    }
  }
  return robot;
}

// 截屏（node-screenshots：XCap Rust 原生，多显示器 scaleFactor）
// opts.region：用户所需切片界面信息——指定屏幕区域裁剪（x/y/width/height，
// 物理像素坐标）；缺省全屏。敏感操作留证/界面切片分析共用此入口
export interface CaptureRegion { x: number; y: number; width: number; height: number }
export async function captureScreen(opts: { region?: CaptureRegion; monitor?: number } = {}): Promise<ScreenShot | null> {
  try {
    const { Monitor } = await import('node-screenshots');
    const monitors = await Monitor.all();
    if (!monitors.length) return null;
    // ⅩⅩⅩ（C-2）：多显示器支持——monitor 索引可选（缺省主屏 0）
    const m = monitors[Math.min(Math.max(opts.monitor ?? 0, 0), monitors.length - 1)]!;
    let img = m.captureImageSync();
    const scale = Number(m.scaleFactor()) || 1;
    // KF-007：Monitor 的 width/height 是方法不是属性——读属性拿到函数本身（→NaN）。
    // 必须调用 width()/height() 取真实物理像素
    let width = m.width();
    let height = m.height();
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
  } catch {
    // W8-09 Windows 生态互依：node-screenshots 原生模块失败 → 系统 .NET CopyFromScreen 兜底
    // （消除 npm 原生模块单点——npm install 原生编译失败时截屏仍可用）
    return captureScreenNativeFallback(opts);
  }
}

/** 系统原生截屏兜底（System.Drawing CopyFromScreen——异步 spawn 不阻塞；非 Windows 返回 null） */
export async function captureScreenNativeFallback(opts: { region?: CaptureRegion } = {}): Promise<ScreenShot | null> {
  if (process.platform !== 'win32') return null;
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wxn-shot-'));
  const pngPath = join(dir, 'screen.png');
  const region = opts.region;
  const bounds = region
    ? `[System.Drawing.Rectangle]::new(${Math.max(0, Math.floor(region.x))}, ${Math.max(0, Math.floor(region.y))}, ${Math.floor(region.width)}, ${Math.floor(region.height)})`
    : '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds';
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Windows.Forms',
    `$bounds = ${bounds}`,
    '$b = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    '$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $b.Size)',
    '$g.Dispose()',
    `$b.Save('${pngPath.replace(/'/g, "''").replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$b.Dispose()',
    "Write-Output ('SHOT_OK:' + $bounds.Width + 'x' + $bounds.Height)",
  ].join('; ');
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout!.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      resolve(null);
    }, 15_000);
    child.on('error', () => {
      clearTimeout(timer);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      resolve(null);
    });
    child.on('close', code => {
      clearTimeout(timer);
      let result: ScreenShot | null = null;
      if (code === 0) {
        try {
          const m = /SHOT_OK:(\d+)x(\d+)/.exec(out);
          const png = readFileSync(pngPath);
          if (m && png.length > 0) result = { png, width: Number(m[1]), height: Number(m[2]), scale: 1 };
        } catch { result = null; }
      }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      resolve(result);
    });
  });
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
            if (!r) {
              const { nativeInput } = await import('./nativeInput.js');
              const fb = await nativeInput(a);
              return fb.ok ? `已点击 (${a.x},${a.y})（系统 SendInput 兜底）` : `[ERROR] 动作失败（robotjs 不可用且系统兜底失败）：${fb.error ?? ''}`;
            }
            r.moveMouse(a.x, a.y);
            // KF-008：robotjs mouseClick 无 'double' 按钮语义——双击走布尔第二参
            // mouseClick(button, double)；把 'double' 当按钮名传入是参数不匹配
            r.mouseClick(a.button === 'right' ? 'right' : 'left', a.button === 'double');
            return `已点击 (${a.x},${a.y})`;
          }
          case 'type': {
            const r = getRobot();
            if (!r) {
              const { nativeInput } = await import('./nativeInput.js');
              const fb = await nativeInput(a);
              return fb.ok ? `已输入 ${a.text.length} 字符（系统 SendInput 兜底）` : `[ERROR] 动作失败（robotjs 不可用且系统兜底失败）：${fb.error ?? ''}`;
            }
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
            const r = getRobot();
            if (!r) {
              const { nativeInput } = await import('./nativeInput.js');
              const fb = await nativeInput(a);
              return fb.ok ? `已按键 ${a.key}（系统 SendInput 兜底）` : `动作失败（robotjs 不可用且系统兜底失败）：${fb.error ?? ''}`;
            }
            getRobot().keyTap(a.key);
            return `已按键 ${a.key}`;
          }
          case 'paste': {
            const { pasteText } = await import('./clipboard.js');
            await pasteText(a.text);
            const r = getRobot();
            if (!r) {
              const { nativeInput } = await import('./nativeInput.js');
              const fb = await nativeInput({ type: 'key', key: 'v' });
              return fb.ok ? '已粘贴（系统 SendInput 兜底）' : `动作失败（robotjs 不可用且系统兜底失败）：${fb.error ?? ''}`;
            }
            getRobot().keyTap('v', ['control']);
            return '已粘贴';
          }
          case 'scroll': {
            const r = getRobot();
            if (!r) {
              const { nativeInput } = await import('./nativeInput.js');
              const fb = await nativeInput(a);
              return fb.ok ? `已滚动 ${a.amount}（系统 SendInput 兜底）` : `动作失败（robotjs 不可用且系统兜底失败）：${fb.error ?? ''}`;
            }
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

// ⅩⅩⅩ（专项审计 C-1）：截图坐标系 = 物理像素（node-screenshots 物理分辨率），
// robotjs moveMouse / SetCursorPos 也是物理像素语义——此前 convertCoords（÷scale）把物理
// 转逻辑再交给物理 API，DPI>1 时点击系统性偏向左上。修复：截图像素直接透传（单屏语义）。
// 多屏负原点/混合 DPI 场景的正确变换层（virtualDesktop toPhysicalPoint）保留在
// infrastructure 层——computer 工具链接入时启用（当前 captureScreen 仅主屏，坐标即主屏物理）。
export async function clickOnScreen(x: number, y: number, _shot: ScreenShot, cu: ComputerUse): Promise<string> {
  return cu.act({ type: 'click', x: Math.round(x), y: Math.round(y) });
}
