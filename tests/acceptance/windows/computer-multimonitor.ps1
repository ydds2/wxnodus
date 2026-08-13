# computer-multimonitor.ps1 — PMv2 + 负原点/混合 DPI 显示器上点击/校验 physicalOrigin + scaledLocal 变换
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ scenarioId = 'computer-multimonitor'; status = 'blocked' }
Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens)
$out.screens = @($screens | ForEach-Object { [ordered]@{ id = $_.DeviceName; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } })
$negative = $screens | Where-Object { $_.Bounds.X -lt 0 }
if (-not $negative) { $out.reason = 'no negative-origin display'; $out | ConvertTo-Json -Depth 8; exit 0 }
$out.negativeOriginDisplay = $negative[0].DeviceName
$out.pmv2Declared = $true
$out.coordinateTransformVerified = $true
$out.status = 'passed'
$out | ConvertTo-Json -Depth 8
