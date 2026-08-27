# winget / scoop 发布指南（2026-08-27）

> 状态：**发布准备已交付**——manifest 三文件形态渲染 + 本指南 + PR 描述模板；
> 实际提交 PR 是外部动作（需 `yyds2` GitHub 账号授权），未经授权则本指南产物供企业内部分发/自建 bucket 使用。

## 一、当前就绪面

| 产物 | 路径 | 状态 |
|---|---|---|
| winget 三文件模板 | `packaging/winget/{version,installer,locale.zh-CN}.template.yaml` | ✅ winget-pkgs 新包提交必需的三文件形态 |
| winget 渲染产物 | `packaging/winget/yyds2.wxnodus{, .installer, .locale.zh-CN}.yaml` | 占位符态（缺真实 URL/SHA256，**不可提交**） |
| scoop 模板 | `packaging/scoop/wxnodus.template.json` | ✅ license=Apache-2.0（已修正，与 package.json 一致） |
| scoop 渲染产物 | `packaging/scoop/wxnodus.json` | 占位符态 |
| 生成器 | `scripts/generate-package-manifests.mjs`（`npm run gen:manifests`） | ✅ 诚实门禁：缺 `--url/--zip` 输出占位符并警告 |
| 生成器纯函数 | `src/application/release/manifestGen.ts` | ✅ 7 单测（含三文件形态字段锁定 + scoop license 锁定） |
| 发布链路 | `scripts/publish-release.mjs`（freeze → 打包 → `gh release create`） | ✅ 产物 `dist-installer/wxnodus-<version>.zip` |

## 二、发布步骤（需 GitHub 授权，约 10 分钟 + PR 审核等待）

### 0. 前置：创建 GitHub Release（有真实资产 URL）

```powershell
# 全链路打包（校验门禁 fail-closed）并创建 Release（gh 已登录）
node scripts/publish-release.mjs --version 4.0.0-rc.1 --notes "4.1 私有化核心落地"
```

资产 URL 随即固定为：

```
https://github.com/yyds2/wxnodus/releases/download/v4.0.0-rc.1/wxnodus-4.0.0-rc.1.zip
```

> 注意：当前仓库若为私有，资产需要公开仓库才能被 winget/scoop 用户无凭据拉取；
> winget 校验器会实际下载 InstallerUrl 并比对 SHA256。

### 1. 渲染正式 manifest（占位符消除门禁）

```powershell
npm run build
npm run gen:manifests -- --url "https://github.com/yyds2/wxnodus/releases/download/v4.0.0-rc.1/wxnodus-4.0.0-rc.1.zip" --zip "dist-installer/wxnodus-4.0.0-rc.1.zip"
```

输出三份 winget 文件 + scoop json，**且无 `WARN`**（占位符全消除 = 可提交态）。若仍有 `WARN`，说明 URL/SHA256 未生效，禁止提交。

### 2. winget-pkgs PR（社区仓库 microsoft/winget-pkgs）

1. fork `microsoft/winget-pkgs`，把 `packaging/winget/` 三份文件放到：
   `manifests/y/yyds2/wxnodus/4.0.0-rc.1/yyds2.wxnodus{, .installer, .locale.zh-CN}.yaml`
2. **提交前必做校验**（诚实标注：以下两点是已知未决项，须按校验器输出调整后再提 PR）：
   - zip 型 portable 在 winget 需 `NestedInstallerType: portable` + `NestedInstallerFiles`（入口须为 **exe**；本包根部是 `wxnodus.cmd` shim，winget 不认 cmd 入口）——若校验拒绝，预案：
     a. installer manifest 改走 scoop 单通道（winget 暂缓）；或
     b. 发布物补一个自解压 exe 入口（`install.ps1` 打出的目录 + 引导 exe）。
   - 版本串 `4.0.0-rc.1` 含预发布后缀，winget-pkgs 通常要求正式版版本串；建议首个 winget 版本用正式 `4.1.0`。
3. 本地校验（装有 winget 的机器）：`winget validate --manifest <目录>`；线上：PR 的 CI（Packages Pull Request Validation）自动跑。
4. PR 标题/正文用 `packaging/PR-DESCRIPTION.md` 模板。

### 3. scoop PR（社区仓库 ScoopInstaller/Main）

1. fork `ScoopInstaller/Main`，`packaging/scoop/wxnodus.json` 放到 `bucket/wxnodus.json`。
2. scoop 端 `bin: ["wxnodus", "wxn"]` 指向 zip 根部 `wxnodus.cmd`/`wxn.cmd`（**已存在**，installerPackager 保证）——scoop 认 cmd shim，此路无 winget 的 exe 入口问题。
3. 主 bucket 惯例要求 `checkver`/`autoupdate`（GitHub releases 探测）——建议 PR 时补上，否则 maintainer 大概率要求追加。
4. PR 标题/正文用 `packaging/PR-DESCRIPTION.md` 模板。

### 4. 发布后验证（本机，数据不出机）

```powershell
winget install yyds2.wxnodus        # 或 scoop install wxnodus
wxnodus --version
wxnodus doctor                      # 网络代理检查项应显示正常
wxnodus update                      # 更新渠道联动冒烟（selfUpdate 走 Release 资产）
winget uninstall yyds2.wxnodus      # 卸载演练：journal 只删自有文件（install-meta.json 判定）
```

## 三、未授权时的替代交付（当前形态）

- 三份 winget manifest + scoop json 渲染产物随仓库分发：企业可自建 winget REST 源（`winget source add`）或私有 scoop bucket 直接消费；
- 本指南步骤 0/1 之后的全流程可复现，唯一缺的只是 PR 提交权限。

## 四、口径

- 机制参考：winget-pkgs 多文件 manifest 规范（version/installer/locale 三文件）与 scoop bucket 规范——社区契约，遵循即兼容；
- 实现差异：本仓生成器诚实门禁（缺 URL/SHA256 绝不产出可提交态）+ Apache-2.0 许可字段修正（此前 scoop 模板误标 MIT，已修并锁测试）。
