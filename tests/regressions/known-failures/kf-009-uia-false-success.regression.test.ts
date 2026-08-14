// tests/regressions/known-failures/kf-009-uia-false-success.regression.test.ts — KF-009 迁移绿回归
// 契约：UIA 点击兜底必须真实执行（mouse_event 坐标点击），绝不以 ok:true/method=focus
// 谎报动作已执行（坐标兜底只算中心点不点击 = false success）。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const clickBlock = (): string => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/computer/uia.ts'), 'utf8');
  const start = src.indexOf('click: `');
  const end = src.indexOf('type: `', start);
  return src.slice(start, end > 0 ? end : start + 4000);
};

describe('KF-009 resolved: UIA 点击兜底真实执行，绝不假成功', () => {
  it('click 分支不含 focus 假成功路径', () => {
    expect(clickBlock()).not.toContain('focus');
  });

  it('兜底分支执行真实坐标点击（SetCursorPos + mouse_event 按下/抬起）', () => {
    const block = clickBlock();
    expect(block).toContain('mouse_event');
    expect(block).toContain('SetCursorPos');
    expect(block).toContain('0x0002'); // LEFTDOWN
    expect(block).toContain('0x0004'); // LEFTUP
  });

  it('不可调用元素也绝不返回 ok:true（只有真实动作才 ok）', () => {
    // 契约锚点：兜底成功输出 method=mouse（真实点击），不存在 method=focus 的 ok:true
    // （源文件里 method 值带 PS 反引号转义——断言裸串 mouse/focus 即可）
    const block = clickBlock();
    expect(block).toContain('mouse');
    expect(block).not.toContain('focus');
  });
});
