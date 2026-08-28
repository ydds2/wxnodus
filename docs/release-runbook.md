# npm 发布 Runbook（v4.0.0 收尾 · 2026-08-28）

> 工程侧 100% 就绪（三包 pack 预检过 / publish-npm workflow 修复落仓 / **本地直发脚本 `scripts/release/publish-local.mjs` 已 dry-run 实测三包清单通过**）。
> 本手册覆盖剩余两步账号动作与触发验收——任何时刻 5 分钟完成，不依赖特定会话。

## 第 1 步：npm Granular token（约 2 分钟）

1. 登录 npmjs.com → 头像 → **Access Tokens** → Generate New Token → **Granular Access Token**
2. 权限：Packages → Read and write；Packages and scopes 限定：`wxnodus`、`@wxnodus/sdk`、`@wxnodus/core`
3. 复制 token（只显示一次）
4. 打开 https://github.com/ydds2/wxnodus/settings/secrets/actions → New repository secret
   - Name: `NPM_TOKEN`  - Value: 粘贴 token → Add secret

## 第 2 步（仅路径 B 需要）：GitHub Actions Billing（约 2 分钟）

1. 打开 https://github.com/settings/billing
2. 付款方式失效 → 更新卡片；Spending limit 过低 → 提高 Actions 上限
   （实测证据：run 被拦提示 "recent account payments have failed or your spending limit needs to be increased"）

## 第 3 步：触发发布

**路径 A（本地直发——推荐，无需修 GitHub Billing）**：

```bash
# dry-run 复核清单
node scripts/release/publish-local.mjs --dry-run
# 正式发布（仅此步需要 token）
NPM_TOKEN=npm_xxx node scripts/release/publish-local.mjs
```

**路径 B（GitHub Actions——需 Billing 已修）**：

```bash
# ① dry-run：复核三包产物清单（看 Actions 日志 npm pack 段——无泄漏无缺失）
gh workflow run publish-npm --repo ydds2/wxnodus -f dry-run=true
gh run watch --repo ydds2/wxnodus   # 或网页看 run

# ② 正式发布三包
gh workflow run publish-npm --repo ydds2/wxnodus -f dry-run=false
```

## 第 4 步：验收

```bash
npm view wxnodus version            # 期望 4.0.0
npm view @wxnodus/sdk version       # 期望 4.0.0
npm view @wxnodus/core version      # 期望 4.0.0
npm install -g wxnodus && wxnodus --version
```

## 其他通道现状（已真实上架）

- GitHub Release：https://github.com/ydds2/wxnodus/releases/tag/v4.0.0（zip sha256 706EE81DE43FF8F565F1788512516F9A0BF6021B6B1697E7BB4E233664E4418E）
- winget：https://github.com/microsoft/winget-pkgs/pull/425473（微软审核队列，合入后 `winget install ydds2.wxnodus`）
- scoop：`scoop bucket add wxnodus https://github.com/ydds2/wxnodus-bucket && scoop install wxnodus`

## 故障排查

| 症状 | 处置 |
|---|---|
| run 仍 0s 失败 | Billing 未生效（等待数分钟或检查卡片扣款验证） |
| publish 步 403 | token 包权限不含该包名 → 重建 Granular token 限定三包 |
| `@wxnodus` scope 403 | npm 账号需先创建组织 wxnodus 或改用用户 scope（把包名改 @<用户名>/sdk 后同步 package.json） |
