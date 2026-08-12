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
  it('提取已配置事件的本地命令（12 类事件均可配置）', () => {
    const cfg = hooksFromConfig({ hooks: { preToolUse: 'echo DENY', stop: 'echo done', userPromptSubmit: 'echo hi', postToolUse: 'echo ok', sessionStart: 'echo s', notification: 'echo n', bogus: 'echo x' } });
    expect(cfg.preToolUse).toBe('echo DENY');
    expect(cfg.stop).toBe('echo done');
    expect(cfg.userPromptSubmit).toBe('echo hi');
    expect(cfg.postToolUse).toBe('echo ok');
    expect(cfg.sessionStart).toBe('echo s');
    expect(cfg.notification).toBe('echo n');
    expect(Object.keys(cfg).sort()).toEqual([...HOOK_EVENTS].filter(e => ['preToolUse', 'stop', 'userPromptSubmit', 'postToolUse', 'sessionStart', 'notification'].includes(e)).sort());
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

// ── P3b：截断 / 崩溃容错 / 事件覆盖 ──
describe('runHook 边界', () => {
  it('长输出截断至 4000 字符', () => {
    const out = runHook('node -e "console.log(\\"x\\".repeat(9000))"', 'stop', {});
    expect(out.length).toBeLessThanOrEqual(4000);
  });
  // A25：命令失败如实返回失败信息（此前静默空串——配置了 hooks 的用户
  // 以为 hook 生效了，实际从未执行）
  it('命令崩溃返回失败说明（不抛、不静默）', () => {
    expect(runHook('node -e "process.exit(3)"', 'preToolUse', {})).toContain('[hook:preToolUse] 执行失败');
    expect(runHook('不存在的命令xyz', 'preToolUse', {})).toContain('[hook:preToolUse] 执行失败');
  });
  it('HOOK_EVENTS 枚举 12 类', () => {
    expect(HOOK_EVENTS).toEqual(['userPromptSubmit', 'preToolUse', 'postToolUse', 'stop', 'sessionStart', 'sessionEnd', 'preCompact', 'postCompact', 'subagentStart', 'subagentStop', 'postToolUseFailure', 'notification']);
  });
});

describe('createHookRunner 事件覆盖', () => {
  it('userPromptSubmit 与 postToolUse 均触发（经 system.notice）', async () => {
    const bus = createEventBus(dir);
    const notices: string[] = [];
    bus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? e?.text ?? '')));
    const settings: Record<string, any> = {
      hooks: {
        userPromptSubmit: 'node -e "console.log(process.env.WXNODUS_HOOK_EVENT)"',
        postToolUse: 'node -e "console.log(process.env.WXNODUS_HOOK_EVENT)"',
      },
    };
    const runner = createHookRunner(() => settings, bus);
    runner.userPromptSubmit('你好', 's1');
    runner.postToolUse('bash', '工具输出文本');
    expect(notices.some(t => t.includes('userPromptSubmit'))).toBe(true);
    expect(notices.some(t => t.includes('postToolUse'))).toBe(true);
  });
  it('hook 崩溃不阻断主流程（放行）', async () => {
    const bus = createEventBus(dir);
    const runner = createHookRunner(() => ({ hooks: { preToolUse: 'node -e "process.exit(9)"' } }), bus);
    const r = await runner.preToolUse('bash', {});
    expect(r).toBe(true); // 崩溃无输出 → 非 DENY → 放行
  });
});

// ── P1-1：12 类事件扩充 ──
describe('12 类事件扩充', () => {
  it('HOOK_EVENTS 含 12 类', () => {
    expect(HOOK_EVENTS).toHaveLength(12);
    for (const ev of ['sessionStart', 'sessionEnd', 'preCompact', 'postCompact', 'subagentStart', 'subagentStop', 'postToolUseFailure', 'notification']) {
      expect(HOOK_EVENTS).toContain(ev);
    }
  });
  it('sessionStart/sessionEnd/subagent 事件经 notice 触发', async () => {
    const bus = createEventBus(dir);
    const notices: string[] = [];
    bus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? e?.text ?? '')));
    const runner = createHookRunner(() => ({
      hooks: {
        sessionStart: 'node -e "console.log(process.env.WXNODUS_HOOK_EVENT)"',
        sessionEnd: 'node -e "console.log(process.env.WXNODUS_HOOK_EVENT)"',
        subagentStart: 'node -e "console.log(process.env.WXNODUS_HOOK_EVENT)"',
        subagentStop: 'node -e "console.log(process.env.WXNODUS_HOOK_EVENT)"',
        notification: 'node -e "console.log(process.env.WXNODUS_HOOK_EVENT)"',
      },
    }), bus);
    runner.sessionStart('s1');
    runner.sessionEnd({ ok: true, turns: 2 });
    runner.subagentStart('目标');
    runner.subagentStop({ ok: true, output: 'o', turns: 1 });
    runner.notification('cron', '定时任务完成');
    expect(notices.some(t => t.includes('sessionStart'))).toBe(true);
    expect(notices.some(t => t.includes('sessionEnd'))).toBe(true);
    expect(notices.some(t => t.includes('subagentStart'))).toBe(true);
    expect(notices.some(t => t.includes('subagentStop'))).toBe(true);
    expect(notices.some(t => t.includes('notification'))).toBe(true);
  });
  it('preCompact 输出 BLOCK 阻止压缩；postCompact 携带 token 数', () => {
    const bus = createEventBus(dir);
    const runner = createHookRunner(() => ({
      hooks: {
        preCompact: 'node -e "console.log(\'BLOCK: 会话未完成\')"',
        postCompact: 'node -e "console.log(process.env.WXNODUS_HOOK_DATA)"',
      },
    }), bus);
    expect(runner.preCompact('auto: 100/100')).toBe(true);
    // 非 BLOCK → 放行
    const runner2 = createHookRunner(() => ({ hooks: { preCompact: 'node -e "console.log(\'OK\')"' } }), bus);
    expect(runner2.preCompact('auto')).toBe(false);
    expect(() => runner.postCompact(1000, 300)).not.toThrow();
  });
  it('postToolUseFailure 触发', () => {
    const bus = createEventBus(dir);
    const runner = createHookRunner(() => ({
      hooks: { postToolUseFailure: 'node -e "console.log(process.env.WXNODUS_HOOK_EVENT)"' },
    }), bus);
    expect(() => runner.postToolUseFailure('bash', '退出码 1')).not.toThrow();
  });
});
