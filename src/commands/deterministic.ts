// src/commands/deterministic.ts — L4 确定性工具包（AI_OWNED：自然语言直达触发，毫秒级不经模型）
import { createHash } from 'node:crypto';

interface Det { re: RegExp; run: (m: RegExpMatchArray) => string | null }

const DET: Det[] = [
  {
    re: /^(?:算|计算|算一下|算下|帮我算)[:：]?\s*([\d\s+\-*/().]{2,})\s*(?:等于多少|是多少|等于)?$/i,
    run: m => {
      const expr = m[1].trim();
      if (!/^[\d\s+\-*/().]+$/.test(expr) || !/[+\-*/]/.test(expr)) return null;
      try {
        const v = Function(`"use strict"; return (${expr});`)();
        return typeof v === 'number' && Number.isFinite(v) ? `= ${v}` : null;
      } catch { return null; }
    },
  },
  {
    re: /^(?:md5|sha256)\s+([a-zA-Z0-9_\-.\s]+)$/i,
    run: m => {
      const algo = m[0].startsWith('md5') ? 'md5' : 'sha256';
      return createHash(algo).update(m[1].trim()).digest('hex');
    },
  },
  {
    re: /^(?:base64\s+)?(?:编码|加密)\s+([\s\S]+)$/i,
    run: m => Buffer.from(m[1].trim(), 'utf8').toString('base64'),
  },
  {
    re: /^随机数\s+(\d+)\s*(?:到|至|-)\s*(\d+)$/i,
    run: m => {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (isNaN(a) || isNaN(b) || a > b) return null;
      return String(a + Math.floor(Math.random() * (b - a + 1)));
    },
  },
  {
    re: /^([\d.]+)\s*(km|kg|gb|mb|tb)\s*换算成\s*(m|g|mb|kb|gb|b)$/i,
    run: m => {
      const v = parseFloat(m[1]);
      if (isNaN(v)) return null;
      const map: Record<string, number> = { km: 1000, kg: 1000, gb: 1024, mb: 1, tb: 1024 * 1024, kb: 1 / 1024, m: 1, g: 1, b: 1 / (1024 * 1024) };
      const from = m[2].toLowerCase(), to = m[3].toLowerCase();
      if (!(from in map) || !(to in map)) return null;
      return `= ${v * (map[from] / map[to])} ${to}`;
    },
  },
];

export async function deterministicRun(text: string): Promise<string | null> {
  for (const d of DET) {
    const m = text.match(d.re);
    if (m) {
      const r = d.run(m);
      if (r !== null) return r;
    }
  }
  return null;
}
