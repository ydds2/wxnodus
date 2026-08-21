// tests/kernel-projectRules.test.ts — 生态规范文件链：优先级/缓存/预算
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectRules, RULES_FILES } from '../src/kernel/projectRules.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-rules-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

describe('loadProjectRules 规范文件链', () => {
  it('无任何规范文件 → null', () => {
    expect(loadProjectRules(tmp())).toBeNull();
  });
  it('优先级：AGENTS.md > CLAUDE.md > GEMINI.md > .cursorrules', () => {
    const d = tmp();
    writeFileSync(join(d, 'CLAUDE.md'), '# Claude 规范');
    writeFileSync(join(d, 'GEMINI.md'), '# Gemini 规范');
    writeFileSync(join(d, '.cursorrules'), 'cursor rules');
    const r = loadProjectRules(d);
    expect(r).toMatchObject({ file: 'CLAUDE.md', text: '# Claude 规范' });
    // AGENTS.md 出现后优先
    writeFileSync(join(d, 'AGENTS.md'), '# AGENTS 规范');
    const r2 = loadProjectRules(d);
    expect(r2?.file).toBe('AGENTS.md');
    expect(r2?.text).toContain('AGENTS 规范');
  });
  it('RULES_FILES 顺序正确（含 .clinerules/.roomodes）', () => {
    expect(RULES_FILES).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.clinerules', '.roomodes']);
  });
  it('超预算（>32KiB）跳过该文件，继续下一个', () => {
    const d = tmp();
    writeFileSync(join(d, 'AGENTS.md'), 'x'.repeat(40000));
    writeFileSync(join(d, 'CLAUDE.md'), '# 小规范');
    const r = loadProjectRules(d);
    expect(r?.file).toBe('CLAUDE.md');
  });
  it('重复读取始终返回最新内容（无缓存）', () => {
    const d = tmp();
    writeFileSync(join(d, 'CLAUDE.md'), 'v1');
    expect(loadProjectRules(d)?.text).toBe('v1');
    writeFileSync(join(d, 'CLAUDE.md'), 'v2');
    expect(loadProjectRules(d)?.text).toBe('v2');
  });
  it('≤32KiB 的文件原样返回（不截断）', () => {
    const d = tmp();
    writeFileSync(join(d, 'CLAUDE.md'), 'c'.repeat(30000));
    const r = loadProjectRules(d);
    expect(r?.text.length).toBe(30000);
  });
});

// V4 P4-1：分层加载（全局 > 仓库根 > 子目录，向上 4 层）+ 上限可配 + @file 导入
describe('loadProjectRules 分层加载（P4-1）', () => {
  it('全局层优先：dataDir 有规范 → layer=global（即使 cwd 也有）', () => {
    const data = tmp();
    const cwd = tmp();
    writeFileSync(join(data, 'AGENTS.md'), '# 全局规范');
    writeFileSync(join(cwd, 'AGENTS.md'), '# 仓库规范');
    const r = loadProjectRules(cwd, { dataDir: data });
    expect(r).toMatchObject({ file: 'AGENTS.md', text: '# 全局规范', layer: 'global' });
  });

  it('cwd 本层命中 → layer=subdir（子目录覆盖仓库根）', () => {
    const root = tmp();
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '# 仓库根规范');
    writeFileSync(join(sub, 'AGENTS.md'), '# 子目录规范');
    const r = loadProjectRules(sub);
    expect(r).toMatchObject({ text: '# 子目录规范', layer: 'subdir' });
  });

  it('父目录命中 → layer=repo（子目录无文件时向上）', () => {
    const root = tmp();
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# 仓库根规范');
    const r = loadProjectRules(sub);
    expect(r).toMatchObject({ file: 'CLAUDE.md', text: '# 仓库根规范', layer: 'repo' });
  });

  it('向上最多 4 层（第 5 层不注入）', () => {
    const root = tmp();
    const deep = join(root, 'l1', 'l2', 'l3', 'l4'); // depth 0..3 可达，root=第 5 层
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '# 太远不该出现');
    expect(loadProjectRules(deep)).toBeNull();
    // 第 4 层（depth=3）仍可达
    const l3 = join(root, 'l1', 'l2', 'l3');
    writeFileSync(join(l3, 'AGENTS.md'), '# 第4层可见');
    expect(loadProjectRules(deep)).toMatchObject({ text: '# 第4层可见', layer: 'repo' });
  });

  it('projectDocMaxBytes 上限可配（超限跳过）', () => {
    const d = tmp();
    writeFileSync(join(d, 'AGENTS.md'), 'x'.repeat(200));
    writeFileSync(join(d, 'CLAUDE.md'), '# 小规范');
    const r = loadProjectRules(d, { maxBytes: 100 });
    expect(r?.file).toBe('CLAUDE.md');
  });

  it('@file 导入展开（相对规则文件基准，递归+循环防护）', () => {
    const d = tmp();
    const lib = join(d, 'lib');
    mkdirSync(lib);
    writeFileSync(join(lib, 'style.md'), '# 样式细节');
    writeFileSync(join(d, 'AGENTS.md'), '# 主规范\n@./lib/style.md\n@./missing.md\n');
    const r = loadProjectRules(d);
    expect(r?.text).toContain('# 主规范');
    expect(r?.text).toContain('# 样式细节'); // @ 导入已展开
    expect(r?.text).toContain('[导入 ./missing.md 不存在——已跳过]');
  });

  it('@file 循环引用防护（a 导入 b、b 导入 a → 跳过不挂死）', () => {
    const d = tmp();
    writeFileSync(join(d, 'a.md'), '# A\n@./b.md\n');
    writeFileSync(join(d, 'b.md'), '# B\n@./a.md\n');
    writeFileSync(join(d, 'AGENTS.md'), '# 主\n@./a.md\n');
    const r = loadProjectRules(d);
    expect(r?.text).toContain('# A');
    expect(r?.text).toContain('# B');
    expect(r?.text).toContain('[循环引用已跳过]');
  });
});
