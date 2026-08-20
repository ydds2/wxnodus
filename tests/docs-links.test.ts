// tests/docs-links.test.ts — supremacy 2.3 用户文档三件套链接契约
// 契约：README 引用三件套；三件套文件存在且互相引用；examples.md 中提到的命令全部真实注册
//（文档不撒谎——命令契约与 SLASH 注册表对账）
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SLASH } from '../src/commands/registry.js';

const read = (p: string) => readFileSync(p, 'utf8');

describe('用户文档三件套（docs/getting-started|troubleshooting|examples）', () => {
  const files = {
    readme: read('README.md'),
    gs: read('docs/getting-started.md'),
    ts: read('docs/troubleshooting.md'),
    ex: read('docs/examples.md'),
  };

  it('三件套文件存在且非空', () => {
    for (const f of ['docs/getting-started.md', 'docs/troubleshooting.md', 'docs/examples.md']) {
      expect(existsSync(join(process.cwd(), f)), f).toBe(true);
      expect(readFileSync(f, 'utf8').length).toBeGreaterThan(500);
    }
  });

  it('README 引用三件套（链接契约）', () => {
    for (const f of ['docs/getting-started.md', 'docs/troubleshooting.md', 'docs/examples.md']) {
      expect(files.readme, f).toContain(f);
    }
  });

  it('三件套互相引用（getting-started 指路另两件；另两件回指 getting-started）', () => {
    expect(files.gs).toContain('docs/troubleshooting.md');
    expect(files.gs).toContain('docs/examples.md');
    expect(files.ts).toContain('docs/getting-started.md');
    expect(files.ex).toContain('docs/getting-started.md');
  });

  it('文档中提到的命令全部真实注册（不撒谎契约——抽取 /xxx 与注册表对账）', () => {
    const mentioned = new Set<string>();
    for (const textRaw of [files.gs, files.ts, files.ex]) {
      // 先剥离 docs/<名>.md 路径引用，再只匹配「后跟空格/标点/行尾」的命令形态
      // ——排除 ssh://user@host、data/nodus.db 等非命令斜杠词
      const text = textRaw.replace(/docs\/[a-z0-9-]+\.md/gi, '');
      // 负向后顾排除包名/文件名/CJK 粘连片段（better-sqlite3/sqlite-vec、桌面端/IDE、examples/wire-events.mjs），
      // 同时排除 URL 上下文（https://raw.githubusercontent.com/… 的 //raw、协议后的路径段——前导 / 或 : 即视为 URL），
      // 前瞻限定命令形态（后跟空格/标点/行尾）
      for (const m of text.matchAll(/(?<![a-z0-9-.\u4e00-\u9fff/:])\/[a-z][a-z0-9-]*(?=[\s"'`.,;:)|)])/gi)) {
        const cmd = '/' + m[0].slice(1).toLowerCase();
        if (cmd.startsWith('/<')) continue;
        mentioned.add(cmd);
      }
    }
    // 白名单：文档行文中的非命令斜杠词（测试/示例文件名等）
    const proseOnly = new Set(['/key', '/docs-links', '/wire-events', '/wire-approval-responder']);
    for (const cmd of mentioned) {
      if (proseOnly.has(cmd)) continue;
      expect(SLASH, `文档提到的命令未注册: ${cmd}`).toContain(cmd);
    }
  });
});
