// src/kernel/vision.ts — L6-2 视觉理解（/vision /img /video /computer_observe 共用）
// 设计（审查升级：开放视觉通道——不再硬编码智谱）：
//   通道优先级：① settings.visionBaseURL/visionModel/visionKey（/config set 可配）
//               ② 环境变量 WXNODUS_VISION_BASE_URL/MODEL/KEY（兼容保留，自建网关/代理）
//               ③ 本地 VLM（settings.visionLocal=true 或 WXNODUS_VISION_LOCAL=1）：
//                  transformers.js image-to-text（moondream2 q8，完全离线无 key）
//               ④ 默认智谱 glm-4v-flash（免费）
//   任何 OpenAI 兼容端点都可换（ollama 本地 qwen2.5-vl / OpenRouter / 自建网关…）
//   错误归因：describeImageStatus 区分 无 key / 本地不可用 / 网络失败（不再一律 null）
import { decryptKey } from './providers.js';
import { createHash } from 'node:crypto';

interface VisionSettings { baseURL?: string; model?: string; key?: string; local?: boolean; ocr?: boolean }

const pickSettings = (s: any): VisionSettings => {
  const settings = (s ?? {}) as Record<string, any>;
  return {
    baseURL: settings.visionBaseURL ?? process.env.WXNODUS_VISION_BASE_URL,
    model: settings.visionModel ?? process.env.WXNODUS_VISION_MODEL,
    key: settings.visionKey ?? process.env.WXNODUS_VISION_KEY,
    local: settings.visionLocal === true || process.env.WXNODUS_VISION_LOCAL === '1',
    // ocr=false：跳过 Windows OCR 兜底（agent 自动降级路径用——聊天回合内不 spawn PowerShell，
    // 显式 /vision 保持默认 true 的 OCR 兜底）
    ocr: settings.visionOcr !== false,
  };
};

const visionBase = () => process.env.WXNODUS_VISION_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4';
const visionModel = () => process.env.WXNODUS_VISION_MODEL ?? 'glm-4v-flash';
// per-provider 密钥槽优先取 zhipu（视觉默认端点）；无则回退遗留单槽
const visionKey = (enc: string | null, apiKeys?: Record<string, string> | null): string | null => {
  if (process.env.WXNODUS_VISION_KEY) return process.env.WXNODUS_VISION_KEY;
  if (apiKeys?.zhipu) {
    const d = decryptKey(apiKeys.zhipu);
    if (d) return d;
  }
  if (!enc) return null;
  return decryptKey(enc);
};

// ── 本地视觉（transformers.js image-to-text——完全离线、无 key）──
// moondream2 q8 量化（~1.7GB 首次下载缓存，之后本地）；sharp（传递依赖）负责图像解码
let localPipe: any = null;
let localFailed = false;
async function localVision(png: Uint8Array, prompt: string): Promise<string | null> {
  try {
    const { pipeline } = await import('@huggingface/transformers');
    if (!localPipe && !localFailed) {
      try {
        localPipe = await pipeline('image-to-text', 'onnx-community/moondream2', { dtype: 'q8' });
      } catch {
        localFailed = true; // 模型下载/加载失败——归因，不反复尝试
        return null;
      }
    }
    if (!localPipe) return null;
    // moondream 用英文指令效果最佳（中文由上层翻译场景）
    const out = await localPipe(png, { prompt: prompt && /^[\x00-\x7f]+$/.test(prompt) ? prompt : 'Describe this image in detail, including all visible text, layout and UI elements.' });
    return typeof out === 'string' ? out : String((out as any)?.[0]?.generated_text ?? '').trim() || null;
  } catch {
    return null;
  }
}

const extractText = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return content.trim() ? content.trim() : null;
  }
  if (Array.isArray(content)) {
    const text = content.map(c => (c as any)?.text ?? '').join('').trim();
    return text || null;
  }
  return null;
};

export interface VisionResult { ok: boolean; text?: string; reason?: string; cached?: boolean }

// ── 同屏去重缓存（LRU(1)）：computer_observe 循环观测静止画面时同图秒回，
// 不重复打视觉 API；key = target+prompt 哈希，TTL 10s（画面变化后自然失效）──
const VISION_DEDUP_MS = 10_000;
let lastVision: { hash: string; ts: number; result: VisionResult } | null = null;

const visionHash = (target: string, prompt: string | undefined): string =>
  createHash('sha256').update(`${target}\u0000${prompt ?? ''}`).digest('hex');

/** 远程视觉（OpenAI 兼容端点——settings/环境变量/默认智谱） */
async function remoteVision(target: string, key: string, prompt: string | undefined, settings: VisionSettings): Promise<VisionResult> {
  try {
    let imageUrl: string;
    if (target.startsWith('data:')) {
      imageUrl = target; // data:URL 直传（多模态历史回显复用）
    } else if (/^https?:\/\//i.test(target)) {
      imageUrl = target;
    } else {
      const { readFileSync } = await import('node:fs');
      const { extname } = await import('node:path');
      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      const mime = mimeMap[extname(target).toLowerCase()] ?? 'image/png';
      imageUrl = `data:${mime};base64,` + readFileSync(target).toString('base64');
    }
    const base = (settings.baseURL ?? visionBase()).replace(/\/+$/, '');
    const model = settings.model ?? visionModel();
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt ?? '描述这张图片的内容，包括文字、布局与视觉特征' }, { type: 'image_url', image_url: { url: imageUrl } }] }],
        stream: false,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) return { ok: false, reason: `视觉密钥被拒（HTTP ${resp.status}）——检查 settings.visionKey 或 /key set` };
      if (resp.status === 429) return { ok: false, reason: '视觉配额不足（HTTP 429）——换模型或稍后再试' };
      return { ok: false, reason: `视觉端点返回 HTTP ${resp.status}——检查 settings.visionBaseURL` };
    }
    const j = await resp.json() as any;
    const text = extractText(j?.choices?.[0]?.message?.content);
    return text ? { ok: true, text } : { ok: false, reason: '视觉端点返回空内容（模型不支持图片？）' };
  } catch (e: any) {
    return { ok: false, reason: `视觉请求失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
}

/** 视觉理解（开放通道）——返回状态可归因；settings 为可选第 4 参（/config set 可配）；同图 10s 内去重（cached=true） */
export async function describeImageStatus(target: string, apiKeyEnc: string | null, prompt?: string, settings?: any): Promise<VisionResult> {
  // 同屏去重：静止画面循环观测（computer_observe）同 target+prompt 直接回缓存
  const hash = visionHash(target, prompt);
  if (lastVision && lastVision.hash === hash && Date.now() - lastVision.ts < VISION_DEDUP_MS) {
    return { ...lastVision.result, cached: true };
  }
  const store = (result: VisionResult): VisionResult => {
    lastVision = { hash, ts: Date.now(), result };
    return result;
  };
  const vs = pickSettings(settings);
  // 本地 VLM 优先（显式开启）——完全离线
  if (vs.local) {
    try {
      const { readFileSync } = await import('node:fs');
      const png = target.startsWith('data:') ? Buffer.from(target.split(',')[1] ?? '', 'base64')
        : /^https?:\/\//i.test(target) ? null
        : readFileSync(target);
      if (png) {
        const text = await localVision(new Uint8Array(png), prompt ?? '');
        if (text) return store({ ok: true, text });
        return store({ ok: false, reason: localFailed ? '本地视觉模型加载失败（下载中断或内存不足）——检查网络后重试，或关闭 visionLocal' : '本地视觉未返回结果' });
      }
    } catch (e: any) {
      return store({ ok: false, reason: `本地视觉不可用：${String(e?.message ?? e).slice(0, 120)}` });
    }
  }
  // 远程：settings key > env > 加密配置（per-provider 槽 zhipu 优先，遗留单槽兜底）
  const key = vs.key ?? visionKey(apiKeyEnc, (settings as Record<string, any> | undefined)?.apiKeys);
  if (!key) {
    // W8-09 Windows 生态互依：无视觉密钥 → 系统原生 OCR 兜底（离线、零模型下载——提取画面文字；
    // 语义诚实：返回 OCR 文本而非视觉描述）。自动降级路径（visionOcr=false）跳过 OCR。
    if (vs.ocr !== false) {
      const ocrText = await windowsOcrFallback(target);
      if (ocrText) return store({ ok: true, text: ocrText });
    }
    return store({ ok: false, reason: '未配置视觉密钥——/key set <密钥> 或 settings.visionKey；或用 settings.visionLocal=true 本地离线视觉' });
  }
  return store(await remoteVision(target, key, prompt, vs));
}

/** Windows 系统 OCR 兜底（file 路径直读；data: 写临时文件；http 不做下载——诚实跳过） */
async function windowsOcrFallback(target: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  if (/^https?:\/\//i.test(target)) return null;
  try {
    const { ocrWindowsImage } = await import('./computer/ocr.js');
    if (target.startsWith('data:')) {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'wxn-ocr-'));
      const png = join(dir, 'frame.png');
      writeFileSync(png, Buffer.from(target.split(',')[1] ?? '', 'base64'));
      const r = await ocrWindowsImage(png);
      rmSync(dir, { recursive: true, force: true });
      return r.ok ? r.text : null;
    }
    const r = await ocrWindowsImage(target);
    return r.ok ? r.text : null;
  } catch {
    return null;
  }
}

/** 兼容旧签名：失败返回 null（调用方按无描述处理） */
export async function describeImage(target: string, apiKeyEnc: string | null, prompt?: string, settings?: any): Promise<string | null> {
  const r = await describeImageStatus(target, apiKeyEnc, prompt, settings);
  return r.ok ? (r.text ?? null) : null;
}

// 文本模型综合（视频帧描述序列 → 项目级分析报告）
// 默认 glm-4-flash（免费）——glm-4.5 需付费额度（429 余额不足）
export async function analyzeText(prompt: string, apiKeyEnc: string | null): Promise<string | null> {
  const key = visionKey(apiKeyEnc);
  if (!key) return null;
  try {
    const resp = await fetch(`${visionBase().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: process.env.WXNODUS_TEXT_MODEL ?? 'glm-4-flash',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) return null;
    const j = await resp.json() as any;
    return extractText(j?.choices?.[0]?.message?.content);
  } catch {
    return null;
  }
}
