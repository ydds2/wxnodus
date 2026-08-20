// src/cli/stdinPipe.ts — stdin 管道模式（crush/gemini 对齐：cat 文件 | wxnodus）
// 设计：非 TTY stdin 且非 --wire/--serve/--mcp-server 时探测管道输入——
//   · 首字节宽限期内无数据 → 视为无管道输入（execFile 等保持 stdin 打开的调用方零阻塞）；
//   · 有数据 → 持续读到 EOF，总量封顶 STDIN_MAX_BYTES 后立即截断（诚实标注在 compose 层）；
//   · --wire 的 stdin 是 RPC 帧通道、--serve 不消费 stdin、--mcp-server 的 stdin 是 MCP
//     stdio 传输——三者绝不混用。
import { labelTruncate } from '../kernel/truncate.js';

/** 首字节宽限期：窗口内无数据即放弃管道输入（调用方保持 stdin 打开时零阻塞） */
export const STDIN_FIRST_BYTE_GRACE_MS = 300;
/** 管道输入总量上限（字节）：超限截断，composePipePrompt 层标注剩余未读 */
export const STDIN_MAX_BYTES = 1_000_000;
/** 管道素材注入模型的字符上限（labelTruncate 诚实标注口径——模型知道有剩余） */
export const STDIN_PROMPT_CHAR_LIMIT = 50_000;

/**
 * 读取 stdin 全文（非 TTY 管道）。宽限期内无数据返回 ''；有数据后读到 EOF 或封顶。
 * 绝不抛出——任何异常按无输入处理（调用方继续原路径）。
 */
export async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  try {
    await new Promise<void>((resolve) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        process.stdin.off('data', onData);
        process.stdin.off('end', finish);
        resolve();
      };
      const grace = setTimeout(finish, STDIN_FIRST_BYTE_GRACE_MS);
      const onData = (c: Buffer | string) => {
        clearTimeout(grace);
        const buf = typeof c === 'string' ? Buffer.from(c) : c;
        const room = STDIN_MAX_BYTES - total;
        if (room > 0) chunks.push(room >= buf.length ? buf : buf.subarray(0, room));
        total += buf.length;
        if (total >= STDIN_MAX_BYTES) finish();
      };
      process.stdin.on('data', onData);
      process.stdin.on('end', finish);
      process.stdin.resume();
    });
  } catch {
    return '';
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, STDIN_MAX_BYTES);
}

/**
 * 组合管道提示（纯函数可单测）：-p 存在 → 指令 + <stdin> 素材块；-p 缺失 → 素材即提问。
 * 超限截断带「已截断（共 N 字，剩余 M 字未读）」诚实标注（labelTruncate 统一口径）。
 */
export function composePipePrompt(prompt: string | null, stdinText: string): string {
  const material = labelTruncate(stdinText.trim(), STDIN_PROMPT_CHAR_LIMIT);
  if (!prompt) return material;
  return `${prompt}\n\n<stdin>\n${material}\n</stdin>`;
}
