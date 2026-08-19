// src/wxnodus-ui/lib/terminalColors.ts — system 主题：OSC 10/11 终端前景/背景色探测（2026-08-19 B-04 收口）
// 机制：向终端发送 OSC 10/11 查询（XTSMGRAPHICS 子集），监听 400ms 内的响应并解析。
// 诚实边界：conhost 无 OSC 协议支持（无响应）——超时返回 null，调用方如实报「system 不可用」，
// 绝不伪造配色。Windows Terminal/xterm/kitty/WezTerm 支持该查询。
import type { Readable, Writable } from 'node:stream';

export interface TerminalColors { fg: string; bg: string }

const HEX = /^#[0-9a-fA-F]{6}$/;

/** 解析 OSC 响应串：`\x1b]10;rgb:RRRR/GGGG/BBBB\x07` → { fg }；11 → { bg }（每次响应三通道整体合成） */
export function parseOscColorResponses(data: string): Partial<TerminalColors> {
  const out: Partial<TerminalColors> = {};
  const norm = (v: string) => (v.length >= 3 ? v.slice(0, 2) : v.length === 1 ? v + v : v).toLowerCase();
  const re = /\x1b\](\d+);rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data))) {
    const color = `#${norm(m[2]!)}${norm(m[3]!)}${norm(m[4]!)}`;
    if (m[1] === '10') out.fg = color;
    if (m[1] === '11') out.bg = color;
  }
  return out;
}

/** 查询终端前景/背景色（可注入流——测试无需真实终端）；400ms 无完整响应 → null（诚实） */
export async function queryTerminalColors(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  timeoutMs = 400
): Promise<TerminalColors | null> {
  return new Promise(resolve => {
    const acc: Partial<TerminalColors> = {};
    let done = false;
    const finish = (v: TerminalColors | null) => {
      if (done) return;
      done = true;
      try { input.removeListener('data', onData); } catch { /* 注入流可能无该 API */ }
      clearTimeout(timer);
      resolve(v);
    };
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      Object.assign(acc, parseOscColorResponses(s));
      if (HEX.test(acc.fg ?? '') && HEX.test(acc.bg ?? '')) finish({ fg: acc.fg!, bg: acc.bg! });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { input.on('data', onData); } catch { finish(null); return; }
    // OSC 查询（BEL 终止；ST 形式终端亦常见——两式并发更稳，但同一终端通常回其一，重复无害）
    try {
      output.write('\x1b]10;?\x07');
      output.write('\x1b]11;?\x07');
    } catch { finish(null); }
  });
}
