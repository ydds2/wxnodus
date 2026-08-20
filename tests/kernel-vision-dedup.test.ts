// tests/kernel-vision-dedup.test.ts — 视觉同屏去重缓存（LRU(1) + 10s TTL）
import { describe, it, expect, vi } from 'vitest';

describe('describeImageStatus 同屏去重', () => {
  it('同 target+prompt 10s 内二次调用 → cached=true 且不再走识别通道（零额外 OCR/网络）', async () => {
    const { describeImageStatus } = await import('../src/kernel/vision.js');
    const enc = null;
    const target = 'data:image/png;base64,QUJDRA==';
    // 无 key 且 visionOcr=false → 识别通道必然失败（未配置密钥）——借此验证去重短路
    const r1 = await describeImageStatus(target, enc, '描述', { visionOcr: false });
    expect(r1.ok).toBe(false);
    expect(r1.cached).toBeUndefined();
    const r2 = await describeImageStatus(target, enc, '描述', { visionOcr: false });
    expect(r2.cached).toBe(true); // 短路命中——未再次走通道
    expect(r2.ok).toBe(r1.ok);
    expect(r2.reason).toBe(r1.reason);
  });

  it('不同 prompt → 不命中缓存', async () => {
    const { describeImageStatus } = await import('../src/kernel/vision.js');
    const target = 'data:image/png;base64,QUJDRA==';
    const r1 = await describeImageStatus(target, null, '描述A', { visionOcr: false });
    const r2 = await describeImageStatus(target, null, '描述B', { visionOcr: false });
    expect(r2.cached).toBeUndefined();
  });
});
