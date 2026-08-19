// tests/install-one.contract.test.ts — 一行命令安装脚本契约（Kimi 机制对标：iex 兼容/环境变量配置/双下载路径）
// 不真联网：断言脚本字面行为；真实端到端（本地 HTTP 服务器 + 真实 zip）见 install-one.e2e.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '..', 'packaging', 'install.ps1'), 'utf8');

describe('packaging/install.ps1 一行命令契约', () => {
  it('iex 兼容：无 param 块（参数全部走环境变量）', () => {
    expect(script).not.toContain('param(');
    expect(script).toContain('$env:WXNODUS_VERSION');
    expect(script).toContain('$env:WXNODUS_BASE_URL');
    expect(script).toContain('$env:WXNODUS_INSTALL_DIR');
    expect(script).toContain('$env:WXNODUS_NO_PATH');
  });

  it('PS 5.1 TLS 1.2 兜底 + 版本解析（GitHub API → gh CLI 私有回退）', () => {
    expect(script).toContain('Tls12');
    expect(script).toContain('releases/latest');
    expect(script).toContain('gh release list');
  });

  it('双下载路径：公开资产直连 → gh release download 私有回退（Token 不落盘）', () => {
    expect(script).toContain('gh release download');
    expect(script).toContain('gh auth login');
    expect(script).not.toContain('GITHUB_TOKEN=');
    expect(script).not.toContain('Authorization');
  });

  it('解包转调内层 install.ps1 并透传 -TargetDir/-SkipPath/-Source', () => {
    expect(script).toContain('Expand-Archive');
    expect(script).toContain("Filter 'install.ps1'");
    expect(script).toContain('-TargetDir');
    expect(script).toContain('-SkipPath');
    expect(script).toContain('-Source');
  });

  it('纯 ASCII（PS 5.1 无 BOM 按 ANSI 解析约定）', () => {
    expect(/[\u4e00-\u9fff]/.test(script)).toBe(false);
  });
});
