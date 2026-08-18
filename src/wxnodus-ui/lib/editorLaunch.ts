// src/wxnodus-ui/lib/editorLaunch.ts — 外部编辑器往返（② 波 1）
// kimi editor.py:18-50 探测链（$VISUAL → $EDITOR → code --wait → 系统默认）+ crush
// ui.go:3688-3725 临时文件往返。纯函数/可单测：resolveEditorCommand 只做探测；
// runExternalEditor 做写临时文件 → 阻塞等待编辑器退出 → 读回（失败保草稿诚实返回）。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface EditorEnv {
  VISUAL?: string
  EDITOR?: string
  platform?: NodeJS.Platform
}

/** 探测链（kimi editor.py:18-50 同款）：$VISUAL → $EDITOR → 系统默认
 *  （win32 code --wait / 其余 vi——code 未安装由 runExternalEditor 降级链兜底 notepad）。
 *  命令串按空白切分（引号含空格场景由调用方直接传 command 数组覆盖） */
export function resolveEditorCommand(env: EditorEnv = process.env): string[] {
  for (const key of ['VISUAL', 'EDITOR'] as const) {
    const raw = env[key]
    if (raw && raw.trim()) return raw.trim().split(/\s+/)
  }
  return env.platform === 'win32' ? ['code', '--wait'] : ['vi']
}

export type EditorResult = { ok: true; text: string } | { ok: false; error: string }

export interface ExternalEditorOpts {
  /** 首候选命令（argv 数组，如 ['code','--wait']） */
  command: string[]
  /** ENOENT 时的降级候选（如 [['notepad']]）；全部失败 → ok:false */
  fallback?: string[][]
  /** 当前草稿（写入临时文件的初始内容） */
  text: string
  /** 临时文件扩展名（默认 .md） */
  ext?: string
}

/** 临时文件往返：写草稿 → 阻塞等编辑器退出（最长 10 分钟）→ 读回（CRLF 归一）。
 *  编辑器不存在（ENOENT）自动走降级链；全部失败诚实返回 error（调用方保留草稿）。 */
export function runExternalEditor(opts: ExternalEditorOpts): EditorResult {
  const dir = mkdtempSync(join(tmpdir(), 'wxn-editor-'))
  const file = join(dir, `draft-${Date.now().toString(36)}${opts.ext ?? '.md'}`)
  try {
    writeFileSync(file, opts.text, 'utf8')
    const candidates = [opts.command, ...(opts.fallback ?? [])]
    let lastError = ''
    for (const cmd of candidates) {
      if (!cmd.length) continue
      const r = spawnSync(cmd[0]!, [...cmd.slice(1), file], { stdio: 'inherit', timeout: 600_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
      if (r.error) {
        lastError = String(r.error?.message ?? r.error)
        if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') continue // 编辑器未安装 → 降级链
        return { ok: false, error: `编辑器启动失败：${lastError}` }
      }
      if (r.signal) return { ok: false, error: `编辑器超时被终止（${r.signal}）——草稿未变` }
      const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      return { ok: true, text }
    }
    return { ok: false, error: `未找到可用编辑器（尝试了 ${candidates.map(c => c[0]).join(' → ')}）——设置 $VISUAL/$EDITOR 或安装 VS Code` }
  } catch (e: any) {
    return { ok: false, error: `编辑器往返失败：${String(e?.message ?? e).slice(0, 120)}` }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
  }
}
