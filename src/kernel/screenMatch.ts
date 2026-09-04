// src/kernel/screenMatch.ts — 屏幕模板匹配（2026-09-03 · P1）
// MAA 三通道识别 L0 档：已知 UI 元素定位（坐标+置信度）——归一化互相关（NCC）纯 JS 实现；
// JPEG→灰度解码复用 ffmpeg（与屏幕视频流同源——零新增依赖）。
// 诚实文化：ffmpeg 缺失/解码失败/σ≈0（纯色块无特征，NCC 无定义）均诚实返回，绝不伪造命中。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface GrayImage { w: number; h: number; data: Uint8Array }
export interface MatchHit { x: number; y: number; score: number; frameW: number; frameH: number }

/** 从 JPEG 头部解析尺寸（SOF0/1/2 段——解码前维度事实源） */
export function jpegSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]!
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue } // SOI/RST 无长度段
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

/** PNG 头部解析（签名 + IHDR 宽高——模板支持 png/jpg 双格式） */
export function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/** 图像尺寸（JPEG/PNG 双格式——解码前维度事实源） */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  return jpegSize(buf) ?? pngSize(buf)
}

/** ffmpeg 解码 JPEG → 灰度 rawvideo（maxW>0 时宽缩至 ≤maxW 保比——匹配速度档） */
export function decodeGray(jpeg: Buffer, maxW = 640): Promise<{ ok: true; img: GrayImage } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const size = imageSize(jpeg)
    if (!size) { resolve({ ok: false, error: '图像头部解析失败（需 JPEG/PNG）' }); return }
    const targetW = maxW > 0 ? Math.min(maxW, size.w) : size.w
    const targetH = Math.max(1, Math.round(size.h * targetW / size.w))
    const cmdLine = (process.env.WXNODUS_FFMPEG_CMD ?? 'ffmpeg').split(/\s+/).filter(Boolean)
    const [cmd, ...prefix] = cmdLine
    const args = [...prefix, '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      ...(targetW === size.w ? [] : ['-vf', `scale=${targetW}:${targetH}`]),
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']
    let stderrTail = ''
    let settled = false
    const c = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    c.on('error', e => {
      settled = true
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') resolve({ ok: false, error: 'ffmpeg 未安装或不在 PATH——模板匹配解码不可用' })
      else resolve({ ok: false, error: `ffmpeg 启动失败：${String(e?.message ?? e).slice(0, 200)}` })
    })
    const chunks: Buffer[] = []
    let total = 0
    c.stdout!.on('data', (d: Buffer) => { chunks.push(d); total += d.length })
    c.stderr!.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-2000) })
    c.on('close', code => {
      if (settled) return
      settled = true
      if (code !== 0) { resolve({ ok: false, error: `ffmpeg 解码失败：${stderrTail.slice(0, 200) || `exit ${code}`}` }); return }
      const raw = Buffer.concat(chunks, total)
      if (raw.length < targetW * targetH) { resolve({ ok: false, error: `解码字节不足（${raw.length}/${targetW * targetH}）` }); return }
      resolve({ ok: true, img: { w: targetW, h: targetH, data: new Uint8Array(raw.subarray(0, targetW * targetH)) } })
    })
    c.stdin!.end(jpeg)
  })
}

/** 纯 JS 归一化互相关（NCC）——积分图 O(1) 局部均值/方差 + 模板直乘；返回最佳命中或 null（低于阈值/纯色无特征） */
export function nccMatch(frame: GrayImage, template: GrayImage, opts: { threshold?: number; stride?: number } = {}): MatchHit | null {
  const threshold = opts.threshold ?? 0.8
  const stride = Math.max(1, Math.round(opts.stride ?? 2))
  const { w: fw, h: fh, data: f } = frame
  const { w: tw, h: th, data: t } = template
  if (tw < 2 || th < 2 || tw > fw || th > fh) return null
  const n = tw * th
  let tSum = 0
  for (let i = 0; i < n; i++) tSum += t[i]!
  const tMean = tSum / n
  let tVar = 0
  for (let i = 0; i < n; i++) { const d = t[i]! - tMean; tVar += d * d }
  const tSd = Math.sqrt(tVar / n)
  const sum = new Float64Array((fw + 1) * (fh + 1))
  const sq = new Float64Array((fw + 1) * (fh + 1))
  for (let y = 1; y <= fh; y++) {
    let rowSum = 0
    let rowSq = 0
    const fy = (y - 1) * fw
    const sy = y * (fw + 1)
    const py = (y - 1) * (fw + 1)
    for (let x = 1; x <= fw; x++) {
      const v = f[fy + x - 1]!
      rowSum += v
      rowSq += v * v
      sum[sy + x] = sum[py + x]! + rowSum
      sq[sy + x] = sq[py + x]! + rowSq
    }
  }
  const rect = (arr: Float64Array, x0: number, y0: number, w: number, h: number) =>
    arr[(y0 + h) * (fw + 1) + x0 + w]! - arr[y0 * (fw + 1) + x0 + w]! - arr[(y0 + h) * (fw + 1) + x0]! + arr[y0 * (fw + 1) + x0]!
  let best: MatchHit | null = null
  for (let y = 0; y <= fh - th; y += stride) {
    for (let x = 0; x <= fw - tw; x += stride) {
      const s = rect(sum, x, y, tw, th)
      const q = rect(sq, x, y, tw, th)
      const mean = s / n
      const variance = q / n - mean * mean
      const sd = variance > 0 ? Math.sqrt(variance) : 0
      // σ≈0 语义定义（NCC 0/0 情形）：模板平且窗平且均值一致 → 完全匹配=1；任一方平而另一方不平 → 负相关；
      // 双方都不平 → 标准 NCC
      const score = tSd < 1e-6
        ? (sd < 1e-6 && Math.abs(mean - tMean) < 1e-6 ? 1 : -1)
        : sd < 1e-6
          ? (Math.abs(mean - tMean) < 1e-6 ? 1 : -1)
          : (() => {
              let cross = 0
              for (let ty = 0; ty < th; ty++) {
                const fy2 = (y + ty) * fw + x
                const tty = ty * tw
                for (let tx = 0; tx < tw; tx++) cross += f[fy2 + tx]! * t[tty + tx]!
              }
              return (cross - n * mean * tMean) / (n * sd * tSd)
            })()
      if (score > (best?.score ?? -Infinity)) best = { x, y, score, frameW: fw, frameH: fh }
    }
  }
  return best && best.score >= threshold ? best : null
}

/** 一键：JPEG 帧 + 已加载模板 → 命中（帧解码 640 档 + NCC） */
export async function matchTemplate(jpeg: Buffer, template: GrayImage, opts: { threshold?: number } = {}): Promise<{ ok: true; hit: MatchHit | null } | { ok: false; error: string }> {
  const r = await decodeGray(jpeg, 640)
  if (!r.ok) return r
  return { ok: true, hit: nccMatch(r.img, template, opts) }
}

/** 加载模板文件（JPEG——不解缩放，保持模板原生分辨率） */
export async function loadTemplateFile(path: string): Promise<{ ok: true; img: GrayImage } | { ok: false; error: string }> {
  try {
    const buf = readFileSync(path)
    return await decodeGray(buf, 0)
  } catch (e) { return { ok: false, error: `模板文件读取失败：${String((e as Error)?.message ?? e).slice(0, 120)}` } }
}
