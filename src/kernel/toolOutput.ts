// src/kernel/toolOutput.ts — 工具输出工程三件套（gap P0-1/P2-4 落地，2026-08-18）
// ① offload：超阈值输出落盘 dataDir/truncations/ + 头尾预览 + 续读提示
//   （opencode truncate.ts 思路——长输出不再全量进上下文）
// ② mask：旧轮工具输出掩码（gemini toolOutputMasking 思路——保护最新 50k token，
//   保护窗外超过触发量的旧输出替换为掩码标注，幂等）
// ③ wrapLimit：untrusted 包裹面阈值不再写死 8000（settings.untrustedWrapLimit 可调）
// 所有阈值集中本模块（单一事实源），settings 可覆盖、夹取防误配——生产级无魔法数字。
import { mkdirSync, writeFileSync, openSync, readSync, closeSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { estimateTokens } from './memory.js';

export const OFFLOAD_BYTES_DEFAULT = 50 * 1024; // 50KB（opencode 同档落盘阈值）
export const OFFLOAD_LINES_DEFAULT = 2000;      // 2000 行（与 opencode 同档）
export const OFFLOAD_PREVIEW_HEAD = 2000;       // 预览头（字）
export const OFFLOAD_PREVIEW_TAIL = 500;        // 预览尾（字）
export const MASK_PROTECT_TOKENS_DEFAULT = 50_000; // gemini 保护窗
export const MASK_TRIGGER_TOKENS_DEFAULT = 30_000; // 保护窗外超过此量才掩码
export const DISTILL_CHARS_DEFAULT = 8000;      // 蒸馏触发阈值（字，开关默认关）
export const DISTILL_INPUT_CHARS = 60_000;      // 蒸馏输入封顶（防天价摘要）
export const UNTRUSTED_WRAP_LIMIT_DEFAULT = 8000; // 注入包裹面默认阈值

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(n, min), max);
}

/** untrusted 包裹面阈值（settings.untrustedWrapLimit，1k..100k） */
export function resolveWrapLimit(settings?: Record<string, any> | undefined): number {
  return clampInt(settings?.untrustedWrapLimit, UNTRUSTED_WRAP_LIMIT_DEFAULT, 1000, 100_000);
}

/** offload 阈值（settings.toolOutputOffloadBytes，10k..10M） */
export function resolveOffloadThreshold(settings?: Record<string, any> | undefined): number {
  return clampInt(settings?.toolOutputOffloadBytes, OFFLOAD_BYTES_DEFAULT, 10_000, 10_000_000);
}

/** 掩码窗口（保护窗/触发量，10k..1M） */
export function resolveMaskWindow(settings?: Record<string, any> | undefined): { protectTokens: number; triggerTokens: number } {
  return {
    protectTokens: clampInt(settings?.toolOutputMaskProtect, MASK_PROTECT_TOKENS_DEFAULT, 10_000, 1_000_000),
    triggerTokens: clampInt(settings?.toolOutputMaskTrigger, MASK_TRIGGER_TOKENS_DEFAULT, 10_000, 1_000_000),
  };
}

/** 蒸馏触发阈值（settings.toolDistillChars，1k..100k） */
export function resolveDistillThreshold(settings?: Record<string, any> | undefined): number {
  return clampInt(settings?.toolDistillChars, DISTILL_CHARS_DEFAULT, 1000, 100_000);
}

export interface OffloadResult {
  path: string;      // 绝对路径（dataDir/truncations/<session>/<ts>-<tool>-<hash8>.log）
  total: number;     // 总字符数
  preview: string;   // 头尾预览 + 诚实标注（可直接回填模型）
}

/**
 * 超阈值输出落盘（绝不静默截断）：返回 null = 无需 offload（阈值内）。
 * 落盘失败 → null（调用方走原有截断标注路径，诚实降级不抛）。
 */
export function offloadToolOutput(opts: {
  tool: string;
  text: string;
  dataDir: string;
  sessionId?: string;
  settings?: Record<string, any>;
}): OffloadResult | null {
  const threshold = resolveOffloadThreshold(opts.settings);
  const lines = opts.text.split('\n').length;
  if (opts.text.length <= threshold && lines <= OFFLOAD_LINES_DEFAULT) return null;
  try {
    const dir = join(opts.dataDir, 'truncations', String(opts.sessionId ?? 'default').replace(/[^\w.-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    const hash = createHash('sha256').update(`${opts.tool}\0${opts.text.slice(0, 4096)}`).digest('hex').slice(0, 8);
    const file = join(dir, `${Date.now().toString(36)}-${opts.tool.replace(/[^\w-]/g, '_').slice(0, 24)}-${hash}.log`);
    writeFileSync(file, opts.text, 'utf8');
    const head = opts.text.slice(0, OFFLOAD_PREVIEW_HEAD);
    const tail = opts.text.slice(-OFFLOAD_PREVIEW_TAIL);
    const ellipsis = opts.text.length > head.length + tail.length;
    const preview = `${head}${ellipsis ? `\n…[中间 ${opts.text.length - head.length - tail.length} 字省略]` : ''}${ellipsis ? `\n${tail}` : ''}\n…[完整输出（${opts.text.length} 字，${lines} 行）已落盘：${file}——用 bash cat/sed/tail 分段读取，或重定向到工作区文件后用 fs_read 分页]`;
    return { path: file, total: opts.text.length, preview };
  } catch {
    return null; // 落盘失败：不抛，调用方保持原有标注
  }
}

/** 有界读文件头尾（bash 流式落盘的完整输出预览——绝不整文件入内存） */
export function readHeadTail(path: string, headChars: number, tailChars: number): { head: string; tail: string; total: number } | null {
  try {
    const total = statSync(path).size;
    const fd = openSync(path, 'r');
    try {
      const readAt = (pos: number, n: number): string => {
        const buf = Buffer.alloc(n);
        const r = readSync(fd, buf, 0, n, Math.max(0, pos));
        return buf.toString('utf8', 0, Math.max(0, r));
      };
      const head = readAt(0, Math.min(headChars, total));
      const tail = total > headChars + tailChars ? readAt(total - tailChars, tailChars) : '';
      return { head, tail, total };
    } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * 把 bash 流式落盘的完整输出接管为正式 offload 文件（truncations/ 下规范命名），
 * 返回预览与路径；接管失败 → null（调用方走内存截断标注并清理源文件）。
 */
export function promoteOffloadFile(opts: {
  srcPath: string;
  tool: string;
  dataDir: string;
  sessionId?: string;
}): { path: string; total: number; preview: string } | null {
  try {
    const dir = join(opts.dataDir, 'truncations', String(opts.sessionId ?? 'default').replace(/[^\w.-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    const hash = createHash('sha256').update(`${opts.tool}\0${opts.srcPath}`).digest('hex').slice(0, 8);
    const file = join(dir, `${Date.now().toString(36)}-${opts.tool.replace(/[^\w-]/g, '_').slice(0, 24)}-${hash}.log`);
    renameSync(opts.srcPath, file);
    const ht = readHeadTail(file, OFFLOAD_PREVIEW_HEAD, OFFLOAD_PREVIEW_TAIL);
    if (!ht) { rmSync(file, { force: true }); return null; }
    const ellipsis = ht.total > ht.head.length + ht.tail.length;
    const preview = `${ht.head}${ellipsis ? `\n…[中间 ${ht.total - ht.head.length - ht.tail.length} 字省略]` : ''}${ellipsis ? `\n${ht.tail}` : ''}\n…[完整输出（${ht.total} 字）已落盘：${file}——用 bash cat/sed/tail 分段读取，或重定向到工作区文件后用 fs_read 分页]`;
    return { path: file, total: ht.total, preview };
  } catch { return null; }
}

/** 掩码标注文案（模型可见，诚实告知原文仍在且可恢复） */
export function maskNote(origLen: number): string {
  return `[已掩码：早前工具输出（原 ${origLen} 字）——上下文窗口保护，原文未变；需要时重新执行对应工具，或 /compact 将早前结果并入摘要]`;
}

/**
 * 旧轮工具输出掩码（幂等）：从尾部累计 token——保护窗内不动；保护窗外的
 * 工具消息总长超过触发量时全部替换为掩码标注。返回被掩码条数。
 */
export function maskOldToolOutputs(
  messages: Array<{ role: string; content: unknown | null }>,
  opts: { protectTokens?: number; triggerTokens?: number },
): number {
  const protect = opts.protectTokens ?? MASK_PROTECT_TOKENS_DEFAULT;
  const trigger = opts.triggerTokens ?? MASK_TRIGGER_TOKENS_DEFAULT;
  const maskIdx: number[] = [];
  let cum = 0;
  let maskTotal = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (m.content.startsWith('[已掩码：')) continue; // 幂等
    const n = estimateTokens(m.content);
    if (cum > protect) {
      maskIdx.push(i);
      maskTotal += n;
    }
    cum += n;
  }
  if (maskTotal < trigger) return 0;
  for (const i of maskIdx) {
    const m = messages[i]!;
    if (typeof m.content === 'string') m.content = maskNote(m.content.length);
  }
  return maskIdx.length;
}
