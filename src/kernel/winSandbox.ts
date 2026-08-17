// src/kernel/winSandbox.ts — Windows OS 内核沙盒（gap P0-4 落地，2026-08-18）
// 实测校准（本机标准用户 Windows 实测，非纸面设计）：
//   ① CreateRestrictedToken + CreateProcessAsUser → 1314（ERROR_PRIVILEGE_NOT_HELD，
//      标准用户无 SeTcbPrivilege，受限令牌不可用于进程创建）——已实测证伪该路径。
//   ② SetTokenInformation(Low IL S-1-16-4096) + CreateProcessAsUser → 可用！
//      Low IL 子进程写 Medium IL 对象被拒（实测「拒绝访问」）——这就是 L0 只读语义。
//   ③ Job Object（KILL_ON_JOB_CLOSE 防孤儿）+ JobObjectNetRateControlInformation
//      （1B/s=断网级 / 10KB/s 限速）——普通 CreateProcess 即可施加，实测可用。
// 因此 profile 定义（gemini GeminiSandbox 同族、按本机能力诚实落位）：
//   L0 只读+断网：Low IL + Job + 1B/s     L1 可写+断网：Job + 1B/s
//   L2 可写+限速：Job + 10KB/s            L3 遏制：Job（KILL_ON_CLOSE）
// 诚实工程红线：
//   - 能力探测（probe）实测 Low IL + Job 创建；失败 → 明确降级 + 提示，绝不假装沙盒
//   - 探测结果进程级缓存；settings.sandbox.profile='off' 默认（兼容性优先，opt-in）
//   - 仅 Windows；非 win32 诚实返回不适用。内嵌 C# 块必须纯 ASCII
//     （Add-Type -TypeDefinition 在非 UTF8 系统代码页下会损坏非 ASCII——实测中文注释
//     导致解析错位；此教训已固化在 runner 注释与 audit）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SandboxProfile = 'L0' | 'L1' | 'L2' | 'L3';

export interface SandboxSettings { profile?: string; enabled?: boolean }

/** settings.sandbox 解析（纯函数可单测）：合法 profile 或 'off' */
export function resolveSandboxProfile(settings: Record<string, any> | undefined): SandboxProfile | 'off' {
  const sb = settings?.sandbox as SandboxSettings | string | undefined;
  const p = typeof sb === 'string' ? sb : String(sb?.profile ?? 'off').trim().toUpperCase();
  return p === 'L0' || p === 'L1' || p === 'L2' || p === 'L3' ? p : 'off';
}

/** profile → 原生参数映射（纯函数可单测；本机实测校准——见文件头注释） */
export function sandboxSpec(profile: SandboxProfile): { lowIl: boolean; netLimitBps: number | null; job: boolean } {
  switch (profile) {
    case 'L0': return { lowIl: true, netLimitBps: 1, job: true };
    case 'L1': return { lowIl: false, netLimitBps: 1, job: true };
    case 'L2': return { lowIl: false, netLimitBps: 10 * 1024, job: true };
    case 'L3': return { lowIl: false, netLimitBps: null, job: true };
  }
}

// ── 助手脚本（PS + 内联 C#，版本戳防陈旧缓存）────────────────
export const SANDBOX_RUNNER_VERSION = 2;

const PS_LINES: string[] = [
  'param([string]$Mode="",[string]$Profile="",[string]$Exe="",[string]$ArgsJson="[]",[string]$Cwd="",[string]$OutPath="",[string]$ErrPath="",[string]$StdinPath="")',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$ErrorActionPreference = "Stop"',
  "$src = @'",
  'using System;',
  'using System.ComponentModel;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class WxSandbox {',
  '  [StructLayout(LayoutKind.Sequential)] struct SA { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }',
  '  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }',
  '  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }',
  '  [StructLayout(LayoutKind.Sequential)] struct JBLI { public long t1; public long t2; public uint flags; public UIntPtr ws1; public UIntPtr ws2; public uint active; public UIntPtr aff; public uint prio; public uint sched; }',
  '  [StructLayout(LayoutKind.Sequential)] struct JELI { public JBLI basic; public IOC io; public UIntPtr pml; public UIntPtr jml; public UIntPtr ppm; public UIntPtr pjm; }',
  '  [StructLayout(LayoutKind.Sequential)] struct JNRC { public ulong MaxBandwidth; public uint ControlFlags; public uint DSCPTag; }',
  '  [StructLayout(LayoutKind.Sequential)] struct SIDATTR { public IntPtr Sid; public uint Attributes; }',
  '  const uint TAP = 0x1, TDUP = 0x2, TQ = 0x8, TAD = 0x80;',
  '  const uint CSUS = 0x4, CUE = 0x400;',
  '  const int USESTDHANDLES = 0x100;',
  '  const int KILLONCLOSE = 0x2000, DIEONEXC = 0x400;',
  '  const uint NRCENABLE = 0x1, NRCMAXBW = 0x4;',
  '  const int JELI_CLASS = 9, NRC_CLASS = 32, TIL_CLASS = 25;',
  '  const uint GENREAD = 0x80000000, GENWRITE = 0x40000000, SHARERW = 3, CREATEALWAYS = 2, FILENORMAL = 0x80;',
  '  const uint INF = 0xFFFFFFFF;',
  '  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr t);',
  '  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr e, uint access, ref SA sa, int level, int type, out IntPtr nt);',
  '  [DllImport("advapi32.dll", SetLastError = true)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);',
  '  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr t, int cls, IntPtr info, uint len);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);',
  '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, uint cls, IntPtr info, uint len);',
  '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUser(IntPtr t, string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);',
  '  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr th);',
  '  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);',
  '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);',
  '  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SA sa, uint mode, uint flags, IntPtr tmpl);',
  '  // stdout/stderr/stdin redirect file handles MUST be inheritable (CreateProcess bInheritHandles):',
  '  // CreateFile with lpSecurityAttributes=NULL yields non-inheritable handles, child std handles',
  '  // become invalid and all output is silently lost. Keep this embedded C# block ASCII-only:',
  '  // Add-Type -TypeDefinition corrupts non-ASCII on non-UTF8 system code pages (verified:',
  '  // Chinese comments broke parsing - runner regenerated with ASCII-only block).',
  '  static IntPtr InheritFile(string path, uint access, uint mode) {',
  '    SA sa = new SA();',
  '    sa.nLength = Marshal.SizeOf(typeof(SA));',
  '    sa.bInheritHandle = true;',
  '    return CreateFile(path, access, SHARERW, ref sa, mode, FILENORMAL, IntPtr.Zero);',
  '  }',
  '  static string Err() { return new Win32Exception().Message + " (" + new Win32Exception().NativeErrorCode + ")"; }',
  '  // Low IL: S-1-16-4096 (SECURITY_MANDATORY_LOW_RID) as TokenIntegrityLevel.',
  '  // Verified on standard user: SetTokenInformation works without TCB; Low IL child gets',
  '  // ACCESS_DENIED writing Medium-IL files - that is the L0 read-only semantics.',
  '  static void SetLowIL(IntPtr token) {',
  '    IntPtr sid;',
  '    if (!ConvertStringSidToSid("S-1-16-4096", out sid)) throw new Exception("LowIL-SID:" + Err());',
  '    SIDATTR tml = new SIDATTR();',
  '    tml.Sid = sid;',
  '    tml.Attributes = 0x20 | 0x40; // SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED',
  '    int tsize = Marshal.SizeOf(typeof(SIDATTR));',
  '    IntPtr tbuf = Marshal.AllocHGlobal(tsize);',
  '    Marshal.StructureToPtr(tml, tbuf, false);',
  '    bool ok = SetTokenInformation(token, TIL_CLASS, tbuf, (uint)tsize);',
  '    Marshal.FreeHGlobal(tbuf);',
  '    if (!ok) throw new Exception("SetTokenInformation(LowIL):" + Err());',
  '  }',
  '  public static string Probe() {',
  '    try {',
  '      IntPtr cur;',
  '      if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, TDUP | TQ | TAP, out cur)) return "ERR:OpenProcessToken:" + Err();',
  '      SA sa = new SA();',
  '      IntPtr prim;',
  '      if (!DuplicateTokenEx(cur, TAP | TQ | TDUP | TAD, ref sa, 2, 1, out prim)) return "ERR:DuplicateTokenEx:" + Err();',
  '      SetLowIL(prim);',
  '      IntPtr job = CreateJobObject(IntPtr.Zero, null);',
  '      if (job == IntPtr.Zero) return "ERR:CreateJobObject:" + Err();',
  '      CloseHandle(job); CloseHandle(prim); CloseHandle(cur);',
  '      return "OK";',
  '    } catch (Exception ex) { return "ERR:EX:" + ex.Message; }',
  '  }',
  '  // Minimal JSON string-array parser (escape subset of JSON.stringify: quote, backslash, n, r, t, uXXXX).',
  '  // Not JavaScriptSerializer: .NET Core (pwsh7) lacks System.Web.Extensions; probe degrades honestly.',
  '  static string[] ParseJsonStringArray(string json) {',
  '    var list = new System.Collections.Generic.List<string>();',
  '    int i = 0; int n = json.Length;',
  '    while (i < n && json[i] != (char)91) i++;',
  '    i++;',
  '    while (i < n) {',
  '      while (i < n && (json[i] == (char)32 || json[i] == (char)44 || json[i] == (char)13 || json[i] == (char)10 || json[i] == (char)9)) i++;',
  '      if (i >= n || json[i] == (char)93) break;',
  '      if (json[i] != (char)34) throw new Exception("args-json-bad");',
  '      i++;',
  '      var sb = new StringBuilder();',
  '      while (i < n && json[i] != (char)34) {',
  '        char c = json[i];',
  '        if (c == (char)92 && i + 1 < n) {',
  '          char e = json[i + 1];',
  '          if (e == (char)34) { sb.Append((char)34); i += 2; continue; }',
  '          if (e == (char)92) { sb.Append((char)92); i += 2; continue; }',
  '          if (e == (char)110) { sb.Append((char)10); i += 2; continue; }',
  '          if (e == (char)114) { sb.Append((char)13); i += 2; continue; }',
  '          if (e == (char)116) { sb.Append((char)9); i += 2; continue; }',
  '          if (e == (char)117 && i + 5 < n) { sb.Append((char)Convert.ToInt32(json.Substring(i + 2, 4), 16)); i += 6; continue; }',
  '        }',
  '        sb.Append(c); i++;',
  '      }',
  '      i++;',
  '      list.Add(sb.ToString());',
  '    }',
  '    return list.ToArray();',
  '  }',
  '  // Windows command-line quoting: wrap in quotes, double embedded quotes.',
  '  static string Quote(string s) { return "\\"" + s.Replace("\\"", "\\"\\"") + "\\""; }',
  '  public static int Run(string profile, string exe, string argsJson, string cwd, string outPath, string errPath, string stdinPath) {',
  '    IntPtr cur;',
  '    if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, TDUP | TQ | TAP, out cur)) throw new Exception("OpenProcessToken:" + Err());',
  '    SA sa = new SA();',
  '    IntPtr prim = IntPtr.Zero;',
  '    bool useToken = profile == "L0";',
  '    if (useToken) {',
  '      if (!DuplicateTokenEx(cur, TAP | TQ | TDUP | TAD, ref sa, 2, 1, out prim)) throw new Exception("DuplicateTokenEx:" + Err());',
  '      SetLowIL(prim);',
  '    }',
  '    IntPtr job = CreateJobObject(IntPtr.Zero, null);',
  '    if (job == IntPtr.Zero) throw new Exception("CreateJobObject:" + Err());',
  '    JELI jel = new JELI();',
  '    jel.basic.flags = (uint)(KILLONCLOSE | DIEONEXC);',
  '    int jsize = Marshal.SizeOf(typeof(JELI));',
  '    IntPtr jbuf = Marshal.AllocHGlobal(jsize);',
  '    Marshal.StructureToPtr(jel, jbuf, false);',
  '    if (!SetInformationJobObject(job, JELI_CLASS, jbuf, (uint)jsize)) throw new Exception("SetInformationJobObject(JELI):" + Err());',
  '    Marshal.FreeHGlobal(jbuf);',
  '    if (profile == "L0" || profile == "L1" || profile == "L2") {',
  '      JNRC nrc = new JNRC();',
  '      nrc.MaxBandwidth = profile == "L2" ? 10240UL : 1UL;',
  '      nrc.ControlFlags = NRCENABLE | NRCMAXBW;',
  '      int nsize = Marshal.SizeOf(typeof(JNRC));',
  '      IntPtr nbuf = Marshal.AllocHGlobal(nsize);',
  '      Marshal.StructureToPtr(nrc, nbuf, false);',
  '      if (!SetInformationJobObject(job, NRC_CLASS, nbuf, (uint)nsize)) throw new Exception("SetInformationJobObject(NRC):" + Err());',
  '      Marshal.FreeHGlobal(nbuf);',
  '    }',
  '    IntPtr hOut = InheritFile(outPath, GENWRITE, CREATEALWAYS);',
  '    IntPtr hErr = InheritFile(errPath, GENWRITE, CREATEALWAYS);',
  '    IntPtr hIn = InheritFile(stdinPath.Length > 0 ? stdinPath : "NUL", GENREAD, 3);',
  '    if (hOut == new IntPtr(-1) || hErr == new IntPtr(-1) || hIn == new IntPtr(-1)) throw new Exception("CreateFile:" + Err());',
  '    SI si = new SI();',
  '    si.cb = Marshal.SizeOf(typeof(SI));',
  '    si.dwFlags = USESTDHANDLES;',
  '    si.hStdOutput = hOut; si.hStdError = hErr; si.hStdInput = hIn;',
  '    var args = ParseJsonStringArray(argsJson);',
  '    var cmdline = new StringBuilder();',
  '    cmdline.Append(Quote(exe));',
  '    foreach (var a in args) { cmdline.Append(" "); cmdline.Append(Quote(a)); }',
  '    PI pi;',
  '    bool ok = useToken',
  '      ? CreateProcessAsUser(prim, null, cmdline.ToString(), IntPtr.Zero, IntPtr.Zero, true, CSUS | CUE, IntPtr.Zero, cwd.Length > 0 ? cwd : null, ref si, out pi)',
  '      : CreateProcess(null, cmdline.ToString(), IntPtr.Zero, IntPtr.Zero, true, CSUS | CUE, IntPtr.Zero, cwd.Length > 0 ? cwd : null, ref si, out pi);',
  '    if (!ok) throw new Exception("CreateProcess:" + Err());',
  '    if (!AssignProcessToJobObject(job, pi.hProcess)) throw new Exception("AssignProcessToJobObject:" + Err());',
  '    ResumeThread(pi.hThread);',
  '    CloseHandle(pi.hThread);',
  '    WaitForSingleObject(pi.hProcess, INF);',
  '    uint code;',
  '    if (!GetExitCodeProcess(pi.hProcess, out code)) throw new Exception("GetExitCodeProcess:" + Err());',
  '    CloseHandle(pi.hProcess); CloseHandle(job);',
  '    if (useToken) CloseHandle(prim);',
  '    CloseHandle(cur);',
  '    return (int)code;',
  '  }',
  '}',
  "'@",
  'Add-Type -TypeDefinition $src',
  'if ($Mode -eq "probe") { Write-Output ("WX_SANDBOX_PROBE:" + [WxSandbox]::Probe()); exit 0 }',
  'try {',
  '  $code = [WxSandbox]::Run($Profile, $Exe, $ArgsJson, $Cwd, $OutPath, $ErrPath, $StdinPath)',
  '  Write-Output ("WX_SANDBOX_EXIT:" + $code)',
  '  exit 0',
  '} catch {',
  '  Write-Output ("WX_SANDBOX_ERROR:" + $_.Exception.Message)',
  '  exit 127',
  '}',
];

export const SANDBOX_RUNNER_SCRIPT = PS_LINES.join('\n');

// 进程级一次探测缓存（能力不因调用变化；/sandbox os probe 强制重探）
let probeCache: { ok: boolean; detail: string } | null = null;

function runnerPath(dataDir: string): string {
  return join(dataDir, 'sandbox', 'sandbox-runner.ps1');
}

/** 助手脚本落盘（版本戳变化自动重写） */
function ensureRunner(dataDir: string): string {
  const p = runnerPath(dataDir);
  try {
    const stamp = `# wxnodus sandbox runner v${SANDBOX_RUNNER_VERSION} (generated by kernel/winSandbox.ts)\n`;
    const want = stamp + SANDBOX_RUNNER_SCRIPT;
    if (!existsSync(p) || readFileSync(p, 'utf8') !== want) {
      mkdirSync(join(dataDir, 'sandbox'), { recursive: true });
      writeFileSync(p, want, 'utf8');
    }
  } catch { /* 落盘失败 → 探测会报错降级 */ }
  return p;
}

/** 测试/诊断入口：返回落盘路径与脚本内容（断言 runner 内容用——/sandbox os probe 走 probeWinSandbox） */
export function ensureSandboxRunnerForTest(dataDir: string): { script: string; path: string; version: number } {
  const p = ensureRunner(dataDir);
  return { script: readFileSync(p, 'utf8'), path: p, version: SANDBOX_RUNNER_VERSION };
}

/** 能力探测（默认用缓存；force=true 强制重探——/sandbox os probe） */
export async function probeWinSandbox(dataDir: string, force = false): Promise<{ ok: boolean; detail: string }> {
  if (!force && probeCache) return probeCache;
  if (process.platform !== 'win32') {
    probeCache = { ok: false, detail: '非 Windows 平台——OS 沙盒仅支持 Windows（Low IL/Job Object）' };
    return probeCache;
  }
  const result = await new Promise<{ ok: boolean; detail: string }>((resolveP) => {
    let done = false;
    const finish = (r: { ok: boolean; detail: string }) => { if (!done) { done = true; resolveP(r); } };
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureRunner(dataDir), '-Mode', 'probe'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } finish({ ok: false, detail: '探测超时（20s）——PowerShell Add-Type 编译失败或不可用' }); }, 20_000);
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', () => { /* stderr 忽略 */ });
      child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, detail: `无法启动 powershell.exe：${e.message}` }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const m = out.match(/WX_SANDBOX_PROBE:(.+)/);
        const body = m ? m[1]!.trim() : `无输出（exit ${code}）`;
        finish(body === 'OK'
          ? { ok: true, detail: 'Low IL 令牌 + Job Object + 断网限速可用（L0 只读经 Low IL 实现，标准用户可用）' }
          : { ok: false, detail: body });
      });
    } catch (e: any) {
      finish({ ok: false, detail: String(e?.message ?? e) });
    }
  });
  if (!force) probeCache = result;
  return result;
}

/** 当前配置下沙盒是否应启用（纯函数可单测） */
export function sandboxEnabled(settings: Record<string, any> | undefined): boolean {
  const p = resolveSandboxProfile(settings);
  if (p === 'off') return false;
  const sb = settings?.sandbox as SandboxSettings | string | undefined;
  return typeof sb !== 'string' && sb?.enabled === false ? false : true;
}

export interface SandboxLaunchOutcome {
  result: { code: number | null; outPath: string; errPath: string; outTotal: number; errTotal: number } | null;
  reason?: 'not-win32' | 'off' | 'probe-failed' | 'launch-failed';
  note?: string;
}

/**
 * 经 OS 沙盒执行命令（bash 工具执行层接入）。
 * 返回 result=null 的三种情况（诚实区分）：非 Windows / 未开启 / 探测失败——调用方
 * 必须退回普通 spawn 或明确报错（绝不静默把未沙盒当沙盒）。
 */
export async function trySandboxLaunch(opts: {
  settings?: Record<string, any>;
  dataDir: string;
  cmd: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<SandboxLaunchOutcome> {
  if (process.platform !== 'win32') return { result: null, reason: 'not-win32' };
  const profile = resolveSandboxProfile(opts.settings);
  if (profile === 'off' || !sandboxEnabled(opts.settings)) return { result: null, reason: 'off' };
  const probe = await probeWinSandbox(opts.dataDir);
  if (!probe.ok) return { result: null, reason: 'probe-failed', note: `OS 沙盒不可用（${probe.detail}）——本次命令已按普通方式执行（未沙盒）` };
  const tmp = join(opts.dataDir, 'sandbox', 'run');
  mkdirSync(tmp, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const outPath = join(tmp, `${id}.out`);
  const errPath = join(tmp, `${id}.err`);
  const stdinPath = opts.stdin !== undefined ? join(tmp, `${id}.in`) : '';
  // CreateProcess 的 lpApplicationName 需要全路径（PATH 搜索不可靠）；powershell.exe
  // 固定位于 System32\WindowsPowerShell\v1.0（实测裸名在部分场景报 error 2）
  const fullCmd = opts.cmd.includes('\\') || opts.cmd.includes('/')
    ? opts.cmd
    : join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', opts.cmd);
  try {
    if (stdinPath && opts.stdin !== undefined) writeFileSync(stdinPath, opts.stdin, 'utf8');
    const argv = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureRunner(opts.dataDir),
      '-Mode', 'run', '-Profile', profile,
      '-Exe', fullCmd, '-ArgsJson', JSON.stringify(opts.args),
      '-Cwd', opts.cwd, '-OutPath', outPath, '-ErrPath', errPath, '-StdinPath', stdinPath,
    ];
    const outcome = await new Promise<SandboxLaunchOutcome>((resolveP) => {
      let done = false;
      let keepFiles = false;
      const finish = (r: SandboxLaunchOutcome) => { if (!done) { done = true; keepFiles = r.result !== null; resolveP(r); } };
      const child = spawn('powershell.exe', argv, { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
      const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, opts.timeoutMs) : null;
      let meta = '';
      child.stdout?.on('data', (d: Buffer) => { meta += d.toString(); });
      child.stderr?.on('data', () => { /* stderr 忽略（错误进 meta 协议行） */ });
      child.on('error', (e) => { if (timer) clearTimeout(timer); finish({ result: null, reason: 'launch-failed', note: `沙盒启动失败：${e.message}` }); });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const exitM = meta.match(/WX_SANDBOX_EXIT:(-?\d+)/);
        const errM = meta.match(/WX_SANDBOX_ERROR:(.+)/);
        if (exitM) {
          let outTotal = 0; let errTotal = 0;
          try { outTotal = statSync(outPath).size; } catch { /* 无输出文件 */ }
          try { errTotal = statSync(errPath).size; } catch { /* 无输出文件 */ }
          // 输出文件移交给调用方（接管 offload/清理）——此处不删不读
          finish({ result: { code: Number(exitM[1]), outPath, errPath, outTotal, errTotal } });
        } else if (errM) {
          finish({ result: null, reason: 'launch-failed', note: `沙盒执行失败：${errM[1]!.trim().slice(0, 200)}` });
        } else if (opts.signal?.aborted) {
          finish({ result: null, reason: 'launch-failed', note: '已中断（用户中止）' });
        } else {
          finish({ result: null, reason: 'launch-failed', note: `沙盒助手异常退出（exit ${code}）` });
        }
        if (!keepFiles) {
          try { rmSync(outPath, { force: true }); rmSync(errPath, { force: true }); } catch { /* 忽略 */ }
        }
      });
    });
    return outcome;
  } finally {
    try { if (stdinPath) rmSync(stdinPath, { force: true }); } catch { /* 清理失败静默 */ }
  }
}
