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
  it('前缀稳定化：now 参数固定时间戳（同 now 输出逐字一致；不同 now 时间行不同）', () => {
    const t1 = new Date(2026, 7, 18, 9, 0, 0);
    const a = buildSystemPrompt({ ...base, now: t1 });
    const b = buildSystemPrompt({ ...base, now: t1 });
    expect(a).toBe(b); // 逐字一致——DeepSeek 前缀缓存命中的前提
    const c = buildSystemPrompt({ ...base, now: new Date(2026, 7, 18, 10, 0, 0) });
    expect(c).not.toBe(a); // 时间变化确实改变输出（证明参数被真实消费）
    expect(a).toContain('09:00'); // zh-CN 环境段含时间
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
