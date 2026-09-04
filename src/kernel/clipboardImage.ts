// src/kernel/clipboardImage.ts — 剪贴板图像捕获（原型 33 附件通道：Ctrl+V 粘贴截图的实现侧）
// Windows：PowerShell + System.Windows.Forms 剪贴板 API → PNG 落盘 dataDir/clipboard/（数据不出机）；
// 尺寸/字节从 PNG IHDR 解析（零图像库依赖）。非 Windows 诚实不可用（产品 os=win32）。
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export interface ClipboardImage {
  path: string
  width: number
  height: number
  bytes: number
}

/** PNG IHDR 尺寸解析（大端 width/height 位于字节 16-24——零依赖，纯函数可单测） */
export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  // 8 字节签名 + 4 字节 IHDR 长度 + 'IHDR' + width(4) + height(4)
  const sig = buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
  if (!sig) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 捕获剪贴板图像 → PNG（Windows only；剪贴板无图像/失败均诚实报错） */
export async function captureClipboardImage(dataDir: string): Promise<{ ok: true; image: ClipboardImage } | { ok: false; error: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, error: '剪贴板图像捕获仅支持 Windows（本产品目标平台）' }
  }
  const dir = join(dataDir, 'clipboard')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, `paste-${Date.now().toString(36)}.png`)
  // PS 脚本：无图像时 GetImage() 返回 null → 不落盘（existsSync 判定）；异常经 stderr 捕获
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    `if ($null -ne $img) { $img.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) }`,
  ].join('; ')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15_000,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (e: any) {
    return { ok: false, error: `剪贴板读取失败：${String(e?.stderr ?? e?.message ?? e).slice(0, 120)}` }
  }
  if (!existsSync(out)) return { ok: false, error: '剪贴板中没有图像（Ctrl+C 复制截图后重试）' }
  try {
    const buf = readFileSync(out)
    const dims = pngDimensions(buf)
    return {
      ok: true,
      image: {
        path: out,
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
        bytes: statSync(out).size,
      },
    }
  } catch (e: any) {
    return { ok: false, error: `落盘读取失败：${String(e?.message ?? e).slice(0, 120)}` }
  }
}
