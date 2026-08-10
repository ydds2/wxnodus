// tests/kernel-hooks.test.ts — L2-6 生命周期 Hooks：配置解析/命令执行/DENY 拦截/超时
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooksFromConfig, runHook, createHookRunner, HOOK_EVENTS } from '../src/kernel/hooks.js';
import { createEventBus } from '../src/kernel/events.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-hooks-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// 跨平台测试命令：node -e 回显环境变量（避免 PowerShell/bash 差异）
const echoCmd = (varName: string) =>
  process.platform === 'win32'
    ? `node -e "console.log(process.env.${varName})"`
    : `node -e "console.log(process.env.${varName})"`;

describe('hooksFromConfig 配置解析', () => {
  it('空配置返回空对象', () => {
    expect(hooksFromConfig(undefined)).toEqual({});
    expect(hooksFromConfig({ hooks: null })).toEqual({});
    expect(hooksFromConfig({ hooks: { preToolUse: '' } })).toEqual({});
  });
  it('提取四个事件的本地命令', () => {
    const cfg = hooksFromConfig({ hooks: { preToolUse: 'echo DENY', stop: 'echo done', userPromptSubmit: 'echo hi', postToolUse: 'echo ok', bogus: 'echo x' } });
    expect(cfg.preToolUse).toBe('echo DENY');
    expect(cfg.stop).toBe('echo done');
    expect(cfg.userPromptSubmit).toBe('echo hi');
    expect(cfg.postToolUse).toBe('echo ok');
    expect(Object.keys(cfg).sort()).toEqual(HOOK_EVENTS.sort());
  });
});

describe('runHook 命令执行', () => {
  it('注入事件名与数据环境变量', () => {
    const out = runHook(echoCmd('WXNODUS_HOOK_EVENT'), 'preToolUse', { tool: 'bash' });
    expect(out).toBe('preToolUse');
  });
  it('输出 DENY 开头可被识别为拦截', () => {
    const out = runHook('node -e "console.log(\'DENY: 安全规则\')"', 'preToolUse', {});
    expect(out.startsWith('DENY')).toBe(true);
  });
  it('超时不挂死（10s 上限内快速失败）', () => {
    const t0 = Date.now();
    runHook('node -e "setTimeout(()=>{}, 60000)"', 'stop', {});
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});

describe('createHookRunner 集成', () => {
  it('preToolUse DENY 真实拦截', async () => {
    const bus = createEventBus(dir);
    let settings: Record<string, any> = { hooks: { preToolUse: 'node -e "console.log(\'DENY: 规则\')"' } };
    const runner = createHookRunner(() => settings, bus);
    expect(await runner.preToolUse('bash', {})).toBe(false);
    settings = { hooks: { preToolUse: 'node -e "console.log(\'ALLOW\')"' } };
    expect(await runner.preToolUse('bash', {})).toBe(true);
  });
  it('stop hook 触发且失败不抛', () => {
    const bus = createEventBus(dir);
    const runner = createHookRunner(() => ({ hooks: { stop: 'node -e "console.log(\'finished\')"' } }), bus);
    expect(() => runner.stop({ ok: true, turns: 2 })).not.toThrow();
  });
  it('未配置时全部跳过（零副作用）', async () => {
    const bus = createEventBus(dir);
    const runner = createHookRunner(() => ({}), bus);
    expect(await runner.preToolUse('bash', {})).toBe(true);
    expect(() => runner.userPromptSubmit('hi', 's1')).not.toThrow();
  });
});
