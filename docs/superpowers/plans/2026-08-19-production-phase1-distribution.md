# 生产级完善 阶段 1（分发闭环）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「其他电脑 cmd 一条命令/双击装完即用」成为现实——自包含 zip + 三源安装 + 零到处配置首启 + /update 真实渠道 + CI 安装冒烟验收。

**Architecture:** 基于既有 W6 管线（freeze-candidate → package-installer → installerPackager 确定性 zip + sha256 manifest + install.ps1 原子安装/journal 卸载）做增量：安装脚本强化（Node 检测/PATH/命令名/数据目录注入/install-meta）、zip 内双击向导 install.bat、仓内 install-bootstrap.ps1 三源下载入口、首启四步清单 + GitHub 连通探测、/update zip 渠道、CI 安装冒烟 job。

**Tech Stack:** TypeScript 严格 ESM · PowerShell 5.1 兼容（纯 .NET sha256）· bat · vitest · GitHub Actions（windows-latest）

## Global Constraints

- 规格依据：`docs/superpowers/specs/2026-08-19-production-readiness-design.md`（用户已确认）；三决策：暂不公开、自包含 zip + 一键脚本、全量范围。
- PowerShell 模板**纯 ASCII**（PS 5.1 无 BOM 按 ANSI 解析），写入时 UTF-8 BOM 双保险；appName 一律经 `psSingleQuotedLiteral` 编码，绝不裸插入。
- 引用竞品机制须参考不抄袭（AGENTS.md 约束）；本阶段无竞品对标改动。
- 诚实口径：任何「无法探测/失败」路径必须输出诚实指引，绝不假装成功；zip 渠道 /update 无法远程探测时如实说明。
- 执行前先 `git status` 确认工作树干净（并发会话在活跃开发，冲突即停）。
- 每任务结束：单测绿 + `npx tsc --noEmit` 绿；全阶段末 `npm run ci` 九步 + 远程 CI 绿。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/application/release/installerPackager.ts` | 修改 | installScript 模板：Node 检测/PATH 注册/-SkipPath/`<appName>.cmd`+`WXNODUS_DATA_DIR` 注入/install-meta.json/journal 更新；zip 内新增 `install.bat` 条目 |
| `tests/installer-packager.contract.test.ts` | 修改 | 期望更新（start.cmd→wxnodusart.cmd）+ 新断言（Node 检测/install-meta/install.bat 内容/真实安装走 -SkipPath） |
| `packaging/install-bootstrap.ps1` | 新建 | 三源下载入口（-Url / -GitHub / 本地直调），解包后转调 zip 内 install.ps1；gh auth 探测与一步指引；Token 不落盘 |
| `tests/install-bootstrap.contract.test.ts` | 新建 | bootstrap 内容契约（https 强制/gh 探测/Expand-Archive 转调/Token 不落盘字面断言） |
| `src/commands/updateCheck.ts` | 修改 | `findInstallMeta`（上探 install-meta.json）+ 渠道 `'zip'` + 报告 installMeta + zip 渠道指引；`probeOutbound`（注入式 fetch，超时） |
| `src/bootstrap/setupWizard.ts` | 修改 | 首次引导语言选择后输出四步清单（模型/密钥/代理/离线）；`probeOutbound` 注入点（默认真实，测试注入失败态） |
| `src/application/i18n/catalogs/zh-CN.ts`、`en.ts` | 修改 | 清单文案键 `onboarding.checklist.*` |
| `tests/update-check.test.ts` | 修改 | zip 渠道检测/meta 上探/指引/HEAD 探测成功与诚实降级用例 |
| `tests/cli-first-run-language.test.ts` | 修改 | 首次运行输出清单、二次运行不输出、探测失败→代理建议（注入 probe） |
| `.github/workflows/ci.yml` | 修改 | 新增 `install-smoke` job：freeze→package→真实安装到临时目录→`wxnodus --version`→卸载 |
| `docs/getting-started.md` | 修改 | 「一键安装」章节（三源 + Node 前置 + 国内镜像） |
| `CHANGELOG.md` | 修改 | 阶段 1 条目 |

---

### Task 1: install.ps1 强化（Node 检测 / PATH / 命令名 / 数据目录 / install-meta）

**Files:**
- Modify: `src/application/release/installerPackager.ts`（`installScript` 模板 :52-161）
- Test: `tests/installer-packager.contract.test.ts`

**Interfaces:**
- Consumes: `sanitizeAppName`（既有）、`psSingleQuotedLiteral`（既有）
- Produces: 生成脚本新增行为——`INSTALLER_NODE_MISSING`（exit 1）、`WARN: Node <22`、`PATH_UPDATED`、`REINSTALL_SAME_VERSION`（同版本重装提示）、`-SkipPath` 开关、`-Source`（写入 install-meta 供 /update 探测）、`<appName>.cmd`（含 `WXNODUS_DATA_DIR=%LOCALAPPDATA%\wxnodus` 注入）、`install-meta.json`（`{app,version,installedAt,source}`）入 journal

- [ ] **Step 1: 写失败测试**（`tests/installer-packager.contract.test.ts`，在「install.ps1 真实安装」describe 内改既有期望并新增断言）

```ts
  it('解包目录中执行 install.ps1：全量校验通过 → 安装到目标目录 + <appName>.cmd + install-meta', async () => {
    const packed = await buildInstallerPackage({
      appName: 'WxNodusArt', version: '1.2.3', icon: '🛠️', entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const unpackDir = join(root, 'unpacked');
    mkdirSync(unpackDir, { recursive: true });
    extract(readFileSync(packed.value.zipPath), unpackDir);
    const target = join(root, 'installed');
    // -SkipPath：CI 不污染用户 PATH（PATH 注册为交互安装默认行为）
    const result = await runInstaller(join(unpackDir, 'install.ps1'), target, ['-SkipPath']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`INSTALLED: ${target}`);
    expect(existsSync(join(target, 'bin', 'wxnodus.js'))).toBe(true);
    // 命令名 = 清洗后 appName；内容注入数据目录并转发参数
    const cmd = readFileSync(join(target, 'wxnodusart.cmd'), 'utf8');
    expect(cmd).toContain('node "%~dp0bin\\wxnodus.js"');
    expect(cmd).toContain('WXNODUS_DATA_DIR=%LOCALAPPDATA%\\wxnodus');
    expect(existsSync(join(target, 'start.cmd'))).toBe(false);
    // install-meta：供 /update 识别 zip 渠道
    const meta = JSON.parse(readFileSync(join(target, 'install-meta.json'), 'utf8'));
    expect(meta).toMatchObject({ app: 'wxnodusart', version: '1.2.3' });
  }, 60_000);

  it('生成脚本含 Node 检测与 PATH 注册与卸载 journal 含 meta', async () => {
    const packed = await buildInstallerPackage({
      appName: 'WxNodusArt', version: '1.2.3', icon: null, entryPath: 'bin/wxnodus.js', files: fixtureFiles(), outDir: root,
    });
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const unpackDir = join(root, 'unpacked');
    mkdirSync(unpackDir, { recursive: true });
    extract(readFileSync(packed.value.zipPath), unpackDir);
    const script = readFileSync(join(unpackDir, 'install.ps1'), 'utf8');
    expect(script).toContain('INSTALLER_NODE_MISSING');
    expect(script).toContain('nodejs.org');
    expect(script).toContain('npmmirror.com/mirrors/node');
    expect(script).toContain('PATH_UPDATED');
    expect(script).toContain('SkipPath');
    expect(script).toContain('install-meta.json');
    // install.bat 双击向导在包内
    const bat = readFileSync(join(unpackDir, 'install.bat'), 'utf8');
    expect(bat).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File');
    expect(bat).toContain('pause');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/installer-packager.contract.test.ts`
Expected: 失败——`wxnodusart.cmd` 不存在（ENOENT）、install.ps1 不含 INSTALLER_NODE_MISSING、zip 内无 install.bat

- [ ] **Step 3: 改 `installerPackager.ts` 模板**

`installScript` 内，param 块后、`$Root = …` 之前插入 Node 检测；param 块加 `-SkipPath`：

```ts
  const body = `# wxnodus installer (generated by installerPackager - deterministic install script)
# Verifies every manifest file sha256 before installing; any drift -> exit 1
# DX-04 lifecycle: staging -> postcondition -> atomic switch (backup/rollback recover)
# -> ownership journal (.wxnodus-journal.json); -Uninstall deletes journaled files only.
# Phase-1: Node 18+ preflight (22 recommended, CN mirror guidance), user-PATH registration
# (opt-out -SkipPath), command shim <appName>.cmd with WXNODUS_DATA_DIR injection,
# install-meta.json for /update zip-channel detection.
param(
  [string]$TargetDir = (Join-Path "$env:LOCALAPPDATA\\Programs" ${appNameLiteral}),
  [switch]$DryRun,
  [switch]$Uninstall,
  [switch]$SkipPath,
  [string]$Source = ''
)
$ErrorActionPreference = 'Stop'
$NodeOk = $false
try {
  $NodeVer = & node -v 2>$null
  if ($NodeVer -match '^v(\\d+)\\.') {
    $major = [int]$Matches[1]
    if ($major -ge 18) {
      $NodeOk = $true
      if ($major -lt 22) { Write-Output "WARN: Node $NodeVer 低于推荐版本 22（可继续安装，个别特性需 22）" }
    }
  }
} catch { }
if (-not $NodeOk) {
  Write-Error "INSTALLER_NODE_MISSING: 需要 Node.js 18+（推荐 22）——官方 https://nodejs.org/ 或国内镜像 https://npmmirror.com/mirrors/node/ 安装后重跑本脚本"
  exit 1
}
```

Uninstall 分支不变；journal 构造处 `$OwnedFiles` 两行替换（`start.cmd` → appName 命令 + meta）：

```ts
$OwnedFiles = @($Manifest.files | ForEach-Object { $_.path }) + @((${appNameLiteral} + '.cmd'), 'manifest.json', 'install-meta.json')
```

staging 后 `Set-Content start.cmd` 块替换为：

```ts
Set-Content -Path (Join-Path $Staging (${appNameLiteral} + '.cmd')) -Encoding ASCII -Value "@echo off`r`nset `"WXNODUS_DATA_DIR=%LOCALAPPDATA%\\wxnodus`"`r`nnode `"%~dp0$entryRelative`" %*"
```

journal 写入块（`Set-Content … $JournalContent`）之后追加 meta 与 PATH 注册：

```ts
$Meta = @{ app = $Manifest.appName; version = $Manifest.version; installedAt = (Get-Date -Format 'o') }
if ($Source) { $Meta['source'] = $Source }
$MetaContent = $Meta | ConvertTo-Json
Set-Content -Path (Join-Path $TargetDir 'install-meta.json') -Encoding UTF8 -Value $MetaContent
# 幂等提示：目标已装同版本（读旧 install-meta.json）→ 明示重装覆盖，数据目录不受影响
$OldMeta = Join-Path $TargetDir 'install-meta.json'
if (Test-Path $OldMeta) {
  try {
    $Old = [System.IO.File]::ReadAllText($OldMeta, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($Old.version -eq $Manifest.version) { Write-Output "REINSTALL_SAME_VERSION: $($Manifest.version)（覆盖安装——%LOCALAPPDATA%\wxnodus 数据保留）" }
  } catch { }
}
if (-not $SkipPath) {
  try {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -and (($userPath -split ';') -contains $TargetDir)) {
      Write-Output "PATH_ALREADY_PRESENT: $TargetDir"
    } else {
      $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $TargetDir } else { $TargetDir }
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      Write-Output "PATH_UPDATED: $TargetDir"
    }
  } catch {
    Write-Output "WARN: PATH 注册失败（可手动加入）：$TargetDir"
  }
}
```

zip 条目处（`installScript` 外，`buildInstallerPackage` 内 entries 数组）加 install.bat（静态模板，UTF-8 无 BOM）：

```ts
const installBat = Buffer.from(`@echo off\r\nrem wxnodus one-click installer (double-click, no command line needed)\r\nsetlocal\r\nset "DIR=%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo [x] Node.js not found. Install Node 18+ (recommended 22):\r\n  echo     https://nodejs.org/  ^(CN mirror: https://npmmirror.com/mirrors/node/^)\r\n  pause\r\n  exit /b 1\r\n)\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%install.ps1"\r\nif errorlevel 1 (\r\n  echo [!] Install failed - see messages above.\r\n  pause\r\n  exit /b 1\r\n)\r\necho.\r\necho [OK] Installed. Open a NEW cmd window and run: wxnodus\r\npause\r\n`, 'utf8');
```

entries 数组加 `{ path: 'install.bat', content: installBat }`（与 manifest.json/install.ps1 并列）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/installer-packager.contract.test.ts`
Expected: 全绿（读回自校验测试对 entries.size 断言需同步为 6——manifest.json + install.ps1 + install.bat + 3 文件）

- [ ] **Step 5: 提交**

```bash
git add src/application/release/installerPackager.ts tests/installer-packager.contract.test.ts
git commit -m "feat(installer): install.ps1 Node 预检/PATH 注册/-SkipPath/<appName>.cmd 数据目录注入/install-meta + zip 内 install.bat 双击向导"
```

---

### Task 2: install-bootstrap.ps1 三源下载入口（URL / GitHub / 本地）

**Files:**
- Create: `packaging/install-bootstrap.ps1`
- Test: `tests/install-bootstrap.contract.test.ts`（内容契约，不真联网）

**Interfaces:**
- Consumes: 无（独立脚本；下载后转调 zip 内 install.ps1，参数 -TargetDir/-DryRun 透传）
- Produces: `param(-Url, -GitHub, -Tag, -TargetDir, -DryRun)`；`BOOTSTRAP_URL_NOT_HTTPS`（非 https 拒绝 exit 1）；gh 未登录 → `BOOTSTRAP_GH_AUTH_REQUIRED` 指引 exit 1；成功路径输出 `BOOTSTRAP_OK: <临时解包目录>（运行 install.ps1 完成安装）`

- [ ] **Step 1: 写失败测试**

```ts
// tests/install-bootstrap.contract.test.ts — 三源下载入口内容契约（不真联网：断言脚本字面行为）
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const script = readFileSync(join(__dirname, '..', 'packaging', 'install-bootstrap.ps1'), 'utf8');

describe('install-bootstrap.ps1 内容契约', () => {
  it('三源参数与 https 强制', () => {
    expect(script).toContain('[string]$Url');
    expect(script).toContain('[string]$GitHub');
    expect(script).toContain('BOOTSTRAP_URL_NOT_HTTPS');
    expect(script).toContain('-not $Url.StartsWith');
    expect(script).toContain('https://');
  });
  it('GitHub 源走 gh 并探测登录态，Token 不落盘', () => {
    expect(script).toContain('gh auth status');
    expect(script).toContain('BOOTSTRAP_GH_AUTH_REQUIRED');
    expect(script).toContain('gh release download');
    expect(script).not.toContain('GITHUB_TOKEN=');
    expect(script).not.toContain('Authorization');
  });
  it('解包后转调 zip 内 install.ps1 并透传 -TargetDir/-DryRun', () => {
    expect(script).toContain('Expand-Archive');
    expect(script).toContain('install.ps1');
    expect(script).toContain('$TargetDir');
    expect(script).toContain('$DryRun');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/install-bootstrap.contract.test.ts`
Expected: 失败——文件不存在

- [ ] **Step 3: 创建脚本**（纯 ASCII，保存时 UTF-8 BOM 同 install.ps1 手法——此处直接文件写 ASCII 内容）

```powershell
# wxnodus install-bootstrap (checked-in, NOT generated): three-source download entry.
# Source A (default): zip already at hand -> skip download, extract and delegate.
# Source B: -Url https://... (https enforced; user-run script, URL is user's own input)
# Source C: -GitHub owner/repo [-Tag v3.1.0] -> gh release download (gh auth status gate;
#           no token written to disk, no token embedded).
param(
  [string]$Zip = '',
  [string]$Url = '',
  [string]$GitHub = '',
  [string]$Tag = 'latest',
  [string]$TargetDir = (Join-Path "$env:LOCALAPPDATA\Programs" 'wxnodus'),
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ('wxnodus-bootstrap-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
  $ZipPath = $Zip
  if ($Zip -and -not (Test-Path $Zip)) { Write-Error "BOOTSTRAP_ZIP_NOT_FOUND: $Zip"; exit 1 }
  if ($Url) {
    if (-not $Url.StartsWith('https://')) { Write-Error "BOOTSTRAP_URL_NOT_HTTPS: 仅支持 https 下载源"; exit 1 }
    $ZipPath = Join-Path $Temp 'wxnodus.zip'
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
  }
  if ($GitHub) {
    & gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Error "BOOTSTRAP_GH_AUTH_REQUIRED: 需先 gh auth login（未装 gh：winget install GitHub.cli）——私有仓库下载需登录；登录后重跑本脚本"
      exit 1
    }
    $ZipPath = Join-Path $Temp 'wxnodus.zip'
    & gh release download $Tag --repo $GitHub --pattern '*.zip' --dir $Temp
    $Downloaded = Get-ChildItem $Temp -Filter '*.zip' | Select-Object -First 1
    if (-not $Downloaded) { Write-Error "BOOTSTRAP_GH_NO_ASSET: 未找到 zip 资产（-Tag $Tag -GitHub $GitHub）"; exit 1 }
    $ZipPath = $Downloaded.FullName
  }
  if (-not $ZipPath) {
    Write-Error 'BOOTSTRAP_NO_SOURCE: 需提供 -Zip <路径> 或 -Url <https URL> 或 -GitHub <owner/repo>'
    exit 1
  }
  $Unpack = Join-Path $Temp 'unpacked'
  New-Item -ItemType Directory -Force -Path $Unpack | Out-Null
  Expand-Archive -Path $ZipPath -DestinationPath $Unpack -Force
  $Inner = Get-ChildItem $Unpack -Recurse -Filter 'install.ps1' | Select-Object -First 1
  if (-not $Inner) { Write-Error 'BOOTSTRAP_NO_INSTALLER: zip 内无 install.ps1（非 wxnodus 安装包）'; exit 1 }
  $Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Inner.FullName)
  if ($TargetDir) { $Args += @('-TargetDir', $TargetDir) }
  if ($DryRun) { $Args += '-DryRun' }
  if ($Url) { $Args += @('-Source', $Url) }
  & powershell.exe @Args
  exit $LASTEXITCODE
} finally {
  Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/install-bootstrap.contract.test.ts`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add packaging/install-bootstrap.ps1 tests/install-bootstrap.contract.test.ts
git commit -m "feat(installer): install-bootstrap.ps1 三源下载入口（本地/URL/https 强制/GitHub gh 探测，Token 不落盘）+ 内容契约测试"
```

---

### Task 3: /update zip 渠道识别 + 远程版本探测

**Files:**
- Modify: `src/commands/updateCheck.ts`、`src/commands/handlers.ts`（/update 注册处 :321-345）
- Test: `tests/update-check.test.ts`

**Interfaces:**
- Consumes: `WXNODUS_VERSION`（既有）
- Produces:
  - `export interface InstallMeta { app: string; version: string; installedAt?: string; source?: string }`
  - `export function findInstallMeta(modulePath: string, readFile?: (p: string) => string | null): InstallMeta | null`（沿模块路径上探 ≤5 层找 `install-meta.json`）
  - `UpdateReport` 增字段 `installMeta: InstallMeta | null`（buildUpdateReport 内由 findInstallMeta 填）
  - `detectInstallChannel` 扩展：先查 install-meta → `'zip'`
  - `export async function probeRemoteVersion(source: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; version?: string; message: string }>`（仅 https；HEAD 请求 4s 超时；从 Content-Disposition/finalURL 提取 `\d+\.\d+\.\d+`；失败诚实 message）
  - `channelGuidance` 增 `'zip'` 分支
  - `/update` 处理器：`report.installMeta?.source` 存在 → `await probeRemoteVersion(source)` 追加「远程最新：x.y.z」或诚实降级行

- [ ] **Step 1: 写失败测试**（`tests/update-check.test.ts` 追加）

```ts
describe('zip 渠道（install-meta）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wx-upd-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('findInstallMeta 上探命中 / 缺失返回 null / JSON 损坏返回 null', () => {
    const base = join(tmp, 'a', 'b', 'c');
    mkdirSync(join(tmp, 'a'), { recursive: true });
    writeFileSync(join(tmp, 'a', 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '3.1.0', source: 'https://x.example/wxnodus-3.1.0.zip' }), 'utf8');
    const meta = findInstallMeta(join(base, 'x.js'));
    expect(meta).toMatchObject({ app: 'wxnodus', version: '3.1.0' });
    expect(findInstallMeta(join(tmp, 'other', 'x.js'))).toBeNull();
    writeFileSync(join(tmp, 'a', 'install-meta.json'), '{broken', 'utf8');
    expect(findInstallMeta(join(base, 'x.js'))).toBeNull();
  });

  it('detectInstallChannel 识别 zip 优先于 git', () => {
    const dir = join(tmp, 'zipdir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'install-meta.json'), JSON.stringify({ app: 'wxnodus', version: '3.1.0' }), 'utf8');
    expect(detectInstallChannel(join(dir, 'dist', 'cli', 'index.js'))).toBe('zip');
  });

  it('probeRemoteVersion：HEAD 提取版本；非 https 拒绝；失败诚实', async () => {
    const okFetch = (async () => new Response('', { status: 200, headers: { 'content-disposition': 'attachment; filename="wxnodus-3.2.0.zip"' } })) as unknown as typeof fetch;
    const r1 = await probeRemoteVersion('https://x.example/wxnodus-3.2.0.zip', okFetch);
    expect(r1.ok).toBe(true);
    expect(r1.version).toBe('3.2.0');
    const r2 = await probeRemoteVersion('http://x.example/a.zip', okFetch);
    expect(r2.ok).toBe(false);
    const badFetch = (async () => { throw new Error('net down'); }) as unknown as typeof fetch;
    const r3 = await probeRemoteVersion('https://x.example/a.zip', badFetch);
    expect(r3.ok).toBe(false);
    expect(r3.message.length).toBeGreaterThan(0);
  });

  it('channelGuidance zip 分支：无 source 诚实说明 / 有 source 给升级指引', () => {
    const g1 = channelGuidance('zip', null);
    expect(g1).toContain('zip');
    expect(g1).toContain('无法自动探测');
    const g2 = channelGuidance('zip', null);
    expect(g2).toContain('install.ps1');
  });
});
```

（注意文件顶部需补 `import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'` 与 `tmpdir`/`join`——若既有 import 已含则复用。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/update-check.test.ts`
Expected: 失败——`findInstallMeta`/`probeRemoteVersion` 不存在

- [ ] **Step 3: 实现 updateCheck.ts 增量**

```ts
export interface InstallMeta { app: string; version: string; installedAt?: string; source?: string }

/** zip 渠道元数据（install.ps1 安装时写入 install-meta.json）：沿模块路径上探 ≤5 层。 */
export function findInstallMeta(modulePath: string, readFile: (p: string) => string | null = p => { try { return require('node:fs').readFileSync(p, 'utf8'); } catch { return null; } }): InstallMeta | null {
  let dir = dirname(modulePath);
  for (let i = 0; i < 5; i++) {
    const metaPath = join(dir, 'install-meta.json');
    const text = readFile(metaPath);
    if (text !== null) {
      try {
        const meta = JSON.parse(text) as InstallMeta;
        if (meta && typeof meta.app === 'string' && typeof meta.version === 'string') return meta;
      } catch { return null; }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 远程版本探测（zip+URL 源）：仅 https；HEAD 4s 超时；版本号从 Content-Disposition 文件名提取。 */
export async function probeRemoteVersion(source: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; version?: string; message: string }> {
  if (!/^https:\/\//.test(source)) return { ok: false, message: `更新源非 https，拒绝探测：${source}` };
  try {
    const res = await fetchImpl(source, { method: 'HEAD', signal: AbortSignal.timeout(4000), redirect: 'follow' });
    if (!res.ok && res.status !== 200) return { ok: false, message: `更新源响应 ${res.status}` };
    const disposition = res.headers.get('content-disposition') ?? '';
    const url = res.url ?? source;
    const m = /(\d+\.\d+\.\d+)/.exec(`${disposition} ${url}`);
    if (!m) return { ok: false, message: '响应中未解析出版本号（Content-Disposition/URL 均无）' };
    return { ok: true, version: m[1]!, message: '' };
  } catch (e: any) {
    return { ok: false, message: `探测失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
}
```

`detectInstallChannel` 首行改为：

```ts
export function detectInstallChannel(modulePath: string): InstallChannel {
  if (findInstallMeta(modulePath)) return 'zip';
  const norm = modulePath.replace(/\\/g, '/');
  ...
}
```

`channelGuidance` switch 增分支：

```ts
    case 'zip':
      return '离线 zip 安装渠道：下载新版 wxnodus-<版本>.zip → 解压 → 双击 install.bat（或 powershell -ExecutionPolicy Bypass -File install.ps1）幂等覆盖安装；数据目录与密钥保留（安装不删 %LOCALAPPDATA%\\wxnodus）。当前安装源未记录远程地址——无法自动探测最新版（诚实说明）';
```

`buildUpdateReport`（文件尾既有函数）增 `installMeta` 透出（`installMeta: findInstallMeta(modulePath)` 入报告）。`handlers.ts` /update 处理器在 `const base = lines(...)` 之后追加：

```ts
    if (report.installMeta?.source) {
      const { probeRemoteVersion } = await import('./updateCheck.js');
      const remote = await probeRemoteVersion(report.installMeta.source);
      return base + (remote.ok
        ? `\n 远程最新：${remote.version}（安装源 ${report.installMeta.source}）——下载新版 zip 解压重跑 install.ps1 即升级（数据保留）`
        : `\n 远程探测失败：${remote.message}（离线渠道诚实降级）`);
    }
```

（若文件尾为别处结构，按实际位置改；断言点不变：报告含 installMeta、handler 对 source 分支探测。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/update-check.test.ts`
Expected: 全绿（既有 git 渠道用例不回归）

- [ ] **Step 5: 提交**

```bash
git add src/commands/updateCheck.ts tests/update-check.test.ts
git commit -m "feat(update): /update zip 渠道识别（install-meta 上探）+ probeRemoteVersion HEAD 探测（https 强制/注入式 fetch 可测）"
```

---

### Task 4: 首启四步清单 + GitHub 连通探测

**Files:**
- Modify: `src/bootstrap/setupWizard.ts`（注入 `probeOutbound` 参数；onboarding-required 后输出清单）
- Modify: `src/application/i18n/catalogs/zh-CN.ts`、`en.ts`（`onboarding.checklist.*` 键）
- Test: `tests/cli-first-run-language.test.ts`

**Interfaces:**
- Consumes: `probeRemoteVersion`（Task 3，探测 `https://api.github.com` 用简化版——本任务用独立 `probeOutbound`：仅连通性，不加版本解析）
- Produces: `export async function probeOutbound(url: string, fetchImpl?: typeof fetch, timeoutMs?: number): Promise<{ ok: boolean; message: string }>`（放 `updateCheck.ts` 或 `setupWizard` 同层——放 `updateCheck.ts` 导出，与 probe 系列同族）

- [ ] **Step 1: 写失败测试**（`tests/cli-first-run-language.test.ts` 追加 describe；注入 `probeOutbound` 模拟失败）

```ts
describe('首启四步清单', () => {
  it('首次运行输出清单（模型/密钥/代理/离线指引）；二次运行不输出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-firstrun-'));
    const run = (extraArgs: string[]) => spawnSync(process.execPath, [join(ROOT, 'dist', 'cli', 'index.js'), '--data-dir', dir, '--lang', 'zh-CN', ...extraArgs, '--version'], { encoding: 'utf8', windowsHide: true });
    // 先跑一次触发 onboarding，抓 stdout
    const first = spawnSync(process.execPath, [join(ROOT, 'dist', 'cli', 'index.js'), '--data-dir', dir, '--lang', 'zh-CN', '-p', '/status'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    expect(first.stdout).toContain('模型');
    expect(first.stdout).toContain('set-key');
    expect(first.stdout).toContain('代理');
    const second = spawnSync(process.execPath, [join(ROOT, 'dist', 'cli', 'index.js'), '--data-dir', dir, '--lang', 'zh-CN', '-p', '/status'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    expect(second.stdout).not.toContain('set-key');
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
```

（注意：若既有测试用 mock setupWizard 而非真 spawn，则改注入 probeOutbound 单测 wizard 纯函数——以文件实际结构为准，断言点不变：清单四段 + 二次不重复。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/cli-first-run-language.test.ts`
Expected: 失败——stdout 无清单

- [ ] **Step 3: 实现**

`updateCheck.ts` 追加：

```ts
/** 出站连通探测（首启代理指引用）：2.5s 超时；失败诚实 message。 */
export async function probeOutbound(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2500): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok || res.status < 500, message: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e).slice(0, 120) };
  }
}
```

`setupWizard.ts`：入参加 `probeOutbound?: typeof probeOutbound`（默认真实实现，测试注入失败态）。onboarding-required 输出欢迎语之后：

```ts
if (pre.mode === 'onboarding-required') {
  const { translate } = await import('../application/i18n/i18nService.js');
  process.stdout.write(`${translate(locale, 'onboarding.welcome')}\n`);
  const { probeOutbound: realProbe } = await import('../commands/updateCheck.js');
  const net = await (opts.probeOutbound ?? realProbe)('https://api.github.com');
  process.stdout.write(translate(locale, 'onboarding.checklist.model') + '\n');
  process.stdout.write(translate(locale, 'onboarding.checklist.key') + '\n');
  process.stdout.write(net.ok ? translate(locale, 'onboarding.checklist.proxy.ok') + '\n' : translate(locale, 'onboarding.checklist.proxy.fail') + '\n');
  process.stdout.write(translate(locale, 'onboarding.checklist.offline') + '\n');
}
```

（`opts` 为 runSetupWizard 实际入参名——按文件实际结构接线。）

`zh-CN.ts` 增键：

```ts
  'onboarding.checklist.model': ' · 模型：/model 查看目录（默认 deepseek-chat；离线模型 /offline on 一键拉取）',
  'onboarding.checklist.key': ' · 密钥：/model set-key <key>（AES-256-GCM 本机加密，明文不落盘）',
  'onboarding.checklist.proxy.ok': ' · 网络：GitHub 连通正常',
  'onboarding.checklist.proxy.fail': ' · 网络：GitHub 探测不通——若需访问外网请 /proxy 配置代理，或全程离线（数据不出机）',
  'onboarding.checklist.offline': ' · 全部就绪后可 /doctor 自检、/help 查看命令',
```

`en.ts` 增对应英文键（内容自拟，语义一致）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/cli-first-run-language.test.ts`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/bootstrap/setupWizard.ts src/commands/updateCheck.ts src/application/i18n/catalogs/zh-CN.ts src/application/i18n/catalogs/en.ts tests/cli-first-run-language.test.ts
git commit -m "feat(onboarding): 首启四步清单（模型/密钥/代理/离线）+ probeOutbound GitHub 连通探测（注入式可测，2.5s 超时）"
```

---

### Task 5: CI 安装冒烟 job（真实「其他电脑」验收）

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: 无需单测（CI job 本体即测试）

**Interfaces:**
- Consumes: gate job 的 dist 工件（既有）、Task 1-2 产物
- Produces: `install-smoke` job——`needs: [gate]`，验证「装完即用」闭环

- [ ] **Step 1: 追加 job**（ci.yml 末尾）

```yaml
  install-smoke:
    name: install-smoke (zip → install → run → uninstall)
    runs-on: windows-latest
    needs: gate
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist
      - name: npm install
        run: npm install --ignore-scripts --no-audit --no-fund
      - name: build installer zip (freeze → package)
        run: |
          npm run build:freeze
          npm exec -- tsx scripts/package-installer.ts --candidate dist-installer/candidate.json --name wxnodus --version 0.0.0-ci --out dist-installer
      - name: install to temp target (real install.ps1, -SkipPath)
        shell: pwsh
        run: |
          $unpack = Join-Path $env:RUNNER_TEMP 'wxsmoke-unpack'
          Expand-Archive -Path (Get-ChildItem dist-installer -Filter '*.zip' | Select-Object -First 1).FullName -DestinationPath $unpack -Force
          $target = Join-Path $env:RUNNER_TEMP 'wxsmoke-installed'
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $unpack 'install.ps1') -TargetDir $target -SkipPath
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      - name: run installed binary
        shell: cmd
        run: |
          set "WXNODUS_DATA_DIR=%RUNNER_TEMP%\wxsmoke-data"
          call "%RUNNER_TEMP%\wxsmoke-installed\wxnodus.cmd" --version
      - name: uninstall (journal-only)
        shell: pwsh
        run: |
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Join-Path $env:RUNNER_TEMP 'wxsmoke-unpack') 'install.ps1') -TargetDir (Join-Path $env:RUNNER_TEMP 'wxsmoke-installed') -Uninstall
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

（`build:freeze` 若 package.json 无此 script，则按 W6 实际命令改写：`node scripts/freeze-candidate.mjs …`——以 package.json 既有 scripts 为准，不得杜撰；candidate 输出路径以 freeze 实现为准。）

- [ ] **Step 2: 本地 YAML 校验**

Run: `node -e "require('yaml')" 2>/dev/null || true; npm exec -- tsx -e "" ` ——实际以仓库既有 YAML 校验方式为准（此前 audit 记录「本地 YAML 语法+结构校验通过」）。人工核对步骤引用的脚本名与 package.json 一致。

- [ ] **Step 3: 推送 + 远程 CI 绿**

Run: `git push`（经全局代理 127.0.0.1:7897）→ `gh run watch` → 期望 `install-smoke` job success

- [ ] **Step 4: 提交**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: install-smoke job——zip 构建→真实安装→运行 --version→journal 卸载（全新 runner 验收「其他电脑」闭环）"
```

---

### Task 6: 文档与收尾（一键安装章节 + CHANGELOG + 本地门禁）

**Files:**
- Modify: `docs/getting-started.md`、`CHANGELOG.md`

**Interfaces:** 无新接口；`tests/docs-links.test.ts` 对账保护（新文档引用的命令必须已注册——本任务不引新命令，零风险）。

- [ ] **Step 1: getting-started.md 增「一键安装」章节（替换「快速开始」中的 npm link 段，保留开发者路径）**

```markdown
## 一键安装（推荐——其他电脑 cmd 装完即用）

前置：Node.js 18+（推荐 22）——https://nodejs.org/（国内镜像 https://npmmirror.com/mirrors/node/）。

- 源 A（离线/局域网/U盘）：拿到 `wxnodus-<版本>.zip` → 解压 → **双击 `install.bat`**（自动校验、安装、写 PATH）→ 新开 cmd 运行 `wxnodus`。
- 源 B（URL）：`powershell -ExecutionPolicy Bypass -File install-bootstrap.ps1 -Url <https://…/wxnodus-<版本>.zip>`
- 源 C（私有 GitHub Release）：`powershell -ExecutionPolicy Bypass -File install-bootstrap.ps1 -GitHub <owner>/<repo> -Tag <版本>`（需先 `gh auth login`）。

安装后：数据目录 `%LOCALAPPDATA%\wxnodus`（密钥 AES-256-GCM 本机加密）；升级 = 下载新 zip 重跑安装（数据保留）；卸载 = `install.ps1 -Uninstall`（只删安装文件，不删数据）。
```

- [ ] **Step 2: CHANGELOG 顶部增阶段 1 条目**

```markdown
## 阶段 1：生产级分发闭环（2026-08-19）
- install.ps1：Node 18+ 预检（22 推荐 + 国内镜像指引）、用户 PATH 注册（-SkipPath 可关）、`<appName>.cmd` 命令 shim（注入 WXNODUS_DATA_DIR=%LOCALAPPDATA%\wxnodus）、install-meta.json（/update 渠道识别）
- zip 内置 install.bat 双击向导（零命令行安装）
- packaging/install-bootstrap.ps1 三源下载（本地/URL https 强制/GitHub gh 探测，Token 不落盘）
- 首启四步清单（模型/密钥/代理/离线）+ GitHub 连通探测（2.5s 超时诚实降级）
- /update zip 渠道识别 + probeRemoteVersion HEAD 探测
- CI install-smoke job（真实安装→运行→卸载闭环）
```

- [ ] **Step 3: 全量门禁**

Run: `npm run ci`
Expected: 九步全绿；`npx vitest run tests/docs-links.test.ts` 绿

- [ ] **Step 4: 提交**

```bash
git add docs/getting-started.md CHANGELOG.md
git commit -m "docs: 一键安装三源章节 + CHANGELOG 阶段 1 条目"
```

---

## 执行顺序与验收

0. **1.5 门禁接线核实结论（先读，勿重复做工）**：release 侧验证器**已接线**——`scripts/package-installer.ts:10-12` 消费 `validateFrozenInstallerCandidate/collectDependencyClosure/verifyDependencyClosure/buildInstallerPackage`；`scripts/generate-package-manifests.mjs:13` 消费 `manifestGen`（dist 构建后）。唯一未接线的是 **build 侧**验证层（`buildVerifiers/adversarialProbe/buildVerificationCoordinator`）——归阶段 2 C 类决策表处置，本阶段不动。
1. Task 1 → 6 顺序执行（Task 3 依赖 Task 1 的 install-meta.json；Task 4 依赖 Task 3 的 probe 族；Task 5 依赖 1-2）。
2. 阶段末验收：`npm run ci` 全绿 + 远程 CI 全绿（含 install-smoke）+ 本机手测「复制 zip → 双击 install.bat → wxnodus -p /status」。
3. audit-deep.md §13.81 记录阶段 1（若并发会话未写；写前 `git status` 防冲突）。
