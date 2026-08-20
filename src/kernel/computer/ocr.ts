// src/kernel/computer/ocr.ts — W8-09：Windows 原生 OCR（Windows.Media.Ocr——系统组件零模型下载）
// 用户方向「积极依靠 Windows 生态」：图像文字识别走 WinRT OCR（离线、zh-Hans-CN/en-US），
// 非 Windows / 识别器不可用 → 诚实 ok:false（绝不伪造文本）。异步 spawn（不阻塞事件循环）。
import { spawn, spawnSync } from 'node:child_process';

let ocrAvailableCache: boolean | null = null;

/** 识别器可用性探测（结果缓存——状态展示不反复 spawn） */
export function probeWindowsOcr(): boolean {
  if (process.platform !== 'win32') return false;
  if (ocrAvailableCache !== null) return ocrAvailableCache;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime] | Out-Null; [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages.Count'],
      { stdio: 'pipe', timeout: 8000, windowsHide: true, encoding: 'utf8' });
    // PowerShell 会额外回显一次类型装载行——正则提取首个数字（'\r\n' 分隔的多行输出）
    const m = /\d+/.exec(String(r.stdout ?? ''));
    const n = m ? Number(m[0]) : NaN;
    ocrAvailableCache = Number.isFinite(n) && n > 0;
  } catch { ocrAvailableCache = false; }
  return ocrAvailableCache;
}

export type OcrResult = { ok: true; text: string; lang: string } | { ok: false; error: string };

/** 系统 OCR 识别图片文字（png/jpg 路径；语言 zh-Hans-CN → en-US → 用户档） */
export function ocrWindowsImage(imagePath: string, preferredLang = 'zh-Hans-CN'): Promise<OcrResult> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'Windows OCR 仅 Windows 可用（非 Windows 诚实降级）' });
      return;
    }
    const ps = [
      '[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null',
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
      '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" })[0]',
      'function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }',
      `$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('${preferredLang}')))`,
      'if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }',
      'if (-not $engine) { Write-Output "OCR_ERROR:no recognizer language"; exit 1 }',
      `$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${imagePath.replace(/'/g, "''")}')) ([Windows.Storage.StorageFile])`,
      '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
      '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
      '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
      '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
      "Write-Output ('OCR_TEXT:' + $result.Text)",
      '$stream.Dispose()',
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout!.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr!.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      resolve({ ok: false, error: 'Windows OCR 超时（>60s）' });
    }, 60_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'Windows OCR 进程启动失败' });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const reason = err.trim() || `exit ${code}`;
        resolve({ ok: false, error: `Windows OCR 失败：${String(reason).slice(0, 200)}` });
        return;
      }
      const line = out.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('OCR_TEXT:'));
      if (!line) {
        resolve({ ok: false, error: `Windows OCR 失败：${String(err.trim()).slice(0, 200) || '无识别结果'}` });
        return;
      }
      const text = line.slice('OCR_TEXT:'.length).trim();
      resolve(text ? { ok: true, text, lang: preferredLang } : { ok: false, error: 'Windows OCR 结果为空（图中无文字或识别器不匹配）' });
    });
  });
}
