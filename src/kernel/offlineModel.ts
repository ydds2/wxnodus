// src/kernel/offlineModel.ts — 离线 token 包：本地 LLM 通道（transformers.js + onnxruntime-node）
// 设计（审查完善：离线拼图最后一块——视觉/记忆/语音已离线，文本 LLM 缺位）：
//   - 模型：onnx-community/Qwen2.5-1.5B-Instruct q4 量化（~1.2GB，中文优先——wxnodus 主场景）
//   - 通道：settings.model = 'offline:Qwen2.5-1.5B-Instruct'（MODEL_CATALOG 条目）时，
//     llmStream（对话）/ llmOnce（规格化/压缩）双通道自动走本地
//   - 模型缓存：data/models（transformers.js cacheDir 指向本地——不依赖用户目录）
//   - 诚实边界：1.5B 质量有限（对话/规格化/摘要可用，复杂推理弱）；CPU ~10-30 tok/s；
//     不支持工具调用（agent 离线对话为纯文本，工具类任务诚实降级）；模型未下载时
//     明确归因「离线模型缺失——/offline pack download」
import { env } from '@huggingface/transformers';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from './paths.js';

// 模型缓存本地化：data/models（可被 /offline pack dir 查看；WXNODUS_DATA_DIR 跟随）
try { env.cacheDir = resolveDataDir(process.cwd()); } catch { /* 环境异常时用默认缓存 */ }

export interface OfflineModelInfo { id: string; sizeGB: string; speed: string; note: string }

/** 离线模型目录（与 MODEL_CATALOG offline:* 条目同步） */
export const OFFLINE_MODELS: Record<string, OfflineModelInfo> = {
  'offline:Qwen2.5-1.5B': {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    sizeGB: '~1.2GB',
    speed: 'CPU ~15-30 tok/s',
    note: '中文优先，对话/规格化/摘要够用',
  },
  'offline:Qwen2.5-3B': {
    id: 'onnx-community/Qwen2.5-3B-Instruct',
    sizeGB: '~2.5GB',
    speed: 'CPU ~8-15 tok/s',
    note: '质量更高，慢一档',
  },
};

/** 解析离线模型名 → HF 模型 id；非 offline: 前缀返回 null */
export function offlineModelId(model: string | undefined | null): string | null {
  const m = OFFLINE_MODELS[String(model ?? '')];
  return m?.id ?? null;
}

// ── pipeline 单例（惰性加载 + 失败归因，不反复尝试）──
// 审查修复（P2）：按 modelId 独立缓存——此前单一 pipe 导致切模型后仍用旧模型生成、
// 加载期跨模型共享 promise、一模型失败永久拒绝另一模型
const pipes = new Map<string, any>();
const pipeFailed = new Set<string>();
const loadings = new Map<string, Promise<any>>();

async function getPipe(modelId: string): Promise<{ pipe: any } | { error: string }> {
  if (pipes.has(modelId)) return { pipe: pipes.get(modelId) };
  if (pipeFailed.has(modelId)) return { error: '离线模型加载失败（历史错误）——/offline pack status 查看或重启重试' };
  if (!loadings.has(modelId)) {
    loadings.set(modelId, (async () => {
      try {
        const { pipeline } = await import('@huggingface/transformers');
        // KF-001（离线保证）：推理加载禁止远程——本地缓存缺失立即快速失败（~30ms 实测），
        // 绝不为补文件静默联网（「断网可用」承诺的事实层）
        env.allowRemoteModels = false;
        const p = await pipeline('text-generation', modelId, { dtype: 'q4' });
        pipes.set(modelId, p);
        return p;
      } catch {
        pipeFailed.add(modelId);
        return null;
      } finally {
        loadings.delete(modelId);
      }
    })());
  }
  const p = await loadings.get(modelId);
  if (!p) return { error: '离线模型加载失败——未下载？/offline pack download 预下载；或检查磁盘空间' };
  return { pipe: p };
}

function toText(messages: Array<{ role: string; content: unknown }>): string {
  // 简易拼接（Qwen chat template 由 transformers.js 自动应用——传 messages 数组更优，
  // 但 v3 文本生成接受字符串；为稳妥用模板拼接，模型已用 Qwen 格式微调）
  return messages.map(m => {
    const c = Array.isArray(m.content) ? m.content.map(x => (x as any)?.text ?? '').join('') : String(m.content ?? '');
    return `${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'}: ${c}`;
  }).join('\n') + '\n助手: ';
}

export interface OfflineChatOpts {
  messages: Array<{ role: string; content: unknown }>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onToken?: (t: string) => void;
  onReasoning?: (t: string) => void;
}

export type OfflineChatResult =
  | { ok: true; content: string; usage?: { promptTokens: number; completionTokens: number } }
  | { ok: false; error: string };

/** 本地 LLM 单轮生成（模型名 = settings.model 的 offline: 前缀值） */
export async function callOfflineLlm(model: string, opts: OfflineChatOpts): Promise<OfflineChatResult> {
  const hfId = offlineModelId(model);
  if (!hfId) return { ok: false, error: `未知离线模型：${model}` };
  const got = await getPipe(hfId);
  if ('error' in got) return { ok: false, error: got.error };
  try {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    // 超时兜底：Promise.race（transformers.js 无内建超时；超时后推理在后台继续但结果丢弃）
    const gen = got.pipe(toText(opts.messages), {
      max_new_tokens: 1024,
      temperature: 0.6,
      top_p: 0.9,
      do_sample: true,
      // 流式逐 token 回调（transformers.js v3 callback 语义）
      callback: (t: any) => {
        if (opts.signal?.aborted) throw new Error('aborted');
        const piece = typeof t === 'string' ? t : t?.[0]?.generated_text ?? t?.token?.text ?? '';
        if (piece) opts.onToken?.(piece);
      },
    });
    // 审查修复（P3）：timer 泄漏——race 落定后 clearTimeout，否则 pending timer 挂住事件循环 180s
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timed = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`离线推理超时（>${timeoutMs / 1000}s）`)), timeoutMs);
    });
    let out: any;
    try {
      out = await Promise.race([gen, timed]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = typeof out === 'string' ? out : String(out?.[0]?.generated_text ?? '');
    return { ok: true, content: text, usage: { promptTokens: 0, completionTokens: 0 } };
  } catch (e: any) {
    if (String(e?.message ?? '').includes('aborted')) return { ok: false, error: '已中断' };
    return { ok: false, error: `本地推理失败：${String(e?.message ?? e).slice(0, 150)}` };
  }
}

// 波 2 ⑪：拉取进度（codex ollama/lib.rs:22-34 ensure_oss_ready→pull_with_reporter 对标）——
// transformers.js progress_callback → 归一化进度事件（纯函数可单测，见 normalizePipelineProgress）
export interface OfflineDownloadProgress {
  status: string;
  file?: string;
  /** 0-100（progress 字段优先；缺省按 loaded/total 估算） */
  percent: number;
}

export function normalizePipelineProgress(raw: unknown): OfflineDownloadProgress {
  const p = (raw ?? {}) as Record<string, unknown>;
  const loaded = Number(p.loaded ?? 0);
  const total = Number(p.total ?? 0);
  const percent = typeof p.progress === 'number'
    ? Math.max(0, Math.min(100, p.progress))
    : total > 0
      ? Math.max(0, Math.min(100, (loaded / total) * 100))
      : 0;
  return {
    status: String(p.status ?? 'progress'),
    file: typeof p.file === 'string' ? p.file : undefined,
    percent: Math.round(percent * 10) / 10,
  };
}

/** 预下载离线模型（/offline pack download）——下载后完全断网可用；onProgress 回调流式进度 */
export async function downloadOfflineModel(
  model: string,
  onProgress?: (p: OfflineDownloadProgress) => void,
): Promise<{ ok: boolean; message: string }> {
  const hfId = offlineModelId(model);
  if (!hfId) return { ok: false, message: `未知离线模型：${model}` };
  try {
    const { pipeline } = await import('@huggingface/transformers');
    // 下载通道显式允许远程（getPipe 推理通道已禁网——此处重新打开，仅此入口联网）
    env.allowRemoteModels = true;
    await pipeline('text-generation', hfId, {
      dtype: 'q4',
      progress_callback: onProgress ? (raw: unknown) => onProgress(normalizePipelineProgress(raw)) : undefined,
    });
    return { ok: true, message: `离线模型已就绪：${model}（缓存 ${resolveDataDir(process.cwd())}）——断网可用` };
  } catch (e: any) {
    return { ok: false, message: `下载失败：${String(e?.message ?? e).slice(0, 150)}（需要网络；成功后断网可用）` };
  }
}

/** 缺模型即拉取（codex ensure_oss_ready 对标）：已就绪零下载直接返回；未就绪下载并回报进度。
 *  /offline on 等入口零门槛可用——不再要求用户先记着跑 download。 */
export async function ensureOfflineModelReady(
  model: string,
  onProgress?: (p: OfflineDownloadProgress) => void,
): Promise<{ ok: boolean; message: string; already?: boolean }> {
  if (isOfflineModelReady(model)) {
    return { ok: true, message: `${model} 已就绪——断网可用`, already: true };
  }
  const r = await downloadOfflineModel(model, onProgress);
  return { ...r, already: false };
}

/** 离线模型缓存大小（字节）——/offline pack status */
export function offlineCacheBytes(): number {
  try {
    const dir = resolveDataDir(process.cwd());
    let total = 0;
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        try { if (statSync(p).isDirectory()) walk(p); else total += statSync(p).size; } catch { /* 忽略 */ }
      }
    };
    walk(dir);
    return total;
  } catch { return 0; }
}

/** 指定离线模型是否已下载（transformers.js 缓存：data/models/onnx-community/<模型>） */
export function isOfflineModelReady(model: string | undefined | null): boolean {
  const hfId = offlineModelId(model);
  if (!hfId) return false;
  try {
    const dir = join(resolveDataDir(process.cwd()), 'models', ...hfId.split('/'));
    return statSync(dir).isDirectory() && readdirSync(dir).some(f => f.endsWith('.onnx'));
  } catch { return false; }
}
