// tests/kernel-systemPrompt.test.ts — 系统提示：/lang 生效 + 外部 prompt 文件覆盖
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, type SysPromptOpts } from '../src/kernel/systemPrompt.js';

const base: SysPromptOpts = { mode: 'smart', cwd: '/tmp/proj', model: 'deepseek-v4-flash', hasImageIn: false };

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-prompt-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('buildSystemPrompt', () => {
  it('默认中文输出规范', () => {
    const s = buildSystemPrompt(base);
    expect(s).toContain('用中文回复');
    expect(s).toContain('工作目录：/tmp/proj');
    expect(s).toContain('当前模式：smart');
  });
  it('/lang en 时输出规范切英文（环境段同步 en-US 时间格式）', () => {
    const s = buildSystemPrompt({ ...base, lang: 'en' });
    expect(s).toContain('Reply in English');
    expect(s).not.toContain('用中文回复');
  });
  it('外部 prompts/system.md 存在时整体替换内置提示（环境段仍追加）', () => {
    const d = tmp();
    mkdirSync(join(d, 'prompts'), { recursive: true });
    writeFileSync(join(d, 'prompts', 'system.md'), '你是我的专属代码管家。\n## 铁律\n1. 先写测试。', 'utf8');
    const s = buildSystemPrompt({ ...base, dataDir: d });
    expect(s).toContain('你是我的专属代码管家');
    expect(s).toContain('先写测试');
    expect(s).not.toContain('工具优先');
    expect(s).toContain('## 环境'); // 环境段仍注入
    expect(s).toContain('工作目录：/tmp/proj');
  });
  it('无 prompts/system.md 时回退内置', () => {
    const d = tmp();
    const s = buildSystemPrompt({ ...base, dataDir: d });
    expect(s).toContain('工具优先');
  });
  it('空的外部文件视为未覆盖', () => {
    const d = tmp();
    mkdirSync(join(d, 'prompts'), { recursive: true });
    writeFileSync(join(d, 'prompts', 'system.md'), '   ', 'utf8');
    expect(buildSystemPrompt({ ...base, dataDir: d })).toContain('工具优先');
  });
});
