// src/infrastructure/computer/windowsUiaPorts.ts — WindowsUiaDriver 真实端口装配（生产接线）
// inspectBoundary：真实会话探测（UserInteractive + OpenInputDesktop 名 + LockApp 锁屏信号 +
// 目标窗口进程 TokenElevation）——每个动作重证，绝不用启动快照缓存（驱动层每动作调用一次）；
// invoke/select/coordinateFallback：接 src/kernel/computer/uia.ts 真实 PowerShell/UIAutomation 桥
// （单能力端口——兜底裁决在驱动层按边界进行，桥不做跨模式回落）。
// runtimeId 约定：<name>|<automationId>|<handle>（handle 可省——省则全桌面搜索 + 目标完整性按当前进程）。
import { spawnSync } from 'node:child_process';
import { uiaInvokeOnly, uiaSelectOnly, uiaMouseOnly } from '../../kernel/computer/uia.js';
import type { UiaPorts } from './windowsUiaDriver.js';

const BOUNDARY_PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WxNodusBoundary {
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll")] public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
  [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength, out uint ReturnLength);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);
}
'@
function Test-Elevated([uint32]$procId) {
  # 注意：形参绝不可命名为 $Pid（PowerShell 只读自动变量——绑定静默失败，函数体永不执行）
  $hProc = [WxNodusBoundary]::OpenProcess(0x0400, $false, $procId)   # PROCESS_QUERY_INFORMATION
  if ($hProc -eq [IntPtr]::Zero) { return $null }                  # 打不开（受保护/系统进程）→ 调用方 fail-closed 视高完整性
  $hTok = [IntPtr]::Zero
  if (-not [WxNodusBoundary]::OpenProcessToken($hProc, 0x0008, [ref]$hTok)) { [void][WxNodusBoundary]::CloseHandle($hProc); return $null }
  [uint32]$size = 0
  [void][WxNodusBoundary]::GetTokenInformation($hTok, 20, [IntPtr]::Zero, 0, [ref]$size)  # TokenElevation = 20
  $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([int]$size)
  $ok = [WxNodusBoundary]::GetTokenInformation($hTok, 20, $buf, $size, [ref]$size)
  $elevated = $false
  if ($ok) { $elevated = ([System.Runtime.InteropServices.Marshal]::ReadInt32($buf) -ne 0) }
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  [void][WxNodusBoundary]::CloseHandle($hTok)
  [void][WxNodusBoundary]::CloseHandle($hProc)
  return $elevated
}
function Get-InputDesktopName {
  $h = [WxNodusBoundary]::OpenInputDesktop(0, $false, 0x0081)  # DESKTOP_READOBJECTS|WRITEOBJECTS
  if ($h -eq [IntPtr]::Zero) { return '' }
  $sb = [System.Text.StringBuilder]::new(256)
  $needed = 0
  $name = ''
  if ([WxNodusBoundary]::GetUserObjectInformation($h, 2, $sb, 256, [ref]$needed)) { $name = $sb.ToString() }  # UOI_NAME = 2
  [void][WxNodusBoundary]::CloseDesktop($h)
  return $name
}
$desktop = Get-InputDesktopName
[uint32]$targetPid = 0
$targetElevated = $null
if ($script:args[0] -and $script:args[0] -ne '') {
  $parsed = [int64]0
  if ([int64]::TryParse($script:args[0], [ref]$parsed)) {
    $hWnd = [IntPtr]::new($parsed)
    [void][WxNodusBoundary]::GetWindowThreadProcessId($hWnd, [ref]$targetPid)
    if ($targetPid -gt 0) { $targetElevated = Test-Elevated $targetPid }
  }
}
$lockApp = Get-Process LockApp -ErrorAction SilentlyContinue
$runnerElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
[pscustomobject]@{
  interactive = [Environment]::UserInteractive
  desktop = $desktop
  lockAppRunning = ($null -ne $lockApp)
  runnerElevated = $runnerElevated
  targetPid = $targetPid
  targetElevated = $targetElevated
} | ConvertTo-Json -Compress
`.trim();

export interface BoundaryProbe {
  interactive: boolean;
  desktop: string;
  lockAppRunning: boolean;
  runnerElevated: boolean;
  targetPid: number;
  targetElevated: boolean | null;
}

/** 探测输出解析（纯函数，可单测）：坏 JSON/字段缺失 → 最严边界 fail-closed（绝不凭猜测放行） */
export function parseBoundaryProbe(raw: string): BoundaryProbe {
  try {
    const j = JSON.parse(raw.split('\n').filter(l => l.trim()).pop() ?? '{}');
    return {
      interactive: Boolean(j.interactive),
      desktop: String(j.desktop ?? ''),
      lockAppRunning: Boolean(j.lockAppRunning),
      runnerElevated: Boolean(j.runnerElevated),
      targetPid: Number(j.targetPid ?? 0),
      targetElevated: j.targetElevated == null ? null : Boolean(j.targetElevated),
    };
  } catch {
    return { interactive: false, desktop: '', lockAppRunning: true, runnerElevated: false, targetPid: 0, targetElevated: true };
  }
}

/** 真实会话边界探测（每动作重证；PowerShell 每次 ~100-300ms） */
export function probeUiaBoundary(handle?: string): BoundaryProbe {
  // args 赋值必须在探测体之前（BOUNDARY_PS 内含执行体，尾部追加会跑到 JSON 输出之后）
  const ps = `$script:args = @('${String(handle ?? '').replace(/'/g, "''")}')\n${BOUNDARY_PS}`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  return parseBoundaryProbe(String(r.stdout ?? '').trim());
}

/** 装配真实端口（WindowsUiaDriver 生产实例）——UIA 工具与 Gate E 场景共用。
 *  probe 可注入（测试用）；缺省为真实 PowerShell 边界探测。 */
export function createWindowsUiaPorts(probe: (handle?: string) => BoundaryProbe = probeUiaBoundary): UiaPorts {
  const parse = (runtimeId: string) => {
    const [name = '', id = '', handle = ''] = String(runtimeId).split('|');
    return { name, id, handle };
  };
  const actResult = (method: string) => (r: ReturnType<typeof uiaInvokeOnly>): boolean =>
    r.ok && (r.element as { method?: string } | undefined)?.method === method;
  return {
    async inspectBoundary(runtimeId: string) {
      const { handle } = parse(runtimeId);
      const b = probe(handle);
      // 目标完整性：探测失败（null=打不开令牌，受保护/系统进程）→ fail-closed 视 high
      const targetIntegrity: 'low' | 'medium' | 'high' | 'system' = b.targetElevated === false ? 'medium' : 'high';
      return {
        interactive: b.interactive,
        unlocked: b.desktop === 'Default' && !b.lockAppRunning,
        inputDesktop: b.desktop || 'Unknown',
        runnerIntegrity: b.runnerElevated ? 'high' : 'medium',
        targetIntegrity,
        protectedUi: b.desktop !== 'Default',
      };
    },
    async invoke(runtimeId: string) {
      const { name, id, handle } = parse(runtimeId);
      return actResult('invoke')(uiaInvokeOnly(`${name}|${id}`, handle));
    },
    async select(runtimeId: string) {
      const { name, id, handle } = parse(runtimeId);
      return actResult('select')(uiaSelectOnly(`${name}|${id}`, handle));
    },
    async coordinateFallback(runtimeId: string) {
      const { name, id, handle } = parse(runtimeId);
      const r = uiaMouseOnly(`${name}|${id}`, handle);
      if (!r.ok) return { acted: false, receiptId: null };
      const el = r.element as { x?: number; y?: number } | undefined;
      return { acted: true, receiptId: `uia-mouse-${el?.x ?? 0}-${el?.y ?? 0}` };
    },
  };
}
