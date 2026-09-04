// tests/watch-local-vlm.test.ts — 自研进程内 VLM 调度契约（2026-09-04 用户裁决：零外部推理服务）
// L2 = transformers.js 进程内（模型常驻缓存）→ 失败诚实降 L2c（仅 OCR）。
// 决策面表驱动 + off 零打扰 + 模型目录扩展性（moondream2/florence-2）。
import { describe, it, expect } from 'vitest';

describe('pickL2Backend 纯决策（自研降级链——离线锁死）', () => {
  it('off → none；默认/未知模型 → moondream2（未知回默认+诚实标注）', async () => {
    const { pickL2Backend } = await import('../src/kernel/localVision.js');
    expect(pickL2Backend('off', undefined)).toEqual({ use: 'none', model: '' });
    expect(pickL2Backend('auto', undefined)).toEqual({ use: 'local', model: 'florence-2' });
    expect(pickL2Backend('moondream', undefined)).toEqual({ use: 'local', model: 'moondream2' });
    const unknown = pickL2Backend('auto', 'gpt-5-vision');
    expect(unknown.use).toBe('local');
    expect(unknown.model).toBe('florence-2');
    expect(unknown.note).toContain('未知模型');
  });

  it('模型目录可扩展（florence-2 在列）且 describeScreenSmart off 零推理', async () => {
    const lv = await import('../src/kernel/localVision.js');
    expect(lv.listLocalVlmModels()).toContain('moondream2');
    expect(lv.listLocalVlmModels()).toContain('florence-2');
    const r = await lv.describeScreenSmart(Buffer.from('x'), { backend: 'off' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.backend).toBe('none'); expect(r.error).toContain('已关闭'); }
  });
});
