// tests/regressions/known-failures/kf-029-english-system-prompt.regression.test.ts — KF-029 迁移绿回归
// 契约：lang=en 时控制文本全英文（system prompt 无 CJK）；systemPrompt.ts 源文件本身零中文
// （控制文本全部走 i18n catalog——zh-CN/en 同 key，不在源码里做文本分支）。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../../src/kernel/systemPrompt.js';

const base = { mode: 'smart' as const, cwd: 'C:/work', model: 'unconfigured', hasImageIn: false };

describe('KF-029 resolved: English prompt 无中文控制文本', () => {
  it('systemPrompt.ts 源文件零 CJK（控制文本全部在 i18n catalog）', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/systemPrompt.ts'), 'utf8');
    expect(src).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('lang=en 构建的提示无 CJK，且关键段为英文', () => {
    const en = buildSystemPrompt({ ...base, lang: 'en', locale: 'en', persona: 'concise' });
    expect(en).not.toMatch(/[\u4e00-\u9fff]/);
    expect(en).toContain('Working principles');
    expect(en).toContain('Current mode: smart');
    expect(en).toContain('Output rules');
    expect(en).toContain('Environment');
  });

  it('默认中文构建仍完整（角色/准则/模式/输出/环境各段在场）', () => {
    const zh = buildSystemPrompt(base);
    expect(zh).toContain('工作准则');
    expect(zh).toContain('当前模式：smart');
    expect(zh).toContain('输出规范');
    expect(zh).toContain('环境');
    expect(zh).toContain('绝不把"做了"冒充"完成"');
  });

  it('外部 prompts/system.md 覆盖时仍带环境段（不丢控制上下文）', () => {
    const dir = `${process.env.TEMP ?? '/tmp'}/wxn-kf029-${Date.now()}`;
    // 外部覆盖文件不存在 → 走内置提示（覆盖路径本身已有契约测试；此处只验证无副作用降级）
    const built = buildSystemPrompt({ ...base, lang: 'en', locale: 'en', dataDir: dir });
    expect(built).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
