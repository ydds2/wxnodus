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
    const abs = resolve(opts.cwd, token);
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
    const truncated = buf.length > maxFileBytes || total + buf.length > maxTotalBytes;
    const slice = truncated ? buf.subarray(0, Math.min(maxFileBytes, Math.max(0, maxTotalBytes - total))) : buf;
    total += slice.length;
    mentions.push({ path: token, bytes: buf.length, truncated });
    blocks.push(`\`\`\`${token}\n${slice.toString('utf8').replace(/\n```/g, '\n`` `')}${truncated ? '\n…（已截断）' : ''}\n\`\`\``);
    if (total >= maxTotalBytes) break;
  }

  const text = blocks.length ? `${input}\n\n（提及文件内容）\n${blocks.join('\n\n')}` : input;
  return { text, mentions, missing, skipped };
}
