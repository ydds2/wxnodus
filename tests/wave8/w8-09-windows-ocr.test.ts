// tests/wave8/w8-09-windows-ocr.test.ts — W8-09：Windows.Media.Ocr 原生 OCR 桥契约（Windows 生态互依）
// 契约：屏幕/图像文字识别走系统原生 OCR（零模型下载、离线可用——用户方向「积极依靠 Windows 生态」）：
// ① 真实回路：.NET 画文本 → PNG → ocrWindowsImage 读回含关键词（本机识别器可用时）；
// ② 非 Windows / 无识别器 → 诚实 ok:false（不伪造文本）；
// ③ 异步 spawn（不阻塞事件循环——KF-006 同款纪律）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ocrWindowsImage } from '../../src/kernel/computer/ocr.js';
import { captureScreenNativeFallback } from '../../src/kernel/computer/index.js';
import { describeImageStatus } from '../../src/kernel/vision.js';

const isWin = process.platform === 'win32';

describe('W8-09 Windows 原生 OCR（Windows.Media.Ocr）', () => {
  it('真实回路：绘制文本 PNG → 系统 OCR 读回（含关键词）', async () => {
    if (!isWin) return; // 非 Windows 无 WinRT OCR——诚实跳过（Windows-only 定位）
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'w8-09-'));
    const png = join(dir, 'text.png');
    // 纯 ASCII 绘制文本（CJK 渲染依赖字体——关键词用 ASCII 保证确定性）
    const ps = [
      'Add-Type -AssemblyName System.Drawing',
      `$b = [System.Drawing.Bitmap]::new(640, 160)`,
      '$g = [System.Drawing.Graphics]::FromImage($b)',
      '$g.Clear([System.Drawing.Color]::White)',
      '$f = New-Object System.Drawing.Font("Arial", 36)',
      "$g.DrawString('WxNodus OCR Probe 2026', $f, [System.Drawing.Brushes]::Black, 20, 50)",
      '$g.Dispose()',
      `$b.Save('${png.replace(/'/g, "''").replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$b.Dispose()',
    ].join('; ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', timeout: 30000 });
    if (r.status !== 0) return; // 绘制失败——诚实跳过
    const out = await ocrWindowsImage(png);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain('OCR');
  }, 60000);

  it('非 Windows → ok:false（诚实降级，绝不伪造文本）', async () => {
    if (isWin) return;
    const out = await ocrWindowsImage('C:/nonexistent.png');
    expect(out.ok).toBe(false);
  });

  it('vision 兜底：无视觉密钥 → describeImageStatus 走系统 OCR 读回画面文字', async () => {
    if (!isWin) return;
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'w8-09-vis-'));
    const png = join(dir, 'text.png');
    const ps = [
      'Add-Type -AssemblyName System.Drawing',
      '$b = [System.Drawing.Bitmap]::new(640, 160)',
      '$g = [System.Drawing.Graphics]::FromImage($b)',
      '$g.Clear([System.Drawing.Color]::White)',
      '$f = New-Object System.Drawing.Font("Arial", 36)',
      "$g.DrawString('Vision Fallback Probe', $f, [System.Drawing.Brushes]::Black, 20, 50)",
      '$g.Dispose()',
      `$b.Save('${png.replace(/'/g, "''").replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$b.Dispose()',
    ].join('; ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe', timeout: 30000 });
    if (r.status !== 0) return;
    // 无 key（apiKeyEnc=null 且 env 无视觉 key）——不得返回「未配置密钥」错误而应走系统 OCR
    const prev = process.env.WXNODUS_VISION_KEY;
    delete process.env.WXNODUS_VISION_KEY;
    try {
      const out = await describeImageStatus(png, null, '读取画面文字');
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.text).toContain('Fallback');
    } finally {
      if (prev !== undefined) process.env.WXNODUS_VISION_KEY = prev;
    }
    rmSync(dir, { recursive: true, force: true });
  }, 90000);

  it('截图原生兜底：System.Drawing CopyFromScreen 返回真实屏幕 PNG（win32 真机）', async () => {
    if (!isWin) return;
    const shot = await captureScreenNativeFallback();
    expect(shot).not.toBeNull();
    if (!shot) return;
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    expect(shot.png.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  }, 60000);
});
