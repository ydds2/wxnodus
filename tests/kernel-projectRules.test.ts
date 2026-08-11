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
    expect(r).toEqual({ file: 'CLAUDE.md', text: '# Claude 规范' });
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
