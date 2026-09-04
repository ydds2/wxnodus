// tests/local-vision.test.ts — 本地多模态视觉档（2026-09-03 · P2.1）契约
// 锁定：懒加载单例（probe 未加载→加载成功→失败诚实）；输出契约（ok:true text / ok:false error）；
// 缓存目录注入（WXNODUS_HF_CACHE_DIR）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const pipelineMock = vi.fn()
vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: undefined, allowRemoteModels: false },
  pipeline: (...args: unknown[]) => pipelineMock(...args),
  RawImage: { fromBlob: async () => ({}) },
}))

import { probeLocalVision, describeScreen, setLocalVisionCacheDir, resetLocalVision } from '../src/kernel/localVision.js'

beforeEach(() => {
  pipelineMock.mockReset()
  delete process.env.WXNODUS_HF_CACHE_DIR
  resetLocalVision() // 懒加载单例跨测试复位（进程内模块态）
})

describe('localVision（moondream2 本地视觉档）', () => {
  it('probe：未加载 → 诚实预告（首次使用将下载）；加载成功 → loaded', async () => {
    const p0 = probeLocalVision()
    expect(p0.loaded).toBe(false)
    expect(p0.detail).toContain('未加载')
    pipelineMock.mockResolvedValue(async () => [{ generated_text: '这是一个代码编辑器界面' }])
    const r = await describeScreen(Buffer.from('fake-jpeg'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toContain('编辑器')
    const p1 = probeLocalVision()
    expect(p1.loaded).toBe(true)
    expect(pipelineMock).toHaveBeenCalledWith('image-to-text', 'Xenova/moondream2', expect.objectContaining({ device: 'cpu' }))
  })

  it('加载失败 → ok:false + 原因入 probe（绝不伪造描述）', async () => {
    pipelineMock.mockRejectedValue(new Error('OFFLINE: 模型未缓存且无网络'))
    const r = await describeScreen(Buffer.from('fake-jpeg'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('OFFLINE')
    const p = probeLocalVision()
    expect(p.loaded).toBe(false)
    expect(p.detail).toContain('加载失败')
  })

  it('缓存目录注入：setLocalVisionCacheDir → 环境变量（模型资产归 dataDir 管辖）', () => {
    setLocalVisionCacheDir('C:/data')
    expect(process.env.WXNODUS_HF_CACHE_DIR).toContain('data')
    expect(process.env.WXNODUS_HF_CACHE_DIR).toContain('models')
    expect(process.env.WXNODUS_HF_CACHE_DIR).toContain('hf')
  })

  it('镜像端点：WXNODUS_HF_ENDPOINT → transformers env.remoteHost（网络受限环境如 hf-mirror）', async () => {
    process.env.WXNODUS_HF_ENDPOINT = 'https://hf-mirror.com'
    pipelineMock.mockResolvedValue(async () => [{ generated_text: 'ok' }])
    await describeScreen(Buffer.from('fake'))
    const t = await import('@huggingface/transformers')
    expect((t as unknown as { env: { remoteHost?: string } }).env.remoteHost).toBe('https://hf-mirror.com')
    delete process.env.WXNODUS_HF_ENDPOINT
  })
})
