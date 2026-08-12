// tests/kernel-offlineModel.test.ts — 离线 token 包纯逻辑测试（不触发真实模型下载）
// 审查完善：本地 LLM 通道的模型解析/就绪探测/目录映射——下载与推理留手工验证
import { describe, it, expect } from 'vitest';
import { offlineModelId, OFFLINE_MODELS, isOfflineModelReady } from '../src/kernel/offlineModel.js';

describe('离线 token 包：模型解析', () => {
  it('offline: 前缀映射到 HF 模型 id', () => {
    expect(offlineModelId('offline:Qwen2.5-1.5B')).toBe('onnx-community/Qwen2.5-1.5B-Instruct');
    expect(offlineModelId('offline:Qwen2.5-3B')).toBe('onnx-community/Qwen2.5-3B-Instruct');
  });
  it('非 offline 模型返回 null（云模型不走本地通道）', () => {
    expect(offlineModelId('deepseek-chat')).toBeNull();
    expect(offlineModelId('glm-4v-flash')).toBeNull();
    expect(offlineModelId(null)).toBeNull();
    expect(offlineModelId(undefined)).toBeNull();
  });
  it('未知 offline 模型返回 null（/offline pack download 校验入口）', () => {
    expect(offlineModelId('offline:Qwen3-100B')).toBeNull();
  });
  it('目录条目含诚实边界信息（大小/速度/说明）', () => {
    for (const [k, v] of Object.entries(OFFLINE_MODELS)) {
      expect(k.startsWith('offline:')).toBe(true);
      expect(v.id).toContain('/');
      expect(v.sizeGB).toMatch(/~[\d.]+GB/);
      expect(v.speed).toContain('tok/s');
    }
  });
});

describe('离线 token 包：就绪探测', () => {
  it('未下载时探测为 false（不抛错）', () => {
    expect(isOfflineModelReady('offline:Qwen2.5-1.5B')).toBe(false);
  });
  it('非离线模型探测为 false', () => {
    expect(isOfflineModelReady('deepseek-chat')).toBe(false);
    expect(isOfflineModelReady(null)).toBe(false);
  });
});
