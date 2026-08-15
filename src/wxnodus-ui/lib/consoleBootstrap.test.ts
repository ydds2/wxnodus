// src/wxnodus-ui/lib/consoleBootstrap.test.ts — W8-21：PS 控制台引导（VT 开启 + QuickEdit 关闭 + CPR 探测）
// 平台无关可注入：runner（PS spawn 假件）/ probe（假 stdin/stdout）/ timeout 全可注入。
// 契约：现代信号零 PS 调用；conhost 候选走「PS 开 VT → CPR 探测 → 诚实结论」；失败 → no-vt + 恢复 + 指引。
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapConsoleForTui, noVtGuidance, probeVtCpr, PS_ENABLE, PS_RESTORE, runConsoleModeScript,
  type ConsoleModeRunner,
} from './consoleBootstrap.js';

const win = { platform: 'win32', tty: true };
type FakeIn = EventEmitter & { isTTY: boolean; pause: () => void; resume: () => void };
type FakeOut = EventEmitter & { isTTY: boolean; write: (chunk: string) => boolean };
type StreamIo = { stdin: NodeJS.ReadStream & { isTTY?: boolean }; stdout: NodeJS.WriteStream & { isTTY?: boolean } };
const stdinOf = (): FakeIn => Object.assign(new EventEmitter(), { isTTY: true, pause: vi.fn(), resume: vi.fn() });
const stdoutOf = (): FakeOut => Object.assign(new EventEmitter(), { isTTY: true, write: vi.fn(() => true) });
const ioOf = (stdin = stdinOf(), stdout = stdoutOf()): StreamIo => ({ stdin, stdout } as unknown as StreamIo);

const okRunner: ConsoleModeRunner = {
  run: (script) => script.includes('__MODE__')
    ? { ok: true, restoreScript: script }
    : { ok: true, originalInputMode: 7, quickEditDisabled: true },
};

describe('W8-21 PS 控制台引导', () => {
  it('源锚点：PS_ENABLE 对两个句柄 SetConsoleMode（输出开 VT、输入关 QuickEdit/行/回显）', () => {
    expect(PS_ENABLE).toContain('SetConsoleMode');
    expect(PS_ENABLE).toContain('GetStdHandle(-11)');
    expect(PS_ENABLE).toContain('GetStdHandle(-10)');
    expect(PS_RESTORE).toContain('SetConsoleMode');
  });

  it('runConsoleModeScript：解析 PS 写回的 OK <orig> <final>；quickEditDisabled 以终态核验（绝不假设）', () => {
    const writeOut = (spawnImpl: ReturnType<typeof vi.fn>) => {
      spawnImpl.mockImplementation((_args: string[], env: NodeJS.ProcessEnv) => {
        writeFileSync(env.WXNODUS_MODE_OUT as string, 'OK 7 135', 'utf8');
        return { status: 0 };
      });
    };
    const spawnImpl = vi.fn();
    writeOut(spawnImpl);
    const good = runConsoleModeScript(PS_ENABLE, {}, spawnImpl as never);
    expect(good.ok).toBe(true);
    expect(good.originalInputMode).toBe(7);
    expect(good.quickEditDisabled).toBe(true); // 135=0x87，bit6 清零 → QuickEdit 已关（终态核验）

    const spawnImplBad = vi.fn();
    writeOut(spawnImplBad);
    spawnImplBad.mockImplementation((_args: string[], env: NodeJS.ProcessEnv) => {
      writeFileSync(env.WXNODUS_MODE_OUT as string, 'OK 7 199', 'utf8');
      return { status: 0 };
    });
    const notDisabled = runConsoleModeScript(PS_ENABLE, {}, spawnImplBad as never);
    expect(notDisabled.quickEditDisabled).toBe(false); // 199=0xC7，bit6 置位 → QuickEdit 仍在

    const fail = runConsoleModeScript(PS_ENABLE, {}, (() => ({ status: 1 })) as never);
    expect(fail.ok).toBe(false);
  });

  it('probeVtCpr：写入 \\x1b[?6n；收到 CPR 应答 → true；超时 → false', async () => {
    const stdin = stdinOf();
    const stdout = stdoutOf();
    const pending = probeVtCpr(stdin as unknown as StreamIo['stdin'], stdout as unknown as StreamIo['stdout'], 30);
    expect(String((stdout.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('\x1b[?6n');
    expect(await pending).toBe(false);
    const reply = probeVtCpr(stdin as unknown as StreamIo['stdin'], stdout as unknown as StreamIo['stdout'], 500);
    stdin.emit('data', Buffer.from('\x1b[12;34R'));
    expect(await reply).toBe(true);
  });

  it('现代信号 → modern，零 PS 调用；conhost + PS 成功 + 探测应答 → cmd（restore 可退）', async () => {
    const spyRunner: ConsoleModeRunner = { run: vi.fn(() => { throw new Error('现代信号不应触发 PS'); }) };
    const modern = await bootstrapConsoleForTui({ WT_SESSION: 'x' } as NodeJS.ProcessEnv, ioOf(), { ...win, runner: spyRunner });
    expect(modern.tier).toBe('modern');

    const stdin = stdinOf();
    const runner: ConsoleModeRunner = { run: vi.fn(okRunner.run) };
    const pending = bootstrapConsoleForTui({} as NodeJS.ProcessEnv, ioOf(stdin), { ...win, runner, probeTimeoutMs: 500 });
    stdin.emit('data', Buffer.from('\x1b[5;6R'));
    const cmd = await pending;
    expect(cmd.tier).toBe('cmd');
    expect(cmd.capabilities.mouse).toBe(true);
    cmd.restore();
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('PS 成功但探测无应答 → no-vt；restore 恢复原输入模式；指引含三条出路', async () => {
    const stdin = stdinOf();
    const runner: ConsoleModeRunner = { run: vi.fn(okRunner.run) };
    const result = await bootstrapConsoleForTui({} as NodeJS.ProcessEnv, ioOf(stdin), { ...win, runner, probeTimeoutMs: 30 });
    expect(result.tier).toBe('no-vt');
    expect(result.capabilities.glyphSet).toBe('ascii');
    result.restore();
    expect(runner.run).toHaveBeenCalledTimes(2);
    const guidance = noVtGuidance(result.reason);
    expect(guidance).toContain('Windows Terminal');
    expect(guidance).toContain('注册表');
    expect(guidance).toContain('-p');
    expect(guidance).toContain(result.reason);
  });
});
