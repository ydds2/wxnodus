// src/wxnodus-ui/lib/consoleBootstrap.ts — W8-21：PS 控制台引导（cmd/conhost 风险第二道防线）
// 流程（仅 Windows conhost 候选）：PowerShell P/Invoke SetConsoleMode——
//   输出句柄(-11) 开 ENABLE_VIRTUAL_TERMINAL_PROCESSING|ENABLE_PROCESSED_OUTPUT；
//   输入句柄(-10) 开 ENABLE_EXTENDED_FLAGS 并关 ENABLE_QUICK_EDIT_MODE|ENABLE_LINE_INPUT|ENABLE_ECHO_INPUT；
// → CPR 探测（\x1b[?6n，300ms 等 \x1b[r;cR）→ 诚实结论。
// 终态核验：PS 回写 <orig> <final> 输入模式，QuickEdit 是否真关以 final 为准（绝不假设）。
// Tier 0（VT 不可用）：restore() 恢复原输入模式 + 诚实中文指引——绝不输出乱码 TUI。
import { spawnSync } from 'node:child_process';
import { release as osRelease } from 'node:os';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTerminalTier, type TerminalCapabilities, type TerminalTier, type VtProbeResult } from './terminalTier.js';

export const PS_ENABLE = String.raw`$d='[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr sa,uint c,uint f,IntPtr t);[DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetConsoleMode(IntPtr h,[Out]uint[] m);[DllImport("kernel32.dll",SetLastError=true)]public static extern bool SetConsoleMode(IntPtr h,uint m);'
$t=Add-Type -MemberDefinition $d -Name K32 -Namespace WNTui -PassThru
$o=$t::CreateFileW('CONOUT$',3221225472,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
$i=$t::CreateFileW('CONIN$',3221225472,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
$om=[uint32[]]::new(1);$im=[uint32[]]::new(1)
[void]$t::GetConsoleMode($o,$om);[void]$t::GetConsoleMode($i,$im)
[void]$t::SetConsoleMode($o,($om[0] -bor 4 -bor 1))
[void]$t::SetConsoleMode($i,(($im[0] -bor 128) -band (-bnot (64 -bor 2 -bor 4))))
$fm=[uint32[]]::new(1);[void]$t::GetConsoleMode($i,$fm)
$fom=[uint32[]]::new(1);[void]$t::GetConsoleMode($o,$fom)
[IO.File]::WriteAllText($env:WXNODUS_MODE_OUT,("OK "+$im[0]+" "+$fm[0]+" "+$fom[0]))`;

export const PS_RESTORE = String.raw`$d='[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr sa,uint c,uint f,IntPtr t);[DllImport("kernel32.dll",SetLastError=true)]public static extern bool SetConsoleMode(IntPtr h,uint m);'
$t=Add-Type -MemberDefinition $d -Name K32 -Namespace WNTui2 -PassThru
$i=$t::CreateFileW('CONIN$',3221225472,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
[void]$t::SetConsoleMode($i,__MODE__)`;

export type ConsoleModeSpawn = (args: string[], env: NodeJS.ProcessEnv) => { status: number | null };

export interface ConsoleModeResult {
  ok: boolean;
  originalInputMode?: number;
  quickEditDisabled?: boolean;
  /** W8-26：输出句柄终态 VT 位（0x4）是否置位——直接读回 OS 模式，比 CPR 回程探测更权威 */
  vtEnabled?: boolean;
  error?: string;
}

const defaultSpawn: ConsoleModeSpawn = (args, env) => {
  const result = spawnSync('powershell.exe', args, {
    env, stdio: 'ignore', timeout: 15_000, windowsHide: true,
  });
  return { status: result.status };
};

/** PS 脚本跑法：结果经 WXNODUS_MODE_OUT 临时文件回传（stdio ignore——子进程继承控制台句柄） */
export function runConsoleModeScript(
  script: string,
  env: NodeJS.ProcessEnv,
  spawnImpl: ConsoleModeSpawn = defaultSpawn,
): ConsoleModeResult {
  const outFile = join(tmpdir(), `wxnodus-cm-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const childEnv = { ...env, WXNODUS_MODE_OUT: outFile };
  try {
    const { status } = spawnImpl(['-NoProfile', '-NonInteractive', '-Command', script], childEnv);
    if (status !== 0) return { ok: false, error: `powershell 退出码 ${status}` };
    if (!existsSync(outFile)) return { ok: false, error: 'PS 未回写结果文件' };
    const match = /OK\s+(\d+)\s+(\d+)\s+(\d+)/.exec(readFileSync(outFile, 'utf8'));
    if (!match) return { ok: false, error: 'PS 结果不可解析' };
    const originalInputMode = Number(match[1]);
    const final = Number(match[2]);
    const finalOutput = Number(match[3]);
    return {
      ok: true,
      originalInputMode,
      quickEditDisabled: (final & 0x40) === 0,
      // ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004——终态回读核验（绝不假设）
      vtEnabled: (finalOutput & 0x4) !== 0,
    };
  } finally {
    try { rmSync(outFile, { force: true }); } catch { /* 临时文件尽力清理 */ }
  }
}

/** CPR 探测：写 \x1b[?6n，收到 \x1b[r;cR 应答 → VT 可用。fail-closed（超时/非 TTY → false）。 */

export interface ConsoleModeRunner {
  run: (script: string, env: NodeJS.ProcessEnv) => ConsoleModeResult;
}

export const defaultConsoleModeRunner: ConsoleModeRunner = {
  run: (script, env) => runConsoleModeScript(script, env),
};

export interface ConsoleBootstrapResult {
  tier: TerminalTier;
  capabilities: TerminalCapabilities;
  reason: string;
  /** 退出/Tier 0 时 best-effort 恢复控制台输入模式（QuickEdit/行/回显） */
  restore: () => void;
}

export interface ConsoleBootstrapOptions {
  platform?: string;
  tty?: boolean;
  runner?: ConsoleModeRunner;
  probeTimeoutMs?: number;
  /** W8-27：OS 构建号注入（测试用）；缺省从 os.release() 解析（Windows 10.0.<build>） */
  osBuild?: number;
}

/** os.release() 10.0.xxxxx → xxxxx；非 Windows 返回 0 */
export function parseOsBuild(release: string): number {
  const match = /^10\.0\.(\d+)$/.exec(release.trim());
  return match ? Number(match[1]) : 0;
}

export async function bootstrapConsoleForTui(
  env: NodeJS.ProcessEnv = process.env,
  options: ConsoleBootstrapOptions = {},
): Promise<ConsoleBootstrapResult> {
  const runner = options.runner ?? defaultConsoleModeRunner;
  const platform = options.platform ?? process.platform;
  const osBuild = options.osBuild ?? parseOsBuild(osRelease());
  let originalInputMode: number | undefined;
  let touched = false;
  let enableFailure: string | undefined;

  const probeVt = async (): Promise<VtProbeResult> => {
    if (platform !== 'win32') return false;
    const enabled = runner.run(PS_ENABLE, env);
    if (!enabled.ok || enabled.originalInputMode === undefined) {
      // W8-26：PS 引导失败与探测无应答必须可区分——失败原因如实上报（绝不吞成「无应答」）
      enableFailure = enabled.error ?? 'PS 控制台引导失败（无原因）';
      return false;
    }
    originalInputMode = enabled.originalInputMode;
    touched = true;
    // W8-26：VT 可用性以输出句柄终态 VT 位为准（SetConsoleMode 后直接读回——OS 契约，
    // 权威且同步）；CPR 回程探测在 winpty/部分 conhost 下应答不可达，已废弃。
    void options.probeTimeoutMs;
    return { vt: enabled.vtEnabled === true, quickEditDisabled: enabled.vtEnabled === true && enabled.quickEditDisabled === true };
  };

  const decision = await detectTerminalTier(env, { platform, tty: options.tty, probeVt });
  const restore = (): void => {
    if (!touched || originalInputMode === undefined) return;
    runner.run(PS_RESTORE.replace('__MODE__', String(originalInputMode)), env);
  };

  // W8-27：PS 引导失败但 OS ≥ 1903（build 18362）——conhost 自 1903 起 VT 默认开启，
  // 按 OS 契约回退为 cmd 档直接进 TUI（鼠标保守关闭，QuickEdit 未关）。绝无手动步骤。
  // 老于 1903 且 PS 失败 → 保持 Tier 0 诚实指引（该代 conhost 无法自动开 VT）。
  if (decision.tier === 'no-vt' && enableFailure && platform === 'win32' && osBuild >= 18362) {
    return {
      tier: 'cmd',
      capabilities: {
        sync2026: false, decstbm: false, truecolor: false, osc8: false, clipboard: false, oscNotify: false,
        mouse: false, extendedKeys: false, glyphSet: 'bmp',
      },
      reason: `PS 引导不可用（${enableFailure}），按 OS 1903+ 默认 VT 开启假设直接进入（鼠标保守关闭）`,
      restore,
    };
  }

  const reason = decision.tier === 'no-vt' && enableFailure ? enableFailure : decision.reason;
  return { tier: decision.tier, capabilities: decision.capabilities, reason, restore };
}

/** Tier 0 诚实指引：三条出路 + 真实原因——绝不输出乱码 TUI */
export function noVtGuidance(reason: string): string {
  return [
    'WxNodus TUI 无法在此控制台运行：VT 序列不可用（老控制台会把整屏 ANSI 打成乱码）。',
    `原因：${reason}`,
    '',
    '三条出路（任选其一）：',
    '  1. 用 Windows Terminal（推荐）：Win+R 输入 wt 回车，再运行 wxnodus',
    '  2. 开启本控制台 VT（注册表）：',
    '     HKCU\\Console 新建 DWORD VirtualTerminalLevel=1，重开 cmd',
    '  3. 行模式（无 TUI）：wxnodus -p "你的需求"',
  ].join('\n');
}
