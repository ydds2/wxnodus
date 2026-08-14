// tests/wave4/w4-data-dir.test.ts — DX-01：--data-dir 唯一 parser（进程级 + 解析器单测）
// 优先级 CLI > env（WXNODUS_DATA_DIR）> cwd 默认；结果贯穿 SQLite/locale（nodus.db 落点为准）；
// help/version 不创建目录。dist 未构建时诚实 skip。
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { parsePreBootstrapArgs } from '../../src/application/bootstrap/preBootstrapOnboarding.js';

const execFileAsync = promisify(execFile);
const CLI = resolve(__dirname, '../../dist/cli/index.js');
const hasDist = existsSync(CLI);
const describeWithDist = hasDist ? describe : describe.skip;
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败静默 */ }
  }
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'w4-data-dir-'));
  tempDirs.push(d);
  return d;
};
const run = (args: string[], cwd: string, env: Record<string, string | undefined> = {}) =>
  execFileAsync(process.execPath, [CLI, ...args], {
    cwd, timeout: 120_000, windowsHide: true,
    env: { ...process.env, ...env, MSYS_NO_PATHCONV: '1' },
  }).catch((e: NodeJS.ErrnoException & { stdout?: string; code?: number }) => e);
const dbAt = (dir: string) => join(dir, 'nodus.db');

describe('DX-01 --data-dir single parser', () => {
  it('parses --data-dir in the strict pre-bootstrap parser', () => {
    const parsed = parsePreBootstrapArgs(['--data-dir', 'C:/custom/data']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.dataDir).toBe('C:/custom/data');
  });

  describeWithDist('process-level precedence', () => {
    it('CLI --data-dir beats env and cwd default', async () => {
      const cwd = tmp();
      const cli = tmp();
      const env = tmp();
      const r = await run(['-p', '算一下 1+1', '--data-dir', cli], cwd, { WXNODUS_DATA_DIR: env });
      expect(r).not.toBeInstanceOf(Error);
      expect(existsSync(dbAt(cli))).toBe(true);
      expect(existsSync(dbAt(join(cwd, 'data')))).toBe(false);
      expect(existsSync(dbAt(env))).toBe(false);
    });

    it('CLI --data-dir propagates through kernel resolveDataDir paths (single source)', async () => {
      const cwd = tmp();
      const cli = tmp();
      const r = await run(['-p', '/offline pack dir', '--data-dir', cli], cwd, { WXNODUS_DATA_DIR: undefined });
      expect(r).not.toBeInstanceOf(Error);
      // kernel 层 resolveDataDir(process.cwd()) 各点经 env 通道统一指向 CLI flag 目录
      expect((r as { stdout: string }).stdout).toContain(cli);
    });

    it('env WXNODUS_DATA_DIR beats cwd default when no flag', async () => {
      const cwd = tmp();
      const env = tmp();
      const r = await run(['-p', '算一下 1+1'], cwd, { WXNODUS_DATA_DIR: env });
      expect(r).not.toBeInstanceOf(Error);
      expect(existsSync(dbAt(env))).toBe(true);
      expect(existsSync(dbAt(join(cwd, 'data')))).toBe(false);
    });

    it('default is <cwd>/data', async () => {
      const cwd = tmp();
      const r = await run(['-p', '算一下 1+1'], cwd, { WXNODUS_DATA_DIR: undefined });
      expect(r).not.toBeInstanceOf(Error);
      expect(existsSync(dbAt(join(cwd, 'data')))).toBe(true);
    });

    it('--help and --version never create the data dir', async () => {
      const cwd = tmp();
      const flag = tmp();
      rmSync(flag, { recursive: true, force: true }); // 起点不存在——help/version 不得重建
      const help = await run(['--help', '--data-dir', flag], cwd);
      expect(help).not.toBeInstanceOf(Error);
      expect(existsSync(flag)).toBe(false);
      const version = await run(['--version', '--data-dir', flag], cwd);
      expect(version).not.toBeInstanceOf(Error);
      expect(existsSync(flag)).toBe(false);
    });
  });
});
