// src/kernel/computer/uia.ts — Windows UI Automation 桥（桌面控制上限升级）
// 审查升级：robotjs 是 Win32 消息级盲坐标（无 UI 结构感知、中文输入靠剪贴板 hack）。
// 本模块用 Windows 内置 UIAutomation（.NET，PowerShell 直调，零新增原生依赖）补上
// 「元素级」能力：窗口枚举 / 控件树 / 按 AutomationId/Name 定位 / InvokePattern 点击 /
// ValuePattern 中文原生输入——动态 UI 不再依赖脆弱坐标。
// 每个调用 spawn PowerShell（~200-500ms，工具调用可接受）；输出 JSON 解析。
import { spawnSync } from 'node:child_process';

export interface UiaElement {
  ct: string; name: string; id: string;
  x: number; y: number; w: number; h: number;
  enabled: boolean; offscreen: boolean;
}
export interface UiaWindow { name: string; className: string; pid: number; handle: string; focused: boolean }
/** 操作结果（click/type）或元素信息（find） */
export interface UiaAction { method?: string; x?: number; y?: number; reason?: string }
export interface UiaResult { ok: boolean; reason?: string; elements?: UiaElement[]; windows?: UiaWindow[]; element?: UiaElement | UiaAction }

const PS_HEAD = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$script:out = @()
$script:count = 0
function Get-ElementTree($el, $depth, $maxDepth, $maxItems) {
  if ($depth -gt $maxDepth -or $script:count -ge $maxItems) { return }
  $ct = $el.Current.ControlType.ProgrammaticName -replace 'ControlType.',''
  $name = [string]$el.Current.Name
  $id = [string]$el.Current.AutomationId
  $rect = $el.Current.BoundingRectangle
  $interact = $ct -in @('Button','Edit','ListItem','MenuItem','Hyperlink','CheckBox','RadioButton','ComboBox','TabItem','TreeItem','DataItem')
  $hasName = $name.Length -gt 0
  $hasId = $id.Length -gt 0
  if ($interact -or $hasName -or $hasId) {
    $script:out += [pscustomobject]@{
      ct = $ct; name = $name; id = $id
      x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
      enabled = $el.Current.IsEnabled; offscreen = $el.Current.IsOffscreen
    }
    $script:count++
  }
  $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($c in $children) { Get-ElementTree $c ($depth + 1) $maxDepth $maxItems }
}
function Find-ElementBy($root, $id, $name) {
  $cond = $null
  if ($id.Length -gt 0) {
    $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  } elseif ($name.Length -gt 0) {
    $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  } else { return $null }
  $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  return $found
}
function Get-ElementInfo($el) {
  $rect = $el.Current.BoundingRectangle
  return [pscustomobject]@{
    ct = ($el.Current.ControlType.ProgrammaticName -replace 'ControlType.','')
    name = [string]$el.Current.Name; id = [string]$el.Current.AutomationId
    x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
    enabled = $el.Current.IsEnabled; offscreen = $el.Current.IsOffscreen
  }
}
`.trim();

const PS_ACTIONS: Record<string, string> = {
  windows: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$list = @()
foreach ($w in $wins) {
  if (-not $w.Current.IsOffscreen) {
    $list += [pscustomobject]@{
      name = [string]$w.Current.Name; className = [string]$w.Current.ClassName
      pid = $w.Current.ProcessId; handle = $w.Current.NativeWindowHandle
      focused = $w.Current.HasKeyboardFocus
    }
  }
}
$list | ConvertTo-Json -Compress -Depth 3
`.trim(),
  tree: `
$maxDepth = 10
$maxItems = 120
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[1] -and $script:args[1] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[1])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = [System.Windows.Automation.AutomationElement]::FocusedElement }
Get-ElementTree $win 0 $maxDepth $maxItems
$script:out | ConvertTo-Json -Compress -Depth 3
`.trim(),
  find: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[2] -and $script:args[2] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[2])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = Find-ElementBy $win $script:args[1] $script:args[0]
if ($el -eq $null) { '{"ok":false,"reason":"element not found"}' } else { Get-ElementInfo $el | ConvertTo-Json -Compress -Depth 3 }
`.trim(),
  click: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[2] -and $script:args[2] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[2])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = Find-ElementBy $win $script:args[1] $script:args[0]
if ($el -eq $null) { '{"ok":false,"reason":"element not found"}' } else {
  try {
    $invoke = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    '{"ok":true,"method":"invoke"}'
  } catch {
    try {
      $sel = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $sel.Select()
      '{"ok":true,"method":"select"}'
    } catch {
      $rect = $el.Current.BoundingRectangle
      $script:centerX = [int]($rect.X + $rect.Width / 2)
      $script:centerY = [int]($rect.Y + $rect.Height / 2)
      "{\`"ok\`":true,\`"method\`":\`"focus\`",\`"x\`":$script:centerX,\`"y\`":$script:centerY}"
    }
  }
}
`.trim(),
  type: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[3] -and $script:args[3] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[3])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = Find-ElementBy $win $script:args[2] $script:args[1]
if ($el -eq $null) { '{"ok":false,"reason":"element not found"}' } else {
  try {
    $val = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $val.SetValue($script:args[0])
    '{"ok":true,"method":"value"}'
  } catch {
    '{"ok":false,"reason":"element not editable"}'
  }
}
`.trim(),
};

function runPs(action: string, argList: string[]): UiaResult {
  // 审查修复：PowerShell 5.1 -Command 模式附加参数不进 $args（被当独立命令执行）——
  // 参数改为内嵌脚本（单引号数组语法，单引号双写转义，中文安全），$script:args 读取
  const psArgs = argList.map(a => `'${String(a ?? '').replace(/'/g, "''")}'`).join(',');
  const ps = `${PS_HEAD}\n$script:args = @(${psArgs})\n${PS_ACTIONS[action] ?? ''}`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (r.error) return { ok: false, reason: `UIA 桥不可用：${String(r.error?.message ?? r.error).slice(0, 120)}（Windows 10+ 需 PowerShell）` };
  const raw = String(r.stdout ?? '').trim();
  if (!raw) return { ok: false, reason: `UIA 无输出（${String(r.stderr ?? '').slice(0, 120)}）` };
  const lastLine = raw.split('\n').filter(l => l.trim()).pop() ?? '';
  try {
    const j = JSON.parse(lastLine);
    if (Array.isArray(j)) return { ok: true, elements: j };
    if (j?.ok === false) return { ok: false, reason: j.reason ?? 'UIA 未找到元素' };
    return { ok: true, element: j };
  } catch {
    return { ok: false, reason: `UIA 输出解析失败：${lastLine.slice(0, 100)}` };
  }
}

/** 枚举可见窗口（非前台也列出） */
export function uiaWindows(): UiaResult {
  const r = runPs('windows', []);
  if (!r.ok) return r;
  const wins = (r.elements ?? []) as unknown as UiaWindow[];
  return { ok: true, windows: wins.filter(w => w.name && w.name !== 'Program Manager') };
}

/** 当前/指定窗口控件树（元素级结构——AI 据此定位而非盲坐标） */
export function uiaTree(handle?: string): UiaResult {
  return runPs('tree', [handle ?? '']);
}

/** 按 AutomationId 或 Name 定位元素（返回坐标与控件信息） */
export function uiaFind(query: string, handle?: string): UiaResult {
  const parts = String(query ?? '').split('|');
  const name = parts[0] ?? '';
  const id = parts[1] ?? '';
  return runPs('find', [name, id, handle ?? '']);
}

/** 元素级点击：InvokePattern → SelectionItemPattern → 坐标兜底（返回 focus 坐标可转 robotjs） */
export function uiaClick(query: string, handle?: string): UiaResult {
  const parts = String(query ?? '').split('|');
  return runPs('click', [parts[0] ?? '', parts[1] ?? '', handle ?? '']);
}

/** 元素级输入：ValuePattern.SetValue——中文原生（无剪贴板 hack） */
export function uiaType(text: string, query: string, handle?: string): UiaResult {
  const parts = String(query ?? '').split('|');
  return runPs('type', [String(text ?? ''), parts[0] ?? '', parts[1] ?? '', handle ?? '']);
}
