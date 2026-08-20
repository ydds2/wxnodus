// tests/kernel-offlineModel.test.ts — 离线 token 包纯逻辑测试（不触发真实模型下载）
// 审查完善：本地 LLM 通道的模型解析/就绪探测/目录映射——下载与推理留手工验证
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createOfflineModelManifest,
  offlineModelId,
  OFFLINE_MODELS,
  isOfflineModelReady,
  runOfflineWorkerTask,
} from '../src/kernel/offlineModel.js';

const tempDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wxnodus-offline-'));
  tempDirs.push(dir);
  return dir;
}

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

  it('requires a complete hash manifest and rejects tampered model bytes', () => {
    const dataDir = tempDataDir();
    const modelDir = join(dataDir, 'models', 'onnx-community', 'Qwen2.5-1.5B-Instruct');
    mkdirSync(join(modelDir, 'onnx'), { recursive: true });
    writeFileSync(join(modelDir, 'config.json'), '{"model_type":"qwen2"}');
    writeFileSync(join(modelDir, 'tokenizer.json'), '{"version":"1.0"}');
    writeFileSync(join(modelDir, 'onnx', 'model_q4.onnx'), 'model-bytes');

    expect(isOfflineModelReady('offline:Qwen2.5-1.5B', dataDir)).toBe(false);
    expect(createOfflineModelManifest('offline:Qwen2.5-1.5B', dataDir).ok).toBe(true);
    expect(isOfflineModelReady('offline:Qwen2.5-1.5B', dataDir)).toBe(true);

    writeFileSync(join(modelDir, 'onnx', 'model_q4.onnx'), 'tampered-model-bytes');
    expect(isOfflineModelReady('offline:Qwen2.5-1.5B', dataDir)).toBe(false);
  });

  it('rejects a manifest when a required cached file is removed', () => {
    const dataDir = tempDataDir();
    const modelDir = join(dataDir, 'models', 'onnx-community', 'Qwen2.5-1.5B-Instruct');
    mkdirSync(join(modelDir, 'onnx'), { recursive: true });
    writeFileSync(join(modelDir, 'config.json'), '{}');
    writeFileSync(join(modelDir, 'tokenizer.json'), '{}');
    const onnx = join(modelDir, 'onnx', 'model_q4.onnx');
    writeFileSync(onnx, 'model-bytes');
    expect(createOfflineModelManifest('offline:Qwen2.5-1.5B', dataDir).ok).toBe(true);
    rmSync(onnx);
    expect(isOfflineModelReady('offline:Qwen2.5-1.5B', dataDir)).toBe(false);
  });
});

describe('离线 token 包：隔离 worker 生命周期', () => {
  it('awaits worker termination before resolving an aborted inference', async () => {
    class FakeWorker extends EventEmitter {
      terminated = false;
      terminate = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        this.terminated = true;
        return 1;
      });
    }
    const worker = new FakeWorker();
    const controller = new AbortController();
    const work = runOfflineWorkerTask(worker as never, {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();

    await expect(work).resolves.toMatchObject({ ok: false, error: '已中断' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(true);
  });

  it('terminates isolated work on timeout', async () => {
    vi.useFakeTimers();
    class FakeWorker extends EventEmitter {
      terminate = vi.fn(async () => 1);
    }
    const worker = new FakeWorker();
    const work = runOfflineWorkerTask(worker as never, { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    await expect(work).resolves.toMatchObject({ ok: false, error: expect.stringContaining('离线推理超时') });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
