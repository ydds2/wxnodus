// tests/install-one.e2e.test.ts — 一行命令安装端到端（本地 HTTP 服务器 = 模拟公开托管）
// 真实链路：buildInstallerPackage 产出真实 zip → node http 服务托管 → packaging/install.ps1
// 经 env 配置走「下载 → 解包 → 内层 install.ps1 安装」→ 断言 INSTALLED 与产物落位。
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstallerPackage } from '../src/application/release/installerPackager.js';
import { readZip } from '../src/application/release/zipArchive.js';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'packaging', 'install.ps1');

describe.skipIf(process.platform !== 'win32')('一行命令安装端到端（本地托管模拟公开 URL）', () => {
  it('WXNODUS_BASE_URL 指向本地 HTTP → 下载→解包→安装全链路', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-one-e2e-'));
    let server: Server | null = null;
    try {
      // 1) 真实打包（fixture 最小包，appName=wxnodus → zip 名 wxnodus-1.2.3.zip）
      const packed = await buildInstallerPackage({
        appName: 'wxnodus', version: '1.2.3', icon: null, entryPath: 'bin/wxnodus.js',
        files: new Map([['bin/wxnodus.js', Buffer.from('#!/usr/bin/env node\nconsole.log("one-liner-art")\n')]]),
        outDir: root,
      });
      expect(packed.ok).toBe(true);
      if (!packed.ok) return;
      const zipBuf = readFileSync(packed.value.zipPath);

      // 2) 本地 HTTP 托管（模拟公开下载基址）
      const zipName = 'wxnodus-1.2.3.zip';
      server = createServer((req, res) => {
        if (req.url === `/${zipName}`) { res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(zipBuf); return; }
        res.writeHead(404); res.end('nf');
      });
      await new Promise<void>(res => server!.listen(0, '127.0.0.1', res));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

      // 3) 一行命令脚本执行（env 配置：版本/基址/目标目录/跳过 PATH）
      const target = join(root, 'installed');
      const out = await new Promise<{ code: number; stdout: string }>(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
          env: {
            ...process.env,
            WXNODUS_VERSION: '1.2.3',
            WXNODUS_BASE_URL: base,
            WXNODUS_INSTALL_DIR: target,
            WXNODUS_NO_PATH: '1',
          },
          timeout: 120_000,
        }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout: String(stdout) }));
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain(`INSTALLED: ${target}`);
      expect(existsSync(join(target, 'bin', 'wxnodus.js'))).toBe(true);
      expect(existsSync(join(target, 'wxnodus.cmd'))).toBe(true);
      expect(existsSync(join(target, 'wxn.cmd'))).toBe(true);
      // install-meta 记录 -Source（/update zip 渠道可探测）
      const meta = JSON.parse(readFileSync(join(target, 'install-meta.json'), 'utf8'));
      expect(meta.source).toBe(`${base}/${zipName}`);
    } finally {
      if (server) server.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 120_000);
});
