// src/kernel/mentions.ts — @提及展开（Claude Code @mention 同款语义）
// 提交前扫描 prompt 中的 @path 标记：存在的文件读入并追加「（提及文件内容）」块——
// 模型无需再猜/再读；不存在的路径原文保留（散文中 @人名 零影响），进 missing 供通知。
// 边界：仅「含路径字符（/ \ .）」的 token 视为提及候选（@张三/@team 不触发文件读取）；
// 二进制（含 NUL）跳过；单文件/总量上限截断（诚实 truncated）。纯函数可单测。
import { resolve } from 'node:path';

export interface MentionInfo {
  path: string;
  bytes: number;
  truncated: boolean;
}

export interface MentionResult {
  /** 展开后的完整 prompt（原文本 + 提及文件内容块） */
  text: string;
  mentions: MentionInfo[];
  /** 不存在的提及（原文保留，供通知） */
  missing: string[];
  /** 二进制跳过的提及 */
  skipped: string[];
}

// 提及候选：@ 后至少一个路径字符（斜杠/反斜杠/点）——散文中 @人名 不会误触发
const MENTION_RE = /@([^\s@]*[/.\\][^\s@]*)/g;

// 波 2 ②：行区间语法 @path#L1-L5 / @path#L10（opencode autocomplete.tsx:29-58 对标）——
// 只取行区间进上下文；区间越界夹取（1-based）；形如 #L 无数字的尾巴不匹配 → 按全文
const RANGE_RE = /^(.*?)#L(\d+)(?:-L?(\d+))?$/;

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0);

export function expandMentions(
  input: string,
  opts: { cwd: string; readFile(path: string): Buffer | null; maxFileBytes?: number; maxTotalBytes?: number },
): MentionResult {
  const maxFileBytes = opts.maxFileBytes ?? 32_768;
  const maxTotalBytes = opts.maxTotalBytes ?? 65_536;
  const mentions: MentionInfo[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  const blocks: string[] = [];
  let total = 0;

  for (const m of input.matchAll(MENTION_RE)) {
    const token = m[1]!;
    // 波 2 ②：行区间解析（token 内 #L… 段分离；路径部分为空则不按区间处理）
    const range = RANGE_RE.exec(token);
    const pathPart = range ? range[1]! : token;
    const rangeStart = range ? Number(range[2]) : null;
    const rangeEnd = range ? (range[3] !== undefined ? Number(range[3]) : Number(range[2])) : null;
    const abs = resolve(opts.cwd, pathPart || token);
    let buf: Buffer | null = null;
    try {
      buf = opts.readFile(abs);
    } catch {
      buf = null;
    }
    if (!buf) {
      missing.push(token);
      continue;
    }
    if (isBinary(buf)) {
      skipped.push(token);
      continue;
    }
    // 行区间模式：全文解码后按 1-based 行号夹取（越界 clamp 到文件范围——opencode 同款）
    let slice: Buffer;
    if (rangeStart !== null && rangeEnd !== null) {
      const lines = buf.toString('utf8').split('\n');
      const start = Math.max(1, Math.min(rangeStart, lines.length));
      const end = Math.max(start, Math.min(rangeEnd, lines.length));
      slice = Buffer.from(lines.slice(start - 1, end).join('\n'), 'utf8');
    } else {
      slice = buf;
    }
    const truncated = slice.length > maxFileBytes || total + slice.length > maxTotalBytes;
    const out = truncated ? slice.subarray(0, Math.min(maxFileBytes, Math.max(0, maxTotalBytes - total))) : slice;
    total += out.length;
    mentions.push({ path: token, bytes: out.length, truncated });
    blocks.push(`\`\`\`${token}\n${out.toString('utf8').replace(/\n```/g, '\n`` `')}${truncated ? '\n…（已截断）' : ''}\n\`\`\``);
    if (total >= maxTotalBytes) break;
  }

  const text = blocks.length ? `${input}\n\n（提及文件内容）\n${blocks.join('\n\n')}` : input;
  return { text, mentions, missing, skipped };
}
