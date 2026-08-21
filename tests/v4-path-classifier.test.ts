// tests/v4-path-classifier.test.ts — V4 P1-8：系统路径分类器别名归一化（win32 实证）
// 8.3 短名 / 尾点 / 全正斜杠三类别名不再逃过 system-* 强确认（此前降级 other 普通审批）。
import { describe, it, expect } from 'vitest';
import { classifyWindowsPath } from '../src/infrastructure/fs/windowsPathClassifier.js';

const BS = String.fromCharCode(92);

describe('V4 P1-8 路径分类器归一化', { skip: process.platform !== 'win32' }, () => {
  const env = { WINDIR: process.env.WINDIR ?? 'C:' + BS + 'Windows', ProgramFiles: process.env.ProgramFiles };

  it('尾点别名：C:' + BS + 'Windows.' + BS + 'system32' + BS + 'x → system-windows（此前逃过降 other）', () => {
    const r = classifyWindowsPath('C:' + BS + 'Windows.' + BS + 'system32' + BS + 'x', { env });
    expect(r.class).toBe('system-windows');
  });

  it('全正斜杠别名：C:/Windows/System32/x → system-windows（此前逃过）', () => {
    const r = classifyWindowsPath('C:/Windows/System32/x', { env });
    expect(r.class).toBe('system-windows');
  });

  it('8.3 短名别名：PROGRA~1 → system-programs（realpath 展开命中）', () => {
    const r = classifyWindowsPath('C:' + BS + 'PROGRA~1' + BS + 'whatever.dll', { env });
    expect(r.class).toBe('system-programs');
  });

  it('普通路径零回归：TEMP 等非系统目录仍 ordinary/other（不误伤）', () => {
    const r = classifyWindowsPath(process.env.TEMP ?? 'C:' + BS + 'temp', { env, workspaceRoot: process.env.TEMP ?? 'C:' + BS + 'temp' });
    expect(['ordinary', 'other', 'workspace']).toContain(r.class); // TEMP 自作 workspace → workspace 类（正确语义）
  });
});
