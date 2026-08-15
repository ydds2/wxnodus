// src/wxnodus-ui/theme.tokens.test.ts — 阶段 3：设计 token 合同（语义色完整性）
// 分区展示/uiPrimitives 依赖的语义色必须同时存在于明暗两主题；缺失即编译期 UI 用色无声退化。
import { describe, expect, it } from 'vitest';
import { DARK_THEME, LIGHT_THEME } from './theme.js';

// 语义 token 清单：分区展示（SectionHeader/StatusBadge/单列面板）+ 状态栏 + diff + 审批
// 每类语义独立成 token——成功/失败/警告/审批/用户消息/diff/selection 分离（阶段 3 验收）。
const SEMANTIC_TOKENS = [
  'text', 'muted', 'border', 'primary', 'accent', 'label',
  'ok', 'error', 'warn',
  'diffAdded', 'diffRemoved', 'diffAddedWord', 'diffRemovedWord',
  'statusBg', 'statusFg', 'statusGood', 'statusWarn', 'statusBad', 'statusCritical',
  'selectionBg', 'userBg', 'prompt', 'shellDollar',
] as const;

describe('主题语义 token 合同', () => {
  it('明暗两主题暴露完整语义色集（关键状态不依赖单一颜色通道）', () => {
    for (const t of [DARK_THEME, LIGHT_THEME]) {
      for (const key of SEMANTIC_TOKENS) {
        expect(typeof t.color[key], `${key} 缺失`).toBe('string');
      }
    }
  });

  it('成功/失败/警告三态语义色在主题内互不相同（不依赖颜色也可区分的文字兜底由 StatusBadge 承担）', () => {
    for (const t of [DARK_THEME, LIGHT_THEME]) {
      expect(t.color.ok).not.toBe(t.color.error);
      expect(t.color.error).not.toBe(t.color.warn);
      expect(t.color.warn).not.toBe(t.color.ok);
    }
  });

  it('diff 增删着色与普通文本区分（diff 摘要 +A -D 可读）', () => {
    for (const t of [DARK_THEME, LIGHT_THEME]) {
      expect(t.color.diffAdded).not.toBe(t.color.diffRemoved);
      expect(t.color.diffAdded).not.toBe(t.color.text);
    }
  });
});
