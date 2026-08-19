# 转公开发布清单（release-checklist）

> 阶段 4 交付（2026-08-19）。仓库当前私有（用户决策在案）；本清单是「转公开当日一键兑现」的操作手册。
> 诚实口径：winget 上架存在**合规性前置**（见 §3）——不做假合规声明。

## 0. 前置（转公开决策当天）

1. GitHub 仓库 Settings → Change visibility → **Public**；
2. Release 资产公开可达性自查：`gh release view v<版本> --json assets`（公开后资产 URL 无需鉴权）。

## 1. 打包与校验（每次发布）

```bash
npm run ci                                   # 九步门禁全绿
npm run pack:release                         # 冻结候选（artifacts/release-evidence/<runId>/）
npm exec -- tsx scripts/package-installer.ts --candidate artifacts/release-evidence/<runId>/candidate.json --name wxnodus --version <x.y.z> --out dist-installer
node scripts/generate-package-manifests.mjs --zip dist-installer/wxnodus-<x.y.z>.zip --url <公开 URL> --out dist-installer/manifests
```

生成器诚实门禁：`--url` 缺失时 manifest 输出 `__RELEASE_URL_REQUIRED__` 占位并警告「不可提交发布」——绝不生成假装可发布的 manifest。

## 2. scoop 上架（公开后即可）

1. Fork [ScoopInstaller/Extras](https://github.com/ScoopInstaller/Extras)（或自建 bucket）；
2. 提交 `bucket/wxnodus.json`（由 §1 渲染，url/hash 已齐）；
3. PR 标题 `wxnodus@<x.y.z>: Add version <x.y.z>`；`bin: ["wxnodus", "wxn"]` 双命令已由安装器真实产出（install.ps1 生成两个 .cmd，2026-08-19 终审修复）。

## 3. winget 上架（合规性前置——如实记录）

**现状 blocker**：winget `InstallerType: portable` 语义要求**单一便携 exe**（或 NestedInstaller 结构）；当前安装形态是「自包含 zip + install.ps1」（含 node_modules 原生二进制、安装脚本校验/原子切换/journal）——**非 winget-portable 合规形态**，不能以 portable 类型直接上架（模板 `packaging/winget/manifest.template.yaml` 的 `InstallerType: portable` 因此不能原样提交）。

**可选路径（转公开后择一）**：
- **A. 便携 exe 启动器**：生成一个 `wxnodus.exe`（如 node SEA/自解压壳）满足 portable 语义——需一次原生打包验证（当前未做，不宣称已做）；
- **B. 自建 winget source**：`winget source add wxnodus https://…/winget-source`（自定义源 manifest 约束较松，但用户需手动加源）；
- **C. 暂缓 winget**：scoop + 一键脚本（install-bootstrap.ps1 三源）已覆盖分发，winget 待 A 落地后再上。

## 4. 发布后验证（每个渠道）

- 干净 Windows 环境：`powershell -ExecutionPolicy Bypass -File install-bootstrap.ps1 -GitHub <owner>/<repo> -Tag <版本>` → `wxnodus -p /status` 可用；
- scoop：`scoop install wxnodus` → `wxnodus --version`；
- winget（若走 A）：`winget install yyds2.wxnodus` → `wxnodus --version`。

## 5. 文档联动

- `docs/getting-started.md` §1.1 三源安装（已就绪）；发布后补「scoop/winget 一行装」小节；
- CHANGELOG 版本段 + audit 尾注（发布轮次 CI 号）。
