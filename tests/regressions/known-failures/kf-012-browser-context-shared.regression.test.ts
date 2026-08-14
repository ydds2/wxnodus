// tests/regressions/known-failures/kf-012-browser-context-shared.regression.test.ts — KF-012 迁移绿回归
// 契约：浏览器上下文按 sessionId 分槽（sessions Map），绝不模块级共享 browser/page 单例。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/browser.ts'), 'utf8');

describe('KF-012 resolved: 浏览器上下文按会话隔离', () => {
  it('browser.ts 以 sessionId 分槽（sessions Map + pageOf），无模块级 browser/page 单例', () => {
    const s = src();
    expect(s).toContain('sessions');
    expect(s).toContain('pageOf');
    expect(s).toContain('sessionId');
    expect(s).not.toMatch(/^let browser:/m);
    expect(s).not.toMatch(/^let page:/m);
  });

  it('browserClose 只关本会话槽（不误杀其他会话）', () => {
    const s = src();
    const closeBody = s.slice(s.indexOf('export function browserClose'), s.indexOf('export interface BrowserToolResult'));
    expect(closeBody).toContain('sessions.get(sessionId)');
    expect(closeBody).toContain('sessions.delete(sessionId)');
  });

  it('全部 browser_* 工具入口带 sessionId 槽位（缺省 default 兼容单会话）', () => {
    const s = src();
    for (const fn of ['browserNavigate', 'browserClick', 'browserType', 'browserScreenshot', 'browserSnapshot', 'browserWait', 'browserClose']) {
      expect(s).toContain(`${fn}(`);
    }
    expect(s).toContain("sessionId = 'default'");
  });
});
