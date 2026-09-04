// src/kernel/localVision.ts — 本地多模态视觉（2026-09-03 · P2.1）
// 方案 docs/screenwatch-localvlm-modpack-plan-2026-09-03.md 方案 B 推荐档：
//   moondream2（Xenova/transformers.js）本机推理——Node 进程内 CPU，数据不出机。
// 懒加载单例：首次 describeScreen 才下载/加载模型（~1GB q4）；失败诚实报原因（离线/未缓存/加载失败）。
// 与黑洞 embedder 同加载器（@huggingface/transformers 已在依赖树）——零新增服务进程。
import { join } from 'node:path'

export interface LocalVisionProbe { loaded: boolean; detail: string }

type Generator = (input: unknown, opts?: Record<string, unknown>) => Promise<Array<{ generated_text: string }>>

let loaded = false
let loadError: string | null = null
let generator: Generator | null = null

/** 缓存目录指定（/watch 经 ctx.dataDir 注入——模型资产归 dataDir 管辖，气隙机可预置） */
export function setLocalVisionCacheDir(dir: string): void {
  process.env.WXNODUS_HF_CACHE_DIR = join(dir, 'models', 'hf')
}

export function probeLocalVision(): LocalVisionProbe {
  if (loaded) return { loaded: true, detail: 'moondream2 已加载（本机 CPU 推理——数据不出机）' }
  if (loadError) return { loaded: false, detail: `加载失败：${loadError}` }
  return { loaded: false, detail: '未加载（首次 --tier l2 将下载/加载 moondream2 ~1GB q4——本地模型；气隙机可预置缓存）' }
}

/** 测试隔离：复位懒加载单例（进程内模块态——测试首尾调用） */
export function resetLocalVision(): void {
  loaded = false
  loadError = null
  generator = null
}

// ── L2 后端决策（2026-09-04 · 本地 VLM 部署方案 §4.1）：降级链 L2a(Ollama GPU) → L2b(moondream CPU) → L2c(仅 OCR) ──

export type L2BackendSetting = 'auto' | 'ollama' | 'moondream' | 'off'

export interface L2DescribeOptions {
  backend?: L2BackendSetting
  ollamaUrl?: string
  ollamaModel?: string
}

export type L2Result =
  | { ok: true; text: string; backend: 'ollama' | 'moondream'; model?: string }
  | { ok: false; error: string; backend: 'none' }

/**
 * 降级链纯决策（可表驱动测试）：off→none；显式 ollama→探活定 ollama/none；
 * auto→探活过走 ollama，否则 moondream。生成期失败（模型未拉取等）由 describeScreenSmart 再降级。
 */
export function pickL2Backend(backend: L2BackendSetting, ollamaReachable: boolean): 'ollama' | 'moondream' | 'none' {
  if (backend === 'off') return 'none'
  if (backend === 'moondream') return 'moondream'
  if (backend === 'ollama') return ollamaReachable ? 'ollama' : 'none'
  return ollamaReachable ? 'ollama' : 'moondream' // auto
}

/**
 * L2 智能描述（降级链唯一入口）：
 * auto → Ollama 探活通过走 L2a；失败落 L2b（moondream2 进程内）；再失败 L2c（ok:false——调用方标注「仅 OCR」）。
 * 每级切换的原因都在返回/错误里——绝不静默假装理解屏幕。
 */
export async function describeScreenSmart(jpeg: Buffer, opts: L2DescribeOptions = {}): Promise<L2Result> {
  const backend = opts.backend ?? 'auto'
  if (backend === 'off') return { ok: false, backend: 'none', error: '本地视觉已关闭（--vlm off）' }
  // L2a：Ollama（探活 + 生成）
  if (backend === 'ollama' || backend === 'auto') {
    const { probeOllamaVision, describeScreenOllama } = await import('./ollamaVision.js')
    const probe = await probeOllamaVision(opts.ollamaUrl)
    const picked = pickL2Backend(backend, probe.ok)
    if (picked === 'ollama') {
      const r = await describeScreenOllama(jpeg, { url: opts.ollamaUrl, model: opts.ollamaModel })
      if (r.ok) return { ok: true, text: r.text, backend: 'ollama', model: r.model }
      // auto 模式下 Ollama 在线但生成失败（模型未拉取等）→ 继续降级并如实携带原因；显式 ollama 直报
      if (backend === 'ollama') return { ok: false, backend: 'none', error: `L2a 失败：${r.error}` }
    } else if (backend === 'ollama') {
      return { ok: false, backend: 'none', error: `L2a 失败：${probe.detail}` }
    }
  }
  // L2b：moondream2（进程内）
  const r = await describeScreen(jpeg)
  if (r.ok) return { ok: true, text: r.text, backend: 'moondream', model: 'moondream2' }
  return { ok: false, backend: 'none', error: `本地视觉不可用（L2a/L2b 均失败——最后原因：${r.error.slice(0, 100)}）` }
}

/**
 * 本地视觉描述（懒加载单例）。返回诚实结果：模型未下载/离线/加载失败均 ok:false + 原因。
 */
export async function describeScreen(jpeg: Buffer): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    if (!generator) {
      const t = await import('@huggingface/transformers')
      const env = (t as unknown as { env?: { cacheDir?: string; allowRemoteModels?: boolean; remoteHost?: string } }).env
      if (env) {
        if (!env.cacheDir && process.env.WXNODUS_HF_CACHE_DIR) env.cacheDir = process.env.WXNODUS_HF_CACHE_DIR
        env.allowRemoteModels = true // 首次需下载；下载后走本地缓存
        // 网络受限环境：显式镜像端点（如 https://hf-mirror.com——不设置默认官方 huggingface.co）
        if (process.env.WXNODUS_HF_ENDPOINT) env.remoteHost = process.env.WXNODUS_HF_ENDPOINT
      }
      const pipeline = (t as unknown as { pipeline(task: string, model: string, opts: Record<string, unknown>): Promise<Generator> }).pipeline
      generator = await pipeline('image-to-text', 'Xenova/moondream2', { dtype: 'q4', device: 'cpu' })
      loaded = true
    }
    const { RawImage } = await import('@huggingface/transformers') as unknown as { RawImage: { fromBlob(b: Blob): Promise<unknown> } }
    const img = await RawImage.fromBlob(new Blob([jpeg]))
    const out = await generator(img, { max_new_tokens: 60 })
    const text = String(out?.[0]?.generated_text ?? '').trim()
    return text ? { ok: true, text } : { ok: false, error: '模型输出为空（诚实——不伪造描述）' }
  } catch (e) {
    loadError = String((e as Error)?.message ?? e).slice(0, 200)
    return { ok: false, error: loadError }
  }
}
