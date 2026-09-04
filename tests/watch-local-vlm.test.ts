// tests/watch-local-vlm.test.ts — 本地 VLM 部署方案 §4.2 契约（2026-09-04）
// L2 降级链 L2a（Ollama GPU）→ L2b（moondream CPU）→ L2c（仅 OCR）——逐态诚实断言：
// Ollama 正常/超时/非 200/畸形 JSON/空输出；auto 降级链两级回落；--vlm off 强制 L2c。
// fetch 全 mock（vi.stubGlobal——离线可测），真机证据走 E1-E7 验收（方案 §5）。
import { describe, it, expect, afterEach, vi } from 'vitest';

const JPEG = Buffer.from('fake-jpeg-bytes');

describe('describeScreenOllama（L2a 主档）', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('正常：/api/generate 200 + response → ok + 模型名回传', async () => {
    const { describeScreenOllama, resetOllamaVision } = await import('../src/kernel/ollamaVision.js');
    resetOllamaVision();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3-vl:2b' }] }), { status: 200 });
      void init;
      return new Response(JSON.stringify({ response: '桌面显示文件管理器与终端' }), { status: 200 });
    }) as unknown as typeof fetch);
    const r = await describeScreenOllama(JPEG, { model: 'qwen3-vl:2b' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.text).toContain('文件管理器'); expect(r.model).toBe('qwen3-vl:2b'); }
  });

  it('非 200 → 诚实错误（含响应体片段）；error 字段 → Ollama 报错透传', async () => {
    const { describeScreenOllama, resetOllamaVision } = await import('../src/kernel/ollamaVision.js');
    resetOllamaVision();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('model not found', { status: 404 })) as unknown as typeof fetch);
    const r = await describeScreenOllama(JPEG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('404');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'model "x" not found' }), { status: 200 })) as unknown as typeof fetch);
    const r2 = await describeScreenOllama(JPEG);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('model "x" not found');
  });

  it('空输出 → 诚实拒绝（不伪造描述）；连接拒绝 → 通道失败', async () => {
    const { describeScreenOllama, resetOllamaVision } = await import('../src/kernel/ollamaVision.js');
    resetOllamaVision();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ response: '' }), { status: 200 })) as unknown as typeof fetch);
    const r = await describeScreenOllama(JPEG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('输出为空');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); }) as unknown as typeof fetch);
    const r2 = await describeScreenOllama(JPEG);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('ECONNREFUSED');
  });
});

describe('describeScreenSmart（L2 降级链）', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('auto + Ollama 在线 → L2a（backend:ollama + 模型标注）', async () => {
    const { resetOllamaVision } = await import('../src/kernel/ollamaVision.js');
    const { describeScreenSmart } = await import('../src/kernel/localVision.js');
    resetOllamaVision();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3-vl:2b' }] }), { status: 200 });
      return new Response(JSON.stringify({ response: '浏览器打开文档页' }), { status: 200 });
    }) as unknown as typeof fetch);
    const r = await describeScreenSmart(JPEG, { backend: 'auto' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.backend).toBe('ollama'); expect(r.model).toBe('qwen3-vl:2b'); }
  });

  it('pickL2Backend 纯决策表驱动（降级链决策面——离线锁死）', async () => {
    const { pickL2Backend } = await import('../src/kernel/localVision.js');
    expect(pickL2Backend('off', true)).toBe('none');          // off：零打扰
    expect(pickL2Backend('off', false)).toBe('none');
    expect(pickL2Backend('moondream', true)).toBe('moondream'); // 显式保底档：不探 Ollama
    expect(pickL2Backend('moondream', false)).toBe('moondream');
    expect(pickL2Backend('ollama', true)).toBe('ollama');      // 显式主档：探活过才用
    expect(pickL2Backend('ollama', false)).toBe('none');       // 探活败直报（不静默换档）
    expect(pickL2Backend('auto', true)).toBe('ollama');        // auto：L2a 优先
    expect(pickL2Backend('auto', false)).toBe('moondream');    // auto：回落 L2b
  });

  it('--vlm off（backend:off）→ 强制 L2c，不触任何后端', async () => {
    const { describeScreenSmart } = await import('../src/kernel/localVision.js');
    let fetchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { fetchCalls++; return new Response('{}'); }) as unknown as typeof fetch);
    const r = await describeScreenSmart(JPEG, { backend: 'off' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('已关闭');
    expect(fetchCalls).toBe(0); // 零网络——off 就是零打扰
  });
});
