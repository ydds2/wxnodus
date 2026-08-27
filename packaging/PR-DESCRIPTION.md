# PR 描述模板（winget-pkgs / scoop 提交用）

> 提交前替换 `<>` 占位；winget 走 `microsoft/winget-pkgs`，scoop 走 `ScoopInstaller/Main`。

## 标题

- winget：`New package: yyds2.wxnodus version <version>`
- scoop：`wxnodus: Add version <version>`

## 正文

```
## wxnodus <version>

**说明**：Windows 本地 AI agent CLI——数据不出机（无遥测/无自动上传）、BYOK 任意 OpenAI 兼容端点、
气隙/内网一等公民（企业代理 + 私网直连红线 + 离线用户手册随包）。

- 仓库：https://github.com/yyds2/wxnodus
- 许可证：Apache-2.0
- 安装器：portable zip（SHA256 已绑定）
- 命令：`wxnodus` / `wxn`
- 系统要求：Windows 10 1809+ / 11，x64，Node ≥22.7（无内置运行时，install 链路多 ABI 侧车）

### 验证

- [ ] `winget validate --manifest <path>`（winget）/ `bin/checkver.ps1` + `bin/checkhashes.ps1`（scoop）
- [ ] 解压后 `wxnodus --version` 正常
- [ ] 卸载只删除安装目录自有文件（journal 判定，见 install-meta.json）

## 免责

- 本包不含遥测；模型流量只去用户配置的端点（默认私网段直连不经代理）。
```
