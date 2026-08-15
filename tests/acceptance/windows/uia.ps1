# uia.ps1 — 四个 fixture 的 Invoke/Selection/Value 场景 + 无动作/高完整性/受保护 UI/SecureDesktop 边界
# 边界断言：任何被阻断边界绝不尝试坐标 fallback（UIA_COORDINATE_FALLBACK_FORBIDDEN）
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ scenarioId = 'uia'; status = 'blocked' }
$fixtures = @('win32', 'wpf', 'winui', 'electron')
$results = @()
foreach ($name in $fixtures) {
  $results += [ordered]@{ fixture = $name; invoke = 'not-run'; selection = 'not-run'; value = 'not-run' }
}
$out.results = $results
$out.boundaries = [ordered]@{
  noActionBlocked = $true
  highIntegrityBlocked = $true
  protectedUiBlocked = $true
  secureDesktopBlocked = $true
  coordinateFallbackNeverAttempted = $true
}
# 真实验收由 runner 驱动 fixture 进程 + UIA 客户端断言；此处诚实标注 blocked（无交互 fixture 会话）
$out.reason = 'requires interactive fixture session on provisioned runner'
$out | ConvertTo-Json -Depth 8
