// src/kernel/computer/uia.ts — Windows UI Automation 桥（桌面控制上限升级）
// 审查升级：robotjs 是 Win32 消息级盲坐标（无 UI 结构感知、中文输入靠剪贴板 hack）。
// 本模块用 Windows 内置 UIAutomation（.NET，PowerShell 直调，零新增原生依赖）补上
// 「元素级」能力：窗口枚举 / 控件树 / 按 AutomationId/Name 定位 / InvokePattern 点击 /
// ValuePattern 中文原生输入——动态 UI 不再依赖脆弱坐标。
// 每个调用 spawn PowerShell（~200-500ms，工具调用可接受）；输出 JSON 解析。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

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
  # WPF 虚拟化元素 BoundingRectangle 为 ∞/NaN——坐标钳制为 0（不抛错、不谎报）
  $rx = if ([double]::IsInfinity($rect.X) -or [double]::IsNaN($rect.X)) { 0 } else { [int]$rect.X }
  $ry = if ([double]::IsInfinity($rect.Y) -or [double]::IsNaN($rect.Y)) { 0 } else { [int]$rect.Y }
  $rw = if ([double]::IsInfinity($rect.Width) -or [double]::IsNaN($rect.Width)) { 0 } else { [int]$rect.Width }
  $rh = if ([double]::IsInfinity($rect.Height) -or [double]::IsNaN($rect.Height)) { 0 } else { [int]$rect.Height }
  $interact = $ct -in @('Button','Edit','ListItem','MenuItem','Hyperlink','CheckBox','RadioButton','ComboBox','TabItem','TreeItem','DataItem')
  $hasName = $name.Length -gt 0
  $hasId = $id.Length -gt 0
  if ($interact -or $hasName -or $hasId) {
    $script:out += [pscustomobject]@{
      ct = $ct; name = $name; id = $id
      x = $rx; y = $ry; w = $rw; h = $rh
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
function Find-ElementFlexible($win, $name, $id) {
  # ct:<ControlType> 形态：按控件类型定位（宿主控件无 Name/AutomationId 时——如 notepad 的 RichEdit）
  if ($name -like 'ct:*') {
    $ctn = $name.Substring(3)
    $ctc = $null
    if ($ctn -eq 'Edit') { $ctc = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit) }
    elseif ($ctn -eq 'Document') { $ctc = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document) }
    elseif ($ctn -eq 'Text') { $ctc = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text) }
    else { return $null }
    return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $ctc)
  }
  return Find-ElementBy $win $id $name
}
function Get-ElementInfo($el) {
  $rect = $el.Current.BoundingRectangle
  $rx = if ([double]::IsInfinity($rect.X) -or [double]::IsNaN($rect.X)) { 0 } else { [int]$rect.X }
  $ry = if ([double]::IsInfinity($rect.Y) -or [double]::IsNaN($rect.Y)) { 0 } else { [int]$rect.Y }
  $rw = if ([double]::IsInfinity($rect.Width) -or [double]::IsNaN($rect.Width)) { 0 } else { [int]$rect.Width }
  $rh = if ([double]::IsInfinity($rect.Height) -or [double]::IsNaN($rect.Height)) { 0 } else { [int]$rect.Height }
  return [pscustomobject]@{
    ct = ($el.Current.ControlType.ProgrammaticName -replace 'ControlType.','')
    name = [string]$el.Current.Name; id = [string]$el.Current.AutomationId
    x = $rx; y = $ry; w = $rw; h = $rh
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
@{ windows = $list } | ConvertTo-Json -Compress -Depth 3
`.trim(),
  tree: `
$maxDepth = 10
$maxItems = 120
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[0] -and $script:args[0] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[0])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = [System.Windows.Automation.AutomationElement]::FocusedElement }
Get-ElementTree $win 0 $maxDepth $maxItems
@{ elements = $script:out } | ConvertTo-Json -Compress -Depth 3
`.trim(),
  find: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[2] -and $script:args[2] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[2])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
# ⅩⅩⅩ（C-4）：等待动态 UI 就绪（最多 3s / 150ms 间）——此前单次精确匹配，未就绪即失败靠模型重调
$el = $null
$deadline = [DateTime]::UtcNow.AddSeconds(3)
while ($el -eq $null -and [DateTime]::UtcNow -lt $deadline) {
  $el = Find-ElementBy $win $script:args[1] $script:args[0]
  if ($el -eq $null) { Start-Sleep -Milliseconds 150 }
}
if ($el -eq $null) { '{"ok":false,"reason":"element not found (waited 3s)"}' } else { Get-ElementInfo $el | ConvertTo-Json -Compress -Depth 3 }
`.trim(),
  click: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[2] -and $script:args[2] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[2])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = $null
$deadline = [DateTime]::UtcNow.AddSeconds(3)
while ($el -eq $null -and [DateTime]::UtcNow -lt $deadline) {
  $el = Find-ElementBy $win $script:args[1] $script:args[0]
  if ($el -eq $null) { Start-Sleep -Milliseconds 150 }
}
if ($el -eq $null) { '{"ok":false,"reason":"element not found (waited 3s)"}' } else {
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
      # 兜底真实点击（绝不以伪动作谎报成功）：SetCursorPos + mouse_event 按下/抬起
      $rect = $el.Current.BoundingRectangle
      $script:centerX = [int]($rect.X + $rect.Width / 2)
      $script:centerY = [int]($rect.Y + $rect.Height / 2)
      $sig = '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);'
      if (-not ('WxNodus.WxUiaClick' -as [type])) { Add-Type -MemberDefinition $sig -Name WxUiaClick -Namespace WxNodus }
      $moved = [WxNodus.WxUiaClick]::SetCursorPos($script:centerX, $script:centerY)
      [WxNodus.WxUiaClick]::mouse_event(0x0002, 0, 0, 0, 0)
      [WxNodus.WxUiaClick]::mouse_event(0x0004, 0, 0, 0, 0)
      if (-not $moved) { '{"ok":false,"reason":"click fallback failed: SetCursorPos"}' }
      else { "{\`"ok\`":true,\`"method\`":\`"mouse\`",\`"x\`":$script:centerX,\`"y\`":$script:centerY}" }
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
$el = Find-ElementFlexible $win $script:args[1] $script:args[2]
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
  // WindowsUiaDriver 端口语义：每个端口单一能力（不跨模式兜底——兜底决策在驱动层按边界裁决）
  read: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[2] -and $script:args[2] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[2])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = Find-ElementFlexible $win $script:args[0] $script:args[1]
if ($el -eq $null) { '{"ok":false,"reason":"element not found"}' } else {
  try {
    $val = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    "{\`"ok\`":true,\`"method\`":\`"read\`",\`"value\`":\`"$($val.Current.Value -replace '\`"','')\`"}"
  } catch { '{"ok":false,"reason":"no value pattern"}' }
}
`.trim(),
  findct: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[1] -and $script:args[1] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[1])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = Find-ElementFlexible $win ('ct:' + $script:args[0]) ''
if ($el -eq $null) { '{"ok":false,"reason":"control type not found"}' } else { Get-ElementInfo $el | ConvertTo-Json -Compress -Depth 3 }
`.trim(),
  invoke: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[2] -and $script:args[2] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[2])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = $null
$deadline = [DateTime]::UtcNow.AddSeconds(3)
while ($el -eq $null -and [DateTime]::UtcNow -lt $deadline) {
  $el = Find-ElementBy $win $script:args[1] $script:args[0]
  if ($el -eq $null) { Start-Sleep -Milliseconds 150 }
}
if ($el -eq $null) { '{"ok":false,"reason":"element not found (waited 3s)"}' } else {
  try {
    $invoke = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    '{"ok":true,"method":"invoke"}'
  } catch { '{"ok":false,"reason":"no invoke pattern"}' }
}
`.trim(),
  select: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[2] -and $script:args[2] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[2])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = $null
$deadline = [DateTime]::UtcNow.AddSeconds(3)
while ($el -eq $null -and [DateTime]::UtcNow -lt $deadline) {
  $el = Find-ElementBy $win $script:args[1] $script:args[0]
  if ($el -eq $null) { Start-Sleep -Milliseconds 150 }
}
if ($el -eq $null) { '{"ok":false,"reason":"element not found (waited 3s)"}' } else {
  try {
    $sel = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $sel.Select()
    '{"ok":true,"method":"select"}'
  } catch { '{"ok":false,"reason":"no selection pattern"}' }
}
`.trim(),
  mouse: `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
if ($script:args[2] -and $script:args[2] -ne '') {
  $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$script:args[2])
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if ($win -eq $null) { $win = $root }
$el = $null
$deadline = [DateTime]::UtcNow.AddSeconds(3)
while ($el -eq $null -and [DateTime]::UtcNow -lt $deadline) {
  $el = Find-ElementBy $win $script:args[1] $script:args[0]
  if ($el -eq $null) { Start-Sleep -Milliseconds 150 }
}
if ($el -eq $null) { '{"ok":false,"reason":"element not found (waited 3s)"}' } else {
  $rect = $el.Current.BoundingRectangle
  $script:centerX = [int]($rect.X + $rect.Width / 2)
  $script:centerY = [int]($rect.Y + $rect.Height / 2)
  $sig = '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);'
  if (-not ('WxNodus.WxUiaMouse' -as [type])) { Add-Type -MemberDefinition $sig -Name WxUiaMouse -Namespace WxNodus }
  $moved = [WxNodus.WxUiaMouse]::SetCursorPos($script:centerX, $script:centerY)
  [WxNodus.WxUiaMouse]::mouse_event(0x0002, 0, 0, 0, 0)
  [WxNodus.WxUiaMouse]::mouse_event(0x0004, 0, 0, 0, 0)
  if (-not $moved) { '{"ok":false,"reason":"mouse fallback failed: SetCursorPos"}' }
  else { "{\`"ok\`":true,\`"method\`":\`"mouse\`",\`"x\`":$script:centerX,\`"y\`":$script:centerY}" }
}
`.trim(),
};

export async function runPs(action: string, argList: string[]): Promise<UiaResult> {
  // 审查修复：PowerShell 5.1 -Command 模式附加参数不进 $args（被当独立命令执行）——
  // 参数改为内嵌脚本（单引号数组语法，单引号双写转义，中文安全），$script:args 读取
  const psArgs = argList.map(a => `'${String(a ?? '').replace(/'/g, "''")}'`).join(',');
  const ps = `${PS_HEAD}\n$script:args = @(${psArgs})\n${PS_ACTIONS[action] ?? ''}`;
  // V4 P2-12：spawnSync → execFileAsync（同步阻塞事件循环最长 25s——TUI 冻结根治）
  let r: { stdout?: string; stderr?: string };
  try {
    r = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
  } catch (e: any) {
    return { ok: false, reason: `UIA 桥不可用：${String(e?.message ?? e).slice(0, 120)}（Windows 10+ 需 PowerShell）` };
  }
  const raw = String(r.stdout ?? '').trim();
  if (!raw) return { ok: false, reason: `UIA 无输出（${String(r.stderr ?? '').slice(0, 120)}）` };
  const lastLine = raw.split('\n').filter(l => l.trim()).pop() ?? '';
  try {
    const j = JSON.parse(lastLine);
    // 确定性契约：windows/tree 动作显式对象字段（PS 5.1 ConvertTo-Json 对裸数组的序列化形状不定）
    if (Array.isArray(j?.windows)) return { ok: true, windows: j.windows as unknown as UiaWindow[] };
    if (Array.isArray(j?.elements)) return { ok: true, elements: j.elements as unknown as UiaElement[] };
    if (Array.isArray(j)) return { ok: true, elements: j as unknown as UiaElement[] }; // 兼容旧形态
    if (j?.ok === false) return { ok: false, reason: j.reason ?? 'UIA 未找到元素' };
    return { ok: true, element: j };
  } catch {
    return { ok: false, reason: `UIA 输出解析失败：${lastLine.slice(0, 100)}` };
  }
}

/** 枚举可见窗口（非前台也列出） */
export async function uiaWindows(): Promise<UiaResult> {
  const r = await runPs('windows', []);
  if (!r.ok) return r;
  const wins = (r.windows ?? []) as unknown as UiaWindow[];
  return { ok: true, windows: wins.filter(w => w.name && w.name !== 'Program Manager') };
}

/** 当前/指定窗口控件树（元素级结构——AI 据此定位而非盲坐标） */
export async function uiaTree(handle?: string): Promise<UiaResult> {
  return runPs('tree', [handle ?? '']);
}

/** 按 AutomationId 或 Name 定位元素（返回坐标与控件信息） */
export async function uiaFind(query: string, handle?: string): Promise<UiaResult> {
  const parts = String(query ?? '').split('|');
  const name = parts[0] ?? '';
  const id = parts[1] ?? '';
  return runPs('find', [name, id, handle ?? '']);
}

/** 元素级点击：InvokePattern → SelectionItemPattern → 坐标兜底真实 mouse_event 点击（绝不 focus 假成功） */
export async function uiaClick(query: string, handle?: string): Promise<UiaResult> {
  const parts = String(query ?? '').split('|');
  return runPs('click', [parts[0] ?? '', parts[1] ?? '', handle ?? '']);
}

/** 元素级输入：ValuePattern.SetValue——中文原生（无剪贴板 hack） */
export async function uiaType(text: string, query: string, handle?: string): Promise<UiaResult> {
  // 审查修复（P3）：参数内嵌进 -Command 命令行，CreateProcess 上限 32767 字符——
  // 超长输入截断并明确提示（避免「UIA 桥不可用」的误导归因）
  const t = String(text ?? '');
  if (t.length > 16000) {
    return { ok: false, reason: `输入过长（${t.length} 字符 > 16k 上限）——分段输入或改用剪贴板粘贴` };
  }
  const parts = String(query ?? '').split('|');
  return runPs('type', [t, parts[0] ?? '', parts[1] ?? '', handle ?? '']);
}

// ── WindowsUiaDriver 端口专用（单能力，无跨模式兜底——兜底决策在驱动层按边界裁决）──
/** 仅 InvokePattern（失败不回落 Selection/坐标） */
export async function uiaInvokeOnly(query: string, handle?: string): Promise<UiaResult> {
  const parts = String(query ?? '').split('|');
  return runPs('invoke', [parts[0] ?? '', parts[1] ?? '', handle ?? '']);
}

/** 仅 SelectionItemPattern（失败不回落） */
export async function uiaSelectOnly(query: string, handle?: string): Promise<UiaResult> {
  const parts = String(query ?? '').split('|');
  return runPs('select', [parts[0] ?? '', parts[1] ?? '', handle ?? '']);
}

/** 仅坐标鼠标点击（SetCursorPos + mouse_event 真实按下/抬起——坐标兜底端口） */
export async function uiaMouseOnly(query: string, handle?: string): Promise<UiaResult> {
  const parts = String(query ?? '').split('|');
  return runPs('mouse', [parts[0] ?? '', parts[1] ?? '', handle ?? '']);
}

/** 读取 ValuePattern 当前值（真实读回——验收端到端证据） */
export async function uiaRead(query: string, handle?: string): Promise<UiaResult> {
  const parts = String(query ?? '').split('|');
  return runPs('read', [parts[0] ?? '', parts[1] ?? '', handle ?? '']);
}

/** 按 ControlType 找窗口下第一个元素（如 notepad 的 Edit——无 Name/Id 的宿主控件） */
export async function uiaFindByCt(ct: string, handle?: string): Promise<UiaResult> {
  return runPs('findct', [String(ct ?? ''), handle ?? '']);
}


/** ⅩⅩⅪ：窗口边界 → 截屏区域（computer_observe tier=window 数据源） */
export async function uiaGetWindowRect(handle: string): Promise<import('./index.js').CaptureRegion | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const ps = `
Add-Type -AssemblyName UIAutomationClient
$win = [System.Windows.Automation.AutomationElement]::FromHandle(${parseInt(handle, 10) || 0})
if ($win -eq $null) { 'null' } else {
  $r = $win.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0 -or [double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y)) { 'null' } else {
    [math]::Floor($r.X), [math]::Floor($r.Y), [math]::Floor($r.Width), [math]::Floor($r.Height) -join ','
  }
}`;
    const r = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    const out = String(r.stdout ?? '').trim();
    if (out === 'null' || !out) return null;
    const [x, y, w, h] = out.split(',').map(Number);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, width: w, height: h };
  } catch { return null; }
}
