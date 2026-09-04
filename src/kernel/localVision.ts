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
let generatorModel = ''

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
  generatorModel = ''
}

// ── L2 自研进程内调度（2026-09-04 用户裁决：不引入 Ollama 等外部推理服务——零新增进程，
//    与黑洞 embedder 同加载器 @huggingface/transformers；主档模型可配，默认 moondream2）──

export type L2BackendSetting = 'auto' | 'moondream' | 'off'

export interface L2DescribeOptions {
  backend?: L2BackendSetting
  model?: string
}

export type L2Result =
  | { ok: true; text: string; backend: 'local'; model: string }
  | { ok: false; error: string; backend: 'none' }

/** 模型目录（自研进程内——模型名 → pipeline 配置；扩展只加一行） */
const LOCAL_VLM_MODELS: Record<string, { task: string; id: string; opts: Record<string, unknown> }> = {
  moondream2: { task: 'image-text-to-text', id: 'Xenova/moondream2', opts: { dtype: 'q4', device: 'cpu' } }, // 注：需 transformers>=3.5 的该 task——当前 v4.2 无此 task，真机验证后定去留
  'florence-2': { task: 'image-to-text', id: 'onnx-community/Florence-2-base-ft', opts: { dtype: 'fp32', device: 'cpu' } },
}

export function listLocalVlmModels(): string[] {
  return Object.keys(LOCAL_VLM_MODELS)
}

/** 降级链纯决策（表驱动可测）：off→none；未知模型名→回默认主档（诚实标注） */
export function pickL2Backend(backend: L2BackendSetting, model: string | undefined): { use: 'local' | 'none'; model: string; note?: string } {
  if (backend === 'off') return { use: 'none', model: '' }
  const want = model ?? (backend === 'moondream' ? 'moondream2' : 'florence-2') // --vlm moondream = 显式选 moondream2
  if (!LOCAL_VLM_MODELS[want]) return { use: 'local', model: 'florence-2', note: `未知模型 ${want}——回默认 florence-2` }
  return { use: 'local', model: want }
}

/**
 * L2 智能描述（自研进程内唯一入口）：模型懒加载常驻（一次加载全程复用）+ 输入降采样提速
 * （模型最优宽 672——训练分辨率对齐，减 30-50% 推理耗时）；失败诚实 ok:false（调用方标「仅 OCR」）。
 */
export async function describeScreenSmart(jpeg: Buffer, opts: L2DescribeOptions = {}): Promise<L2Result> {
  const backend = opts.backend ?? 'auto'
  const pick = pickL2Backend(backend, opts.model)
  if (pick.use === 'none') return { ok: false, backend: 'none', error: `本地视觉已关闭（--vlm off）${pick.note ?? ''}` }
  const r = await describeScreen(jpeg, pick.model)
  if (r.ok) return { ok: true, text: r.text, backend: 'local', model: pick.model }
  return { ok: false, backend: 'none', error: `本地视觉不可用（${pick.model}：${r.error.slice(0, 100)}）` }
}

/** 预热（第二步提速：/watch start 时后台跑一次空推理——消除首帧 3-5s 冷启动；结果如实返回） */
export async function warmupLocalVision(model?: string): Promise<{ ok: boolean; detail: string }> {
  const pick = pickL2Backend('auto', model)
  if (pick.use === 'none') return { ok: false, detail: 'off' }
  const t0 = Date.now()
  const r = await describeScreen(ONE_PX_JPEG, pick.model)
  return r.ok
    ? { ok: true, detail: `${pick.model} 已预热常驻（${Date.now() - t0}ms——首帧零冷启动）` }
    : { ok: false, detail: `预热失败（${pick.model}：${r.error.slice(0, 80)}——首次使用将现场加载）` }
}

/** 1×1 灰 JPEG（预热输入——最小解码成本） */
const ONE_PX_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
  0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
  0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
  0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
  0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda,
  0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
])

/**
 * 本地视觉描述（懒加载常驻单例 · 多模型缓存）。返回诚实结果：
 * 模型未下载/离线/加载失败均 ok:false + 原因（绝不伪造描述）。
 */
export async function describeScreen(jpeg: Buffer, model = 'florence-2'): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    if (!generator || generatorModel !== model) {
      const t = await import('@huggingface/transformers')
      const env = (t as unknown as { env?: { cacheDir?: string; allowRemoteModels?: boolean; remoteHost?: string } }).env
      if (env) {
        if (!env.cacheDir && process.env.WXNODUS_HF_CACHE_DIR) env.cacheDir = process.env.WXNODUS_HF_CACHE_DIR
        env.allowRemoteModels = true // 首次需下载；下载后走本地缓存
        // 网络受限环境：显式镜像端点（如 https://hf-mirror.com——不设置默认官方 huggingface.co）
        if (process.env.WXNODUS_HF_ENDPOINT) env.remoteHost = process.env.WXNODUS_HF_ENDPOINT
      }
      const pipeline = (t as unknown as { pipeline(task: string, model: string, opts: Record<string, unknown>): Promise<Generator> }).pipeline
      const spec = LOCAL_VLM_MODELS[model] ?? LOCAL_VLM_MODELS['florence-2']!
      generator = await pipeline(spec.task, spec.id, spec.opts)
      generatorModel = model
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
