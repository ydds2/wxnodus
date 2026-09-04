// src/kernel/ollamaVision.ts — L2a 本地视觉主档：Ollama + VLM（2026-09-04 · 本地 VLM 部署方案 §4.1）
// 方案 docs/ 本地视觉计划（deepseek 2026-09-04）：主档 Ollama 常驻 GPU（qwen3-vl:2b 等），
// 与保底档 moondream2（进程内 CPU，localVision.ts）构成降级链 L2a→L2b→L2c。
// 原则：数据不出机（Ollama 仅回环监听）；诚实失败（连接拒绝/超时/坏响应/空输出均 ok:false+原因，
// 绝不假装理解屏幕）；探活结果短缓存（60s——服务启停的自动回切/回落靠它）。
export interface OllamaVisionOptions {
  url?: string;
  model?: string;
  timeoutMs?: number;
}

export interface OllamaProbe {
  ok: boolean;
  models: string[];
  detail: string;
}

const DEFAULT_URL = process.env.WXNODUS_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.WXNODUS_OLLAMA_MODEL ?? 'qwen3-vl:2b';

// 探活短缓存（60s：服务启停后 ≤60s 自动回切；显式 resetOllamaVision 立即失效）
let probeCache: { at: number; probe: OllamaProbe; url: string } | null = null;
const PROBE_TTL_MS = 60_000;

/** 测试隔离（K3 seam） */
export function resetOllamaVision(): void {
  probeCache = null;
}

/** 探活：GET /api/tags——服务在 + 模型清单（不要求目标模型已拉取——describe 时如实报） */
export async function probeOllamaVision(url: string = DEFAULT_URL, timeoutMs = 4_000): Promise<OllamaProbe> {
  if (probeCache && probeCache.url === url && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.probe;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
    if (!r.ok) {
      const probe = { ok: false, models: [], detail: `Ollama 响应 ${r.status}` };
      probeCache = { at: Date.now(), probe, url };
      return probe;
    }
    const j = await r.json() as { models?: Array<{ name?: string }> };
    const models = (j.models ?? []).map(m => String(m.name ?? '')).filter(Boolean);
    const probe = { ok: true, models, detail: `Ollama 在线（${models.length} 个模型）` };
    probeCache = { at: Date.now(), probe, url };
    return probe;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const probe = { ok: false, models: [], detail: /abort|timeout/i.test(msg) ? 'Ollama 探活超时' : `Ollama 不可达：${msg.slice(0, 80)}` };
    probeCache = { at: Date.now(), probe, url };
    return probe;
  } finally {
    clearTimeout(timer);
  }
}

/** 屏幕描述：POST /api/generate（images base64 · stream:false · 默认 20s 超时）——诚实失败 */
export async function describeScreenOllama(
  jpeg: Buffer,
  opts: OllamaVisionOptions = {},
): Promise<{ ok: true; text: string; model: string } | { ok: false; error: string }> {
  const url = (opts.url ?? DEFAULT_URL).replace(/\/$/, '');
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt: '描述这张屏幕截图的关键内容（窗口/文字/可交互元素），简洁中文。',
        images: [jpeg.toString('base64')],
        stream: false,
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: `Ollama 响应 ${r.status}${body ? `：${body.slice(0, 80)}` : ''}` };
    }
    const j = await r.json() as { response?: string; error?: string };
    if (j.error) return { ok: false, error: `Ollama 报错：${String(j.error).slice(0, 120)}` };
    const text = String(j.response ?? '').trim();
    return text ? { ok: true, text, model } : { ok: false, error: 'Ollama 输出为空（诚实——不伪造描述）' };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort|timeout/i.test(msg) ? `Ollama 生成超时（${timeoutMs / 1000}s）` : `Ollama 通道失败：${msg.slice(0, 100)}` };
  } finally {
    clearTimeout(timer);
  }
}
