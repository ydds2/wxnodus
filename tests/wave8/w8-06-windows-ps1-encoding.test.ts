// tests/wave8/w8-06-windows-ps1-encoding.test.ts — W8-06：CJK .ps1 编码回归
// 契约：任何含中文的 .ps1 必须以 UTF-8 BOM 开头——PowerShell 5.1 按 ANSI（GBK）读无 BOM 的
// UTF-8 文件会把中文变成乱码字节，破坏正则引号配对 → 解析错误（本机实跑 provision 脚本
// 即当场复现：parser error 第 41 行）。BOM 是 PS 5.1 识别 UTF-8 的唯一可靠信号。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walkPs1(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walkPs1(p));
    else if (p.endsWith('.ps1')) out.push(p);
  }
  return out;
}

describe('W8-06 Windows .ps1 编码（CJK 必带 UTF-8 BOM）', () => {
  const files = [...walkPs1(join(ROOT, 'scripts')), ...walkPs1(join(ROOT, 'tests'))];
  const cjk = files.filter(p => /[\u4e00-\u9fff]/.test(readFileSync(p, 'utf8')));

  it('扫描到中文 .ps1 文件（若为 0 则本回归失效——显式失败）', () => {
    expect(cjk.length).toBeGreaterThan(0);
  });

  it.each(cjk.map(p => [p.replace(ROOT + '\\', '').replace(ROOT + '/', ''), p] as const))(
    '%s 以 UTF-8 BOM 开头（PS 5.1 可解析前提）',
    (_name, path) => {
      const b = readFileSync(path);
      expect(b[0]).toBe(0xEF);
      expect(b[1]).toBe(0xBB);
      expect(b[2]).toBe(0xBF);
    },
  );
});
