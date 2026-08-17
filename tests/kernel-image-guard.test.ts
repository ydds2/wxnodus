// tests/kernel-image-guard.test.ts — 图片注入能力门（image_url 400 防御纵深）
// 背景：ZCode 真实事故——deepseek-v4-pro（纯文本模型）收到历史中 image_url parts
// 返回 400 unknown variant `image_url`。本测试锁定：
//  ① 图片策略矩阵（无图零视觉调用 / 视觉模型注入 / 文本模型走识别）
//  ② hasImageIn 名称启发式（档案自定义视觉模型识别；未知默认文本——安全方向）
//  ③ 历史 parts 文本化（contentToText 绝不让 dataUrl 进 API 消息）
import { describe, it, expect } from 'vitest';
import { hasImageIn, imageStrategy } from '../src/kernel/providers.js';
import { contentToText } from '../src/kernel/memory.js';

describe('图片注入策略矩阵（imageStrategy）', () => {
  it('无图 → none（零视觉调用——不自动调用 GLM）', () => {
    expect(imageStrategy('deepseek-v4-pro', 0)).toEqual({ kind: 'none' });
    expect(imageStrategy('glm-4v-flash', 0)).toEqual({ kind: 'none' });
    expect(imageStrategy('', 0)).toEqual({ kind: 'none' });
    expect(imageStrategy(undefined, -1)).toEqual({ kind: 'none' });
  });

  it('目录内视觉模型 → inject（parts 直入消息）', () => {
    expect(imageStrategy('glm-4v-flash', 1)).toEqual({ kind: 'inject' });
  });

  it('纯文本模型（deepseek/kimi/离线）→ describe（走视觉通道先识别）', () => {
    expect(imageStrategy('deepseek-v4-pro', 1)).toEqual({ kind: 'describe' });
    expect(imageStrategy('deepseek-chat', 2)).toEqual({ kind: 'describe' });
    expect(imageStrategy('kimi-k3', 1)).toEqual({ kind: 'describe' });
    expect(imageStrategy('offline:Qwen2.5-3B', 1)).toEqual({ kind: 'describe' });
  });

  it('未知档案模型 → describe（安全方向：宁识别不注入）', () => {
    expect(imageStrategy('relay-custom-model-1', 3)).toEqual({ kind: 'describe' });
  });
});

describe('hasImageIn 名称启发式（档案自定义模型）', () => {
  it('目录判定优先：glm-4v-flash true / deepseek false', () => {
    expect(hasImageIn('glm-4v-flash')).toBe(true);
    expect(hasImageIn('deepseek-v4-pro')).toBe(false);
    expect(hasImageIn('deepseek-chat')).toBe(false);
  });

  it('主流视觉家族名称命中', () => {
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'qwen2.5-vl-7b', 'qwen-vl-max', 'gemini-2.0-flash', 'claude-3-5-sonnet', 'glm-4v-plus', 'moondream2', 'llava-13b', 'internvl2-8b']) {
      expect(hasImageIn(id)).toBe(true);
    }
  });

  it('未知/纯文本名称默认 false（绝不误注入触发 400）', () => {
    for (const id of ['', undefined, null, 'deepseek-v4-pro', 'kimi-k2.7', 'qwen2.5-coder-32b', 'relay-7b', 'random-model-x']) {
      expect(hasImageIn(id)).toBe(false);
    }
  });
});

describe('历史 parts 文本化（contentToText）', () => {
  it('image_url parts → [图片] 占位，dataUrl 不进入输出', () => {
    const parts = [
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } },
      { type: 'text', text: '有什么问题？' },
    ];
    const out = contentToText(parts);
    expect(out).toContain('看看这张图');
    expect(out).toContain('[图片]');
    expect(out).toContain('有什么问题？');
    expect(out).not.toContain('base64');
    expect(out).not.toContain('image_url');
    expect(out).not.toContain('data:image');
  });

  it('字符串原样 / null → 空串（不抛错）', () => {
    expect(contentToText('纯文本')).toBe('纯文本');
    expect(contentToText(null)).toBe('');
    expect(contentToText(undefined)).toBe('');
  });
});
