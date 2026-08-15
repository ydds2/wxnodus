// src/wxnodus-ui/lib/consoleBootstrap.test.ts — W8-21/W8-26：PS 控制台引导（VT 开启 + QuickEdit 关闭 + 终态回读核验）
// 平台无关可注入：runner（PS spawn 假件）全可注入。
// W8-26 实盘缺陷修复：New-Object uint[] 语法错（PS 恒失败 → 假 no-vt）；CPR 回程探测废弃，
// VT 可用性改为输出句柄终态 VT 位（0x4）直接回读——权威且同步。
// 契约：现代信号零 PS 调用；conhost 候选走「PS 开 VT → 终态回读 → 诚实结论」；
// PS 失败原因如实上报（绝不吞成「探测无应答」）；失败 → no-vt + 恢复 + 指引。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import {
  bootstrapConsoleForTui, noVtGuidance, parseOsBuild, PS_ENABLE, PS_RESTORE, runConsoleModeScript,
  type ConsoleModeRunner,
} from './consoleBootstrap.js';

const win = { platform: 'win32', tty: true };

const okRunner: ConsoleModeRunner = {
  run: (script) => script.includes('__MODE__')
    ? { ok: true }
    : { ok: true, originalInputMode: 7, quickEditDisabled: true, vtEnabled: true },
};

describe('W8-21/26 PS 控制台引导', () => {
  it('源锚点：PS_ENABLE 对两个句柄 SetConsoleMode 且终态回读（输出 VT 位权威核验）', () => {
    expect(PS_ENABLE).toContain('SetConsoleMode');
    expect(PS_ENABLE).toContain("CreateFileW('CONOUT$'");
    expect(PS_ENABLE).toContain("CreateFileW('CONIN$'");
    expect(PS_ENABLE).toContain('GetConsoleMode($o,$fom)'); // 输出句柄终态回读
    expect(PS_ENABLE).toContain('[uint32[]]::new(1)'); // W8-26：New-Object uint[] 语法错修复
    expect(PS_RESTORE).toContain('SetConsoleMode');
  });

  it('runConsoleModeScript：解析 OK <orig> <finalInput> <finalOutput>；quickEditDisabled/vtEnabled 以终态核验（绝不假设）', () => {
    const writeOut = (spawnImpl: ReturnType<typeof vi.fn>, content: string) => {
      spawnImpl.mockImplementation((_args: string[], env: NodeJS.ProcessEnv) => {
        writeFileSync(env.WXNODUS_MODE_OUT as string, content, 'utf8');
        return { status: 0 };
      });
    };
    const good = vi.fn();
    writeOut(good, 'OK 7 135 7');
    const r1 = runConsoleModeScript(PS_ENABLE, {}, good as never);
    expect(r1.ok).toBe(true);
    expect(r1.originalInputMode).toBe(7);
    expect(r1.quickEditDisabled).toBe(true); // 135=0x87，bit6 清零 → QuickEdit 已关
    expect(r1.vtEnabled).toBe(true); // 7=0x7，bit2 置位 → VT 已开

    const noVt = vi.fn();
    writeOut(noVt, 'OK 7 135 3'); // 3=0x3，VT 位未置位（老于 1511 或开启失败）
    expect(runConsoleModeScript(PS_ENABLE, {}, noVt as never).vtEnabled).toBe(false);

    const fail = runConsoleModeScript(PS_ENABLE, {}, (() => ({ status: 1 })) as never);
    expect(fail.ok).toBe(false);
  });

  it('现代信号 → modern，零 PS 调用；conhost + PS 成功 + VT 位置位 → cmd（restore 可退）', async () => {
    const spyRunner: ConsoleModeRunner = { run: vi.fn(() => { throw new Error('现代信号不应触发 PS'); }) };
    const modern = await bootstrapConsoleForTui({ WT_SESSION: 'x' } as NodeJS.ProcessEnv, { ...win, runner: spyRunner });
    expect(modern.tier).toBe('modern');

    const runner: ConsoleModeRunner = { run: vi.fn(okRunner.run) };
    const cmd = await bootstrapConsoleForTui({} as NodeJS.ProcessEnv, { ...win, runner });
    expect(cmd.tier).toBe('cmd');
    expect(cmd.capabilities.mouse).toBe(true);
    cmd.restore();
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('PS 成功但 VT 位未置位 → no-vt；restore 恢复原输入模式；指引含三条出路', async () => {
    const runner: ConsoleModeRunner = {
      run: vi.fn(() => ({ ok: true, originalInputMode: 7, quickEditDisabled: true, vtEnabled: false })),
    };
    const result = await bootstrapConsoleForTui({} as NodeJS.ProcessEnv, { ...win, runner });
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

  it('PS 引导失败（老 OS）→ no-vt 且原因如实上报失败细节（绝不吞成「无应答」）', async () => {
    const runner: ConsoleModeRunner = { run: vi.fn(() => ({ ok: false, error: 'powershell 退出码 1' })) };
    const result = await bootstrapConsoleForTui({} as NodeJS.ProcessEnv, { ...win, runner, osBuild: 17763 });
    expect(result.tier).toBe('no-vt');
    expect(result.reason).toContain('powershell 退出码 1');
  });

  // W8-27：用户需求「cmd 直接打开、零手动」——PS 坏了也不能挡住 TUI。
  it('W8-27：PS 引导失败 + OS ≥ 1903 → 按默认 VT 假设直接 cmd 档进 TUI（鼠标保守关闭，零手动步骤）', async () => {
    const runner: ConsoleModeRunner = { run: vi.fn(() => ({ ok: false, error: 'powershell 退出码 1' })) };
    const result = await bootstrapConsoleForTui({} as NodeJS.ProcessEnv, { ...win, runner, osBuild: 26200 });
    expect(result.tier).toBe('cmd');
    expect(result.capabilities.mouse).toBe(false);
    expect(result.capabilities.glyphSet).toBe('bmp');
    expect(result.reason).toContain('1903');
  });

  it('W8-27：PS 引导失败 + 老于 1903 → 保持 no-vt 诚实指引（该代 conhost 无法自动开 VT）', async () => {
    const runner: ConsoleModeRunner = { run: vi.fn(() => ({ ok: false, error: 'powershell 退出码 1' })) };
    const result = await bootstrapConsoleForTui({} as NodeJS.ProcessEnv, { ...win, runner, osBuild: 17763 });
    expect(result.tier).toBe('no-vt');
    expect(result.reason).toContain('powershell 退出码 1');
  });

  it('parseOsBuild：10.0.<build> 解析；非 Windows 形式返回 0', () => {
    expect(parseOsBuild('10.0.26200')).toBe(26200);
    expect(parseOsBuild('10.0.19045')).toBe(19045);
    expect(parseOsBuild('6.3.9600')).toBe(0);
    expect(parseOsBuild('not-windows')).toBe(0);
  });
});
