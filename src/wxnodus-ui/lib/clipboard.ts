import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const execFileAsync = promisify(execFile)
const CLIPBOARD_MAX_BUFFER = 4 * 1024 * 1024
// A1 修复：读路径同样走 base64（写路径已修）——PowerShell 输出按系统 ANSI 代码页
// （CP936）解码会损坏中文/emoji；base64 输出 + UTF-8 解码彻底规避代码页变量
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))'] as const

type ClipboardRun = typeof execFileAsync

export function isUsableClipboardText(text: null | string): text is string {
  if (!text || !/[^\s]/.test(text)) {
    return false
  }

  if (text.includes('\u0000')) {
    return false
  }

  let suspicious = 0

  for (const ch of text) {
    const code = ch.charCodeAt(0)
    const isControl = code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t'

    if (isControl || ch === '\ufffd') {
      suspicious += 1
    }
  }

  return suspicious <= Math.max(2, Math.floor(text.length * 0.02))
}

function readClipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): Array<{ args: readonly string[]; cmd: string }> {
  if (platform === 'darwin') {
    return [{ cmd: 'pbpaste', args: [] }]
  }

  if (platform === 'win32') {
    return [{ cmd: 'powershell', args: POWERSHELL_ARGS }]
  }

  const attempts: Array<{ args: readonly string[]; cmd: string }> = []

  if (env.WSL_INTEROP || env.WSL_DISTRO_NAME) {
    attempts.push({ cmd: 'powershell.exe', args: POWERSHELL_ARGS })
  }

  if (env.WAYLAND_DISPLAY) {
    attempts.push({ cmd: 'wl-paste', args: ['--type', 'text'] })
  }

  attempts.push({ cmd: 'xclip', args: ['-selection', 'clipboard', '-out'] })

  return attempts
}

/**
 * Read plain text from the system clipboard.
 *
 * Uses native platform tools in fallback order:
 * - macOS: pbpaste
 * - Windows: PowerShell Get-Clipboard -Raw
 * - WSL: powershell.exe Get-Clipboard -Raw
 * - Linux Wayland: wl-paste --type text
 * - Linux X11: xclip -selection clipboard -out
 */
export async function readClipboardText(
  platform: NodeJS.Platform = process.platform,
  run: ClipboardRun = execFileAsync,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  for (const attempt of readClipboardCommands(platform, env)) {
    try {
      const result = await run(attempt.cmd, [...attempt.args], {
        encoding: 'utf8',
        maxBuffer: CLIPBOARD_MAX_BUFFER,
        windowsHide: true
      })

      if (typeof result.stdout === 'string') {
        // PowerShell 后端输出 base64（见 POWERSHELL_ARGS）——解码回 UTF-8
        if (attempt.cmd === 'powershell' || attempt.cmd === 'powershell.exe') {
          try {
            return Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
          } catch {
            return null
          }
        }
        return result.stdout
      }
    } catch {
      // Fall through to the next clipboard backend.
    }
  }

  return null
}

// PowerShell on Windows/WSL decodes piped stdin with the system ANSI code
// page (e.g. CP936), not UTF-8, so $input-based writes mangle CJK/emoji. We
// instead base64-encode the UTF-8 bytes and pass them as a -Command argument,
// decoding with UTF8.GetString — this removes the stdin-encoding variable
// entirely (also immune to BOM injection on redirect). PowerShell entries set
// stdin=false; every other backend reads UTF-8 stdin natively.
type WriteCmd = { args: readonly string[]; cmd: string; stdin: boolean }

function _powershellWriteScript(b64: string): string {
  return `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))`
}

function writeClipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): WriteCmd[] {
  if (platform === 'darwin') {
    return [{ cmd: 'pbcopy', args: [], stdin: true }]
  }

  if (platform === 'win32') {
    return [{ cmd: 'powershell', args: ['-NoProfile', '-NonInteractive'], stdin: false }]
  }

  const attempts: WriteCmd[] = []

  if (env.WSL_INTEROP || env.WSL_DISTRO_NAME) {
    attempts.push({ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive'], stdin: false })
  }

  if (env.WAYLAND_DISPLAY) {
    attempts.push({ cmd: 'wl-copy', args: ['--type', 'text/plain'], stdin: true })
  }

  attempts.push({ cmd: 'xclip', args: ['-selection', 'clipboard', '-in'], stdin: true })
  attempts.push({ cmd: 'xsel', args: ['--clipboard', '--input'], stdin: true })

  return attempts
}

/**
 * Write plain text to the system clipboard.
 *
 * Tries native platform tools in fallback order:
 * - macOS: pbcopy
 * - Windows: PowerShell Set-Clipboard
 * - WSL: powershell.exe Set-Clipboard
 * - Linux Wayland: wl-copy --type text/plain
 * - Linux X11: xclip -selection clipboard -in
 * - Linux X11 alt: xsel --clipboard --input
 *
 * Returns true if at least one backend succeeded, false otherwise
 * (callers should fall back to OSC52 on false).
 */

// ── P3：剪贴板图片读取（粘贴截图链路）────────────────────
// Windows: Get-Clipboard -Format Image → System.Drawing 存 PNG
// Linux X11: xclip -t image/png -o；Wayland: wl-paste
// 成功返回保存的 PNG 路径，无图片/失败返回 null
export async function readClipboardImage(outDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const ts = Date.now()
  const target = join(outDir, `clip-${ts}.png`)
  if (process.platform === 'win32') {
    // 单引号包裹路径防空格；路径内单引号翻倍转义（Windows 罕见但安全）
    const safe = target.replace(/'/g, `''`)
    const script = `Add-Type -AssemblyName System.Drawing; $img = Get-Clipboard -Format Image -ErrorAction SilentlyContinue; if ($img) { $img.Save('${safe}', [System.Drawing.Imaging.ImageFormat]::Png); 'SAVED' } else { 'NONE' }`
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true })
      return String(stdout ?? '').trim() === 'SAVED' ? target : null
    } catch {
      return null
    }
  }
  // Linux：xclip 优先，wl-paste 兜底
  const attempts: Array<{ cmd: string; args: string[] }> = []
  if (env.WAYLAND_DISPLAY) attempts.push({ cmd: 'wl-paste', args: ['--type', 'image/png'] })
  attempts.push({ cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] })
  for (const a of attempts) {
    try {
      const { stdout } = await execFileAsync(a.cmd, a.args, { encoding: 'buffer', timeout: 5000 })
      const buf = stdout as Buffer
      if (buf && buf.length > 16) {
        writeFileSync(target, buf)
        return target
      }
    } catch { /* 尝试下一个后端 */ }
  }
  return null
}

export async function writeClipboardText(
  text: string,
  platform: NodeJS.Platform = process.platform,
  start: typeof spawn = spawn,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const candidates = writeClipboardCommands(platform, env)

  for (const cmdEntry of candidates) {
    try {
      const ok = await new Promise<boolean>(resolve => {
        if (cmdEntry.stdin) {
          const child = start(cmdEntry.cmd, [...cmdEntry.args], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
          child.once('error', () => resolve(false))
          child.once('close', (code: number | null) => resolve(code === 0))
          child.stdin?.end(text)
        } else {
          const b64 = Buffer.from(text, 'utf8').toString('base64')
          const script = _powershellWriteScript(b64)
          const child = start(cmdEntry.cmd, [...cmdEntry.args, '-Command', script], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
          child.once('error', () => resolve(false))
          child.once('close', (code: number | null) => resolve(code === 0))
        }
      })

      if (ok) {
        return true
      }
    } catch {
      // Fall through to the next clipboard backend.
    }
  }

  return false
}
