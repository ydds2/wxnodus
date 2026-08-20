// tests/regressions/known-failures/kf-004-personality-persistence.regression.test.ts — KF-004 迁移绿回归
// 契约：settings.personality 必须是已知白名单键（/config set 不再误报未知键），且真实进入消费路径
// （system prompt persona 段）——绝不「写入宣称成功但无消费」的假成功。
import { describe, expect, it } from 'vitest';
import { unknownSettingsKeys } from '../../../src/store/config.js';
import { buildSystemPrompt } from '../../../src/kernel/systemPrompt.js';

const base = { mode: 'smart' as const, cwd: 'C:/work', model: 'unconfigured', hasImageIn: false };

describe('KF-004 resolved: personality 键白名单化 + 真实消费', () => {
  it('personality 是已知设置键（不再误报未知键）', () => {
    expect(unknownSettingsKeys({ personality: 'concise' })).toEqual([]);
    expect(unknownSettingsKeys({ personality: 'concise', model: 'x' })).toEqual([]);
    expect(unknownSettingsKeys({ notReal: 1 })).toEqual(['notReal']);
  });

  it('persona 进入系统提示（真实消费路径）', () => {
    const withPersona = buildSystemPrompt({ ...base, persona: 'concise' });
    expect(withPersona).toContain('concise');
    const without = buildSystemPrompt(base);
    expect(without).not.toContain('persona');
  });

  it('lang=en 时 persona 段标题英文（控制文本不混中文）', () => {
    const en = buildSystemPrompt({ ...base, persona: 'concise', lang: 'en', locale: 'en' });
    expect(en).toContain('concise');
    expect(en).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
