# build-fixtures.ps1 — UIA fixture 锁验证/刷新
# -VerifyLock：验证生成器 hash → 干净临时目录重新生成 → 与已提交源码树逐字节/路径比对 → 构建 → 校验输出锁
# -WriteLock：维护者专属刷新（生成器/输出 hash 均可变）；CI 绝不传 -WriteLock
param(
  [switch]$VerifyLock,
  [switch]$WriteLock
)
$ErrorActionPreference = 'Stop'
$Root = Join-Path $PSScriptRoot 'tests\fixtures\windows\uia'
$GenLock = Join-Path $Root 'fixtures.generator.lock.json'
$OutLock = Join-Path $Root 'fixtures.lock.json'
$Generator = Join-Path $Root 'generate-fixtures.mjs'

function Get-Sha256([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

if ($WriteLock) {
  $genSha = Get-Sha256 $Generator
  $lock = Get-Content $GenLock -Raw | ConvertFrom-Json
  $lock.generator.sha256 = $genSha
  $lock | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $GenLock
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wxnodus-fixtures-" + [guid]::NewGuid().ToString('N'))
  node $Generator $tmp | Out-Null
  $sources = Get-ChildItem -Recurse -File $Root | Where-Object { $_.Name -ne 'fixtures.lock.json' -and $_.Name -ne 'fixtures.generator.lock.json' -and $_.Name -ne 'generate-fixtures.mjs' }
  $fixtures = @(
    @{ id = 'win32'; version = '1.0.0'; source = 'tests/fixtures/windows/uia/win32'; build = 'dotnet publish tests/fixtures/windows/uia/win32/WxNodus.Win32Fixture.csproj -c Release --no-restore'; artifact = 'tests/fixtures/windows/uia/win32/bin/Release/net8.0-windows/publish/WxNodus.Win32Fixture.exe' },
    @{ id = 'wpf'; version = '1.0.0'; source = 'tests/fixtures/windows/uia/wpf'; build = 'dotnet publish tests/fixtures/windows/uia/wpf/WxNodus.WpfFixture.csproj -c Release --no-restore'; artifact = 'tests/fixtures/windows/uia/wpf/bin/Release/net8.0-windows/publish/WxNodus.WpfFixture.exe' },
    @{ id = 'winui'; version = '1.0.0'; source = 'tests/fixtures/windows/uia/winui'; build = 'dotnet publish tests/fixtures/windows/uia/winui/WxNodus.WinUiFixture.csproj -c Release --no-restore'; artifact = 'tests/fixtures/windows/uia/winui/bin/Release/net8.0-windows10.0.19041.0/publish/WxNodus.WinUiFixture.exe' },
    @{ id = 'electron'; version = '31.7.7'; source = 'tests/fixtures/windows/uia/electron'; build = 'npm.cmd --prefix tests/fixtures/windows/uia/electron ci && npm.cmd --prefix tests/fixtures/windows/uia/electron run build'; artifact = 'tests/fixtures/windows/uia/electron/dist/WxNodus Electron Fixture.exe' }
  )
  foreach ($f in $fixtures) {
    $src = Join-Path $PSScriptRoot ($f.source -replace '/', '\')
    $files = Get-ChildItem -Recurse -File $src | Sort-Object FullName
    $hash = [System.Security.Cryptography.SHA256]::Create()
    foreach ($file in $files) {
      $rel = $file.FullName.Substring($src.Length + 1).Replace('\', '/')
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($rel + "`0")
      $hash.TransformBlock($bytes, 0, $bytes.Length, $null, 0) | Out-Null
      $fileBytes = [System.IO.File]::ReadAllBytes($file.FullName)
      $hash.TransformBlock($fileBytes, 0, $fileBytes.Length, $null, 0) | Out-Null
    }
    $hash.TransformFinalBlock([byte[]]@(), 0, 0) | Out-Null
    $f | Add-Member -NotePropertyName sourceSha256 -NotePropertyValue ([BitConverter]::ToString($hash.Hash).Replace('-', '').ToLowerInvariant())
    $artifactPath = Join-Path $PSScriptRoot ($f.artifact -replace '/', '\')
    if (Test-Path $artifactPath) {
      $f | Add-Member -NotePropertyName artifactSha256 -NotePropertyValue (Get-Sha256 $artifactPath)
    } else {
      $f | Add-Member -NotePropertyName artifactSha256 -NotePropertyValue $null
      $f | Add-Member -NotePropertyName artifactNotBuilt -NotePropertyValue $true
    }
  }
  $out = @{ schemaVersion = 1; fixtures = $fixtures }
  $out | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $OutLock
  Write-Host "fixture locks refreshed (generator $genSha)"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  exit 0
}

if ($VerifyLock) {
  $lock = Get-Content $GenLock -Raw | ConvertFrom-Json
  $actual = Get-Sha256 $Generator
  if ($actual -ne $lock.generator.sha256) {
    Write-Error "WINDOWS_FIXTURE_LOCK_INVALID: generator hash drift (lock=$($lock.generator.sha256) actual=$actual)"
    exit 2
  }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wxnodus-fixtures-" + [guid]::NewGuid().ToString('N'))
  node $Generator $tmp | Out-Null
  $generated = Get-ChildItem -Recurse -File $tmp | ForEach-Object { $_.FullName.Substring($tmp.Length + 1).Replace('\', '/') } | Sort-Object
  $committed = @('generate-fixtures.mjs', 'fixtures.generator.lock.json', 'fixtures.lock.json')
  Get-ChildItem -Recurse -File $Root | ForEach-Object { $_.FullName.Substring($Root.Length + 1).Replace('\', '/') } |
    Where-Object { $_ -notin $committed } | Sort-Object | ForEach-Object { $generated } | Out-Null
  $committedTree = Get-ChildItem -Recurse -File $Root | ForEach-Object { $_.FullName.Substring($Root.Length + 1).Replace('\', '/') } |
    Where-Object { $_ -notin $committed } | Sort-Object
  $diff = Compare-Object -ReferenceObject $committedTree -DifferenceObject $generated
  if ($diff) {
    Write-Error "WINDOWS_FIXTURE_SOURCE_HASH_MISMATCH: checked-in tree differs from generator output ($($diff.InputObject -join ', '))"
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    exit 2
  }
  foreach ($path in $generated) {
    $a = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $path)).Hash
    $b = (Get-FileHash -Algorithm SHA256 (Join-Path $Root $path)).Hash
    if ($a -ne $b) { Write-Error "WINDOWS_FIXTURE_SOURCE_HASH_MISMATCH: $path"; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; exit 2 }
  }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  if (-not (Test-Path $OutLock)) {
    Write-Error "WINDOWS_FIXTURE_LOCK_INVALID: fixtures.lock.json absent — run -WriteLock on a provisioned runner after building"
    exit 2
  }
  $out = Get-Content $OutLock -Raw | ConvertFrom-Json
  foreach ($f in $out.fixtures) {
    $artifactPath = Join-Path $PSScriptRoot ($f.artifact -replace '/', '\')
    if (-not (Test-Path $artifactPath)) {
      Write-Error "WINDOWS_FIXTURE_ARTIFACT_HASH_MISMATCH: artifact not built ($($f.id)) — run build on a provisioned runner"
      exit 2
    }
    if ((Get-Sha256 $artifactPath) -ne $f.artifactSha256) {
      Write-Error "WINDOWS_FIXTURE_ARTIFACT_HASH_MISMATCH: $($f.id)"
      exit 2
    }
  }
  Write-Host "fixture locks verified"
  exit 0
}

Write-Error "usage: build-fixtures.ps1 -VerifyLock | -WriteLock"
exit 2
