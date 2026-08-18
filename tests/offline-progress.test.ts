// tests/offline-progress.test.ts — 波 2 ⑪：离线拉取进度归一化（codex pull_with_reporter 对标）
import { describe, expect, it } from 'vitest'
import { normalizePipelineProgress } from '../src/kernel/offlineModel.js'

describe('normalizePipelineProgress（transformers.js progress_callback 归一化）', () => {
  it('progress 字段优先（0-100 夹取）', () => {
    expect(normalizePipelineProgress({ status: 'progress', file: 'model.onnx', progress: 37.5 }).percent).toBe(37.5)
    expect(normalizePipelineProgress({ progress: 150 }).percent).toBe(100)
    expect(normalizePipelineProgress({ progress: -5 }).percent).toBe(0)
  })

  it('无 progress → loaded/total 估算（百分比 1 位小数）', () => {
    expect(normalizePipelineProgress({ loaded: 250, total: 1000 }).percent).toBe(25)
    expect(normalizePipelineProgress({ loaded: 3333, total: 10000 }).percent).toBe(33.3)
  })

  it('缺失/空输入 → 0%（不抛异常）；file/status 透传', () => {
    expect(normalizePipelineProgress(undefined).percent).toBe(0)
    expect(normalizePipelineProgress(null).percent).toBe(0)
    const p = normalizePipelineProgress({ status: 'done', file: 'x.onnx' })
    expect(p.status).toBe('done')
    expect(p.file).toBe('x.onnx')
  })
})
