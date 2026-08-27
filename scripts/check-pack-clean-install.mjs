#!/usr/bin/env node
// scripts/check-pack-clean-install.mjs — DX-03：npm tgz 干净安装验证（手动 gate，网络/registry 依赖）
// 流程：npm pack（含 prepack 构建）→ 空目录 npm install <tgz> → workspace 外运行 wxnodus --version
// 与规则脑确定性计算 → 记录 tgz sha256/大小。任一步失败非零退出（诚实失败，绝不把清单当成运行证据）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32', ...opts,
});

const stage = mkdtempSync(join(tmpdir(), 'wxnodus-clean-install-'));
try {
  // 1) pack（真实构建链：prepack → build:ink + tsc）
  const pack = sh(npm, ['pack', '--json', '--pack-destination', stage], { cwd: ROOT, timeout: 600_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const tgzName = JSON.parse(pack)[0].filename;
  const tgz = join(stage, tgzName);
  const bytes = readFileSync(tgz);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  console.log(`[pack] ${tgzName}  ${bytes.length} bytes  sha256=${sha256}`);

  // 2) 干净安装（workspace 外、空 HOME 语义——HOME 指向独立临时目录，隔离用户配置）
  const prefix = join(stage, 'prefix');
  const home = join(stage, 'home');
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(stage, 'package.json'), '{"name":"clean-install-check","private":true}\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, WXNODUS_NO_DEBUG: '1', MSYS_NO_PATHCONV: '1', npm_config_prefix: prefix, npm_config_cache: join(stage, 'npm-cache') };
  sh(npm, ['install', '--no-audit', '--no-fund', tgz], { cwd: stage, timeout: 900_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env });

  // 3) workspace 外运行：bin shim 解析（--version，无参数安全）+ 规则脑确定性计算
  // 注意：calc 用 node 直调（shell:true 会把「算一下 2+3*4」拆成两个 argv token）
  const binShim = join(stage, 'node_modules', '.bin', process.platform === 'win32' ? 'wxnodus.cmd' : 'wxnodus');
  const version = sh(binShim, ['--version'], { cwd: stage, timeout: 60_000, windowsHide: true, env }).trim();
  if (!/^wxnodus \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`unexpected version output: ${version}`);
  const bin = join(stage, 'node_modules', 'wxnodus', 'dist', 'cli', 'index.js');
  // V4 裁撤轨 D-3：无 key 确定性层默认禁用（A-8 中文句被 base64 劫持随裁撤消失）；
  // 逃生开关 WXNODUS_LEGACY_OFFLINE=1 保留——本检查经开关验证「安装包内确定性层 + 参数转发」接线
  const calc = sh('node', [bin, '-p', '算一下 2+3*4'], { cwd: stage, timeout: 120_000, windowsHide: true, shell: false, env: { ...env, WXNODUS_LEGACY_OFFLINE: '1' } }).trim();
  if (!calc.includes('14')) throw new Error(`rule-brain calc failed: ${calc}`);
  console.log(`[run] version=${version}  calc=${calc.split('\n').pop()}`);

  // 4) 隔离断言：运行目录下没有产生本仓库痕迹（data 落在运行 cwd，而非安装前缀）
  const { readdirSync } = await import('node:fs');
  const prefixTop = readdirSync(prefix);
  if (prefixTop.some(n => n === 'data' || n === 'nodus.db' || n === 'wxdbg.log')) {
    throw new Error(`runtime artifacts leaked into prefix: ${prefixTop.join(',')}`);
  }
  console.log('[ok] clean install runs outside the workspace; prefix isolated.');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
