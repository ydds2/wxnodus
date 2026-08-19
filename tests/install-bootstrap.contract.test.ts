// tests/install-bootstrap.contract.test.ts — 三源下载入口内容契约（不真联网：断言脚本字面行为）
// install-bootstrap.ps1 为 checked-in 入口（先于任何 zip 存在），故以内容契约锁行为：
// 三源参数、https 强制、gh 登录态探测、Token 不落盘、解包转调 install.ps1 并透传参数。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '..', 'packaging', 'install-bootstrap.ps1'), 'utf8');

describe('install-bootstrap.ps1 内容契约', () => {
  it('三源参数与 https 强制', () => {
    expect(script).toContain('[string]$Zip');
    expect(script).toContain('[string]$Url');
    expect(script).toContain('[string]$GitHub');
    expect(script).toContain('BOOTSTRAP_URL_NOT_HTTPS');
    expect(script).toContain('StartsWith');
    expect(script).toContain('https://');
    expect(script).toContain('BOOTSTRAP_NO_SOURCE');
  });
  it('GitHub 源走 gh 并探测登录态，Token 不落盘', () => {
    expect(script).toContain('gh auth status');
    expect(script).toContain('BOOTSTRAP_GH_AUTH_REQUIRED');
    expect(script).toContain('gh release download');
    expect(script).not.toContain('GITHUB_TOKEN=');
    expect(script).not.toContain('Authorization');
    expect(script).toContain('BOOTSTRAP_GH_NO_ASSET');
  });
  it('解包后转调 zip 内 install.ps1 并透传 -TargetDir/-DryRun/-Source', () => {
    expect(script).toContain('Expand-Archive');
    expect(script).toContain('install.ps1');
    expect(script).toContain('$TargetDir');
    expect(script).toContain('$DryRun');
    expect(script).toContain('BOOTSTRAP_NO_INSTALLER');
    // -Source 透传：/update 才能拿到远程源做版本探测
    expect(script).toContain("-Source");
  });
});
