// tests/kernel-mentions.test.ts — @提及展开（Claude Code @mention 同款语义）
import { describe, it, expect } from 'vitest';
import { expandMentions } from '../src/kernel/mentions.js';

const FILES: Record<string, string> = {
  'src/a.ts': 'export const a = 1;\n',
  'README.md': '# 标题\n正文',
  'data.bin': 'PK\u0003\u0004\x00binary',
  'sub/b.txt': 'hello b',
};

const readFile = (p: string): Buffer | null => {
  // expandMentions 以绝对路径调用 readFile——夹具按相对键存储，剥掉 cwd 前缀回查
  const rel = p.replace(/^C:[\\/]+proj[\\/]+/i, '').replace(/\\/g, '/');
  return rel in FILES ? Buffer.from(FILES[rel]!, 'utf8') : null;
};

const expand = (text: string, overrides: Partial<Parameters<typeof expandMentions>[1]> = {}) =>
  expandMentions(text, { cwd: 'C:\\proj', readFile, maxFileBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024, ...overrides });

describe('expandMentions 提及展开', () => {
  it('存在的 @path → 追加文件内容块；原 token 保留在正文', () => {
    const r = expand('看下 @src/a.ts 的导出');
    expect(r.text).toContain('看下 @src/a.ts 的导出');
    expect(r.text).toContain('（提及文件内容）');
    expect(r.text).toContain('src/a.ts');
    expect(r.text).toContain('export const a = 1;');
    expect(r.mentions).toEqual([{ path: 'src/a.ts', bytes: 20, truncated: false }]);
    expect(r.missing).toEqual([]);
  });

  it('多提及全部展开；不存在的路径不动正文并入 missing', () => {
    const r = expand('@README.md 与 @src/a.ts 与 @ghost.md');
    expect(r.text).toContain('@ghost.md'); // 不存在的 token 原文保留
    expect(r.text).not.toContain('[提及文件不存在');
    expect(r.missing).toEqual(['ghost.md']);
    expect(r.mentions.map(m => m.path)).toEqual(['README.md', 'src/a.ts']);
  });

  it('无路径字符的 @词（散文中 @人名）不视为提及——零文件读取', () => {
    const r = expand('@张三 你好 @team');
    expect(r.text).toBe('@张三 你好 @team');
    expect(r.mentions).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('二进制文件（含 NUL）跳过——不注入乱码，入 skipped', () => {
    const r = expand('打开 @data.bin');
    expect(r.text).toBe('打开 @data.bin');
    expect(r.mentions).toEqual([]);
    expect(r.skipped).toEqual(['data.bin']);
  });

  it('单文件/总字节上限截断（诚实 truncated 标记）', () => {
    const big = 'x'.repeat(500);
    const files: Record<string, string> = { 'big.txt': big, 'b2.txt': big };
    const r = expandMentions('@big.txt @b2.txt', {
      cwd: 'C:\\proj',
      readFile: p => {
        const rel = p.replace(/^C:[\\/]+proj[\\/]+/i, '').replace(/\\/g, '/');
        return rel in files ? Buffer.from(files[rel]!) : null;
      },
      maxFileBytes: 100,
      maxTotalBytes: 150,
    });
    expect(r.mentions[0]!.truncated).toBe(true);
    expect(r.text).not.toContain('x'.repeat(500));
  });

  it('无 @ → 原样返回，零展开', () => {
    const r = expand('普通提问，无提及');
    expect(r.text).toBe('普通提问，无提及');
    expect(r.mentions).toEqual([]);
  });
});
