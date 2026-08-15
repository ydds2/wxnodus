// tests/wave8/w8-04-memory-capacity-claim.test.ts — W8-04：黑洞引擎容量表述背书
// 契约：对外表述必须诚实区分「记忆容量」（archival/recall 不设上限，百万字级可证）
// 与「模型上下文窗口」（每轮送入模型受 64k token 上限约束，超压自动压缩）——
// 不得把「百万」解读为模型获得百万 token 上下文窗口。1M 级容量证据由
// `npm run evidence:memory-capacity` 本机实跑产出（artifacts/release-evidence receipt）。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('W8-04 黑洞引擎容量表述（诚实背书）', () => {
  it('README 副线 1：明确「记忆容量 ≠ 模型上下文窗口」并声明 64k 窗口约束', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const line = readme.split('\n').find(l => l.startsWith('**副线 1：黑洞引擎**'));
    expect(line).toBeTruthy();
    expect(line).toContain('记忆容量 ≠ 模型上下文窗口');
    expect(line).toContain('64k');
  });

  it('memory.ts 头注释：三层存储无上限 + 模型窗口 64k 上限（与实现一致）', () => {
    const src = readFileSync(join(ROOT, 'src', 'kernel', 'memory.ts'), 'utf8');
    expect(src).toContain('archival（FTS5+向量 无限）');
    expect(src).toContain('recall（全量永不删）');
    // 头注释不得再出现歧义「百万上下文」短句（须带窗口限定）
    const header = src.slice(0, src.indexOf('// ──'));
    expect(header).not.toContain('百万上下文');
  });

  it('容量证据入口存在（npm run evidence:memory-capacity 真实 1M 级背书）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['evidence:memory-capacity']).toContain('scripts/evidence-memory-capacity.mjs');
  });
});
