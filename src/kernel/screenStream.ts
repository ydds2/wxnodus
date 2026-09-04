// src/kernel/screenStream.ts — 常驻屏幕视频流（2026-09-03 · P0）
// 方案 docs/screenwatch-localvlm-modpack-plan-2026-09-03.md 的第一里程碑：
//   ffmpeg gdigrab → MJPEG stdout 管道（帧环缓冲——连续录制，瞬时事件不漏）
//   stderr 场景元数据（lavfi.scene_score——场景切换检测，ffmpeg 端完成，Node 零像素解码）
//   clip()：环缓冲切出最近 N 秒 → ffmpeg 重封装 mp4 证据（sha256 绑定）
// 诚实文化：ffmpeg 缺失 → { ok:false, code:'FFMPEG_MISSING' }，绝不把轮询冒充视频流；
//           gdigrab 抓不到安全窗口/DRM（黑屏）——启动时明示。
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ScreenStreamOptions {
  /** 捕捉帧率（默认 5；分析级——实时流） */
  fps?: number
  /** 环缓冲时长秒（默认 60） */
  ringSeconds?: number
  /** gdigrab 输入（默认 desktop 主屏；多屏用 -list_devices 查名字） */
  monitor?: string
  /** 捕捉后端（P2.2）：ddagrab（Desktop Duplication API——WGC 同层，低开销，可抓 UWP；Win10 1903+）
   *  | gdigrab（GDI——兼容面最广，抓不到安全窗口/DRM）| auto（默认：ddagrab 失败自动回落 gdigrab） */
  backend?: 'ddagrab' | 'gdigrab' | 'auto'
  /** ffmpeg 可执行路径（默认 PATH 解析；测试注入假 ffmpeg） */
  ffmpegPath?: string
  /** 事件回调（frame/segment/clip） */
  onEvent?: (ev: ScreenWatchEvent) => void
  /** 工作目录（keyframes/clips 落盘） */
  workDir?: string
}

export type ScreenWatchEvent =
  | { kind: 'frame'; at: number; bytes: number }
  | { kind: 'segment'; at: number; sceneScore: number }
  | { kind: 'clip'; file: string; sha256: string; frames: number; seconds: number }

export interface ScreenStreamStatus {
  running: boolean
  fps: number
  ringSeconds: number
  ringFrames: number
  segments: number
  monitor: string
  /** 实际生效的捕捉后端（auto 回落后如实呈现——诚实文化） */
  backend: 'ddagrab' | 'gdigrab'
}

interface RingFrame { at: number; buf: Buffer }

/** 从 MJPEG 字节流切出完整 JPEG 帧（FFD8…FFD9）；返回帧数组与剩余未完成字节 */
function cutJpegFrames(chunk: Buffer, pending: Buffer): { frames: Buffer[]; rest: Buffer } {
  let data = pending.length ? Buffer.concat([pending, chunk]) : chunk
  const frames: Buffer[] = []
  for (;;) {
    const start = data.indexOf(Buffer.from([0xff, 0xd8]))
    const end = start >= 0 ? data.indexOf(Buffer.from([0xff, 0xd9]), start + 2) : -1
    if (start < 0 || end < 0) {
      // 无完整帧：保留尾部（防 20MB 无界——异常流丢弃）
      return { frames, rest: data.length > 20 * 1024 * 1024 ? Buffer.alloc(0) : data }
    }
    frames.push(data.subarray(start, end + 2))
    data = data.subarray(end + 2)
  }
}

export interface ScreenStream {
  start(): Promise<{ ok: true } | { ok: false; code: string; error: string }>
  stop(): Promise<void>
  status(): ScreenStreamStatus
  /** 环缓冲最新关键帧（分段 OCR/识别的采样源） */
  keyframe(): { at: number; buf: Buffer } | null
  clip(seconds: number): Promise<{ ok: true; file: string; sha256: string; frames: number; seconds: number } | { ok: false; error: string }>
}

export function createScreenStream(opts: ScreenStreamOptions = {}): ScreenStream {
  const fps = Math.min(10, Math.max(1, Math.round(opts.fps ?? 5)))
  const ringSeconds = Math.min(300, Math.max(5, Math.round(opts.ringSeconds ?? 60)))
  const monitor = opts.monitor ?? 'desktop'
  // ffmpeg 命令解析：显式路径 > WXNODUS_FFMPEG_CMD 环境（测试/自定义安装注入）> PATH
  const cmdLine = (opts.ffmpegPath ?? process.env.WXNODUS_FFMPEG_CMD ?? 'ffmpeg').split(/\s+/).filter(Boolean)
  const [ffCmd, ...ffPrefix] = cmdLine
  const workDir = opts.workDir ?? join(process.cwd(), 'data', 'watch')

  let child: ChildProcess | null = null
  let running = false
  let pending: Buffer = Buffer.alloc(0)
  const ring: RingFrame[] = []
  let segments = 0
  let lastSegmentAt = 0
  let activeBackend: 'ddagrab' | 'gdigrab' = 'gdigrab'
  const wantBackend = opts.backend ?? 'auto'

  const emit = (ev: ScreenWatchEvent) => { try { opts.onEvent?.(ev) } catch { /* 回调异常不打断流 */ } }

  const pushFrame = (buf: Buffer) => {
    const now = Date.now()
    ring.push({ at: now, buf })
    // 环缓冲淘汰：超时或超量（fps×ringSeconds + 1/4 裕量）
    const cutoff = now - ringSeconds * 1000
    while (ring.length && (ring[0]!.at < cutoff || ring.length > Math.ceil(fps * ringSeconds * 1.25))) ring.shift()
    emit({ kind: 'frame', at: now, bytes: buf.length })
  }

  return {
    start() {
      const attempt = (backend: 'ddagrab' | 'gdigrab'): Promise<{ ok: true } | { ok: false; code: string; error: string }> => new Promise(resolve => {
        try { mkdirSync(join(workDir, 'keyframes'), { recursive: true }); mkdirSync(join(workDir, 'clips'), { recursive: true }) } catch { /* 目录失败不阻断流（clip 时再报） */ }
        // 后端输入（P2.2）：ddagrab=Desktop Duplication API（WGC 同层，低开销，可抓 UWP；Win10 1903+）
        // ｜ gdigrab=GDI（兼容面最广，抓不到安全窗口/DRM）
        const inputArgs = backend === 'ddagrab'
          ? ['-f', 'lavfi', '-framerate', String(fps), '-i', `ddagrab=draw_mouse=1,framerate=${fps}`]
          : ['-f', 'gdigrab', '-framerate', String(fps), '-i', monitor]
        // split 滤镜双输出：a→MJPEG 管道（环缓冲）；b→select scene 检测→metadata=print（stderr 元数据）。
        // 多输出标签必须用 -filter_complex（-vf 不产生可 -map 的标签）；spawn 无 shell——
        // filter 内逗号反斜杠转义（select=gt(scene\,0.2)）；select 链输出打 [sc] 标签供 -map。
        const args = [
          '-hide_banner', '-loglevel', 'info',
          ...inputArgs,
          '-filter_complex', `scale=1280:-2,split[a][b];[a]fps=${fps}[mj];[b]select=gt(scene\\,0.2),metadata=print[sc]`,
          '-map', '[mj]', '-f', 'mjpeg', '-q:v', '6', 'pipe:1',
          '-map', '[sc]', '-f', 'null', 'NUL',
        ]
        let stderrTail = ''
        let settled = false
        const settle = (r: { ok: true } | { ok: false; code: string; error: string }) => {
          if (settled) return
          settled = true
          running = r.ok
          if (r.ok) activeBackend = backend
          else { try { child?.kill() } catch { /* 失败尝试回收子进程 */ } }
          resolve(r)
        }
        const c = spawn(ffCmd, [...ffPrefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        child = c
        c.on('error', (e: NodeJS.ErrnoException) => {
          running = false
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            settle({ ok: false, code: 'FFMPEG_MISSING', error: 'ffmpeg 未安装或不在 PATH——视频捕捉不可用（winget install ffmpeg 或 /eco 查依赖）。绝不把轮询帧冒充视频流' })
          } else {
            settle({ ok: false, code: 'FFMPEG_SPAWN_FAILED', error: `ffmpeg 启动失败：${String(e?.message ?? e).slice(0, 200)}` })
          }
        })
        c.stderr!.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stderrTail = (stderrTail + text).slice(-2000)
          // 场景切换元数据（ffmpeg select+metadata=print 输出到 stderr）
          for (const m of text.matchAll(/lavfi\.scene_score=([\d.]+)/g)) {
            const score = Number(m[1])
            const now = Date.now()
            if (!Number.isFinite(score) || now - lastSegmentAt < 2000) continue // 突发节流（2s 最小段间隔）
            lastSegmentAt = now
            segments++
            emit({ kind: 'segment', at: now, sceneScore: score })
          }
        })
        c.stdout!.on('data', (chunk: Buffer) => {
          const { frames, rest } = cutJpegFrames(chunk, pending)
          pending = rest
          for (const f of frames) pushFrame(f)
          if (!settled && frames.length > 0) settle({ ok: true }) // 收到真实 MJPEG 帧才算启动成功
        })
        c.on('close', () => {
          running = false
          child = null
          if (!settled) settle({ ok: false, code: 'FFMPEG_EXITED', error: `ffmpeg（${backend}）未产出视频流即退出：${stderrTail.slice(-300) || '（无 stderr 输出）'}` })
        })
        // 兜底：10s 仍未收到帧 → 诚实失败（黑屏/权限异常等场景不留假运行态）
        const bootTimer = setTimeout(() => {
          if (!settled) settle({ ok: false, code: 'FFMPEG_NO_FRAMES', error: `10s 未收到 MJPEG 视频帧（${backend}）：${stderrTail.slice(-300) || '（无 stderr 输出——捕捉可能被拒绝或显示器不可用）'}` })
        }, 10_000)
        void bootTimer
      })

      // 后端解析（P2.2）：auto = ddagrab 优先、失败诚实回落 gdigrab；显式指定失败即报（不静默换后端）
      const startNow = async (): Promise<{ ok: true } | { ok: false; code: string; error: string }> => {
        if (running) return { ok: true }
        const order: Array<'ddagrab' | 'gdigrab'> = wantBackend === 'auto' ? ['ddagrab', 'gdigrab'] : [wantBackend]
        let lastErr = ''
        for (const backend of order) {
          const r = await attempt(backend)
          if (r.ok) return r
          lastErr = r.error
          if (wantBackend !== 'auto') return r
        }
        return { ok: false, code: 'FFMPEG_ALL_BACKENDS_FAILED', error: `ddagrab 与 gdigrab 均失败：${lastErr.slice(0, 200)}` }
      }
      return startNow()
    },
    async stop() {
      running = false
      if (child && !child.killed) {
        try { child.kill() } catch { /* 已退出 */ }
        child = null
      }
    },
    status() {
      return { running, fps, ringSeconds, ringFrames: ring.length, segments, monitor, backend: activeBackend }
    },
    keyframe() {
      return ring.length ? ring[ring.length - 1]! : null
    },
    clip(seconds: number) {
      return new Promise(resolve => {
        const span = Math.min(seconds, ringSeconds)
        const cutoff = Date.now() - span * 1000
        const frames = ring.filter(f => f.at >= cutoff)
        if (!frames.length) { resolve({ ok: false, error: `环缓冲无最近 ${span}s 帧（先 /watch start）` }); return }
        const outFile = join(workDir, 'clips', `watch-${new Date().toISOString().replace(/[:.]/g, '-')}-${span}s.mp4`)
        const mux = spawn(ffCmd, [...ffPrefix, '-hide_banner', '-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', outFile], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
        let muxErr = ''
        mux.stderr!.on('data', (c: Buffer) => { muxErr = (muxErr + c.toString('utf8')).slice(-2000) })
        mux.on('error', () => resolve({ ok: false, error: 'ffmpeg 重封装进程启动失败' }))
        mux.on('close', code => {
          if (code !== 0) { resolve({ ok: false, error: `mp4 重封装失败：${muxErr.slice(0, 200) || `exit ${code}`}` }); return }
          try {
            const sha256 = createHash('sha256').update(readFileSync(outFile)).digest('hex')
            emit({ kind: 'clip', file: outFile, sha256, frames: frames.length, seconds: span })
            resolve({ ok: true, file: outFile, sha256, frames: frames.length, seconds: span })
          } catch (e) { resolve({ ok: false, error: `证据文件读取失败：${String((e as Error)?.message ?? e).slice(0, 120)}` }) }
        })
        for (const f of frames) mux.stdin!.write(f.buf)
        mux.stdin!.end()
      })
    },
  }
}
