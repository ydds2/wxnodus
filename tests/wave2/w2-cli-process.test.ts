// tests/wave2/w2-cli-process.test.ts — W2-04 真实进程级 smoke（最小切片）
// 必须 spawn 真实 dist/cli/index.js（不是 fake GatewayPort）：
//   · --version / --help：0 退出、输出稳定、零 data-dir 副作用
//   · --cwd 不可用目录：exit 1
//   · 未知 flag：宽松忽略（现状契约），进程干净退出
// dist 未构建时诚实 skip（环境不足不假通过）。
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI = resolve(__dirname, '../../dist/cli/index.js');
const hasDist = existsSync(CLI);
// 版本单一事实源：断言与 package.json 一致（bump 时自动同步，不再每处硬编码）
const pkgVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const runCli = (args: string[], opts: { cwd?: string } = {}) =>
  execFileAsync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    timeout: 120_000,
    windowsHide: true,
  }).catch((e: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => e);

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败静默 */ }
  }
});

const describeWithDist = hasDist ? describe : describe.skip;

describeWithDist('dist/cli process smoke', () => {
  it('--version exits 0 with the pinned version', async () => {
    const r = await runCli(['--version']);
    expect(r).not.toBeInstanceOf(Error);
    expect((r as { stdout: string }).stdout).toContain(`wxnodus ${pkgVersion}`);
  });

  it('--help exits 0 with usage text', async () => {
    const r = await runCli(['--help']);
    expect(r).not.toBeInstanceOf(Error);
    const out = (r as { stdout: string }).stdout;
    expect(out).toContain('帮助');
    expect(out).toContain('--prompt');
  });

  it('--cwd pointing at a missing directory exits 1', async () => {
    const missing = join(tmpdir(), `wxnodus-no-such-${Date.now().toString(36)}`);
    const r = await runCli(['--cwd', missing, '--version']);
    const err = r as NodeJS.ErrnoException & { code?: number };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(1);
  });

  it('help/version do not create a data directory (zero side effects)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wxnodus-clean-'));
    tempDirs.push(cwd);
    const r = await runCli(['--version'], { cwd });
    expect(r).not.toBeInstanceOf(Error);
    const dataDir = join(cwd, '.wxnodus');
    expect(existsSync(dataDir)).toBe(false);
  });

  it('unknown flags are rejected fail-closed by the pre-bootstrap parser (exit 2)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wxnodus-unk-'));
    tempDirs.push(cwd);
    const r = await runCli(['--definitely-not-a-flag', '--help'], { cwd });
    const err = r as NodeJS.ErrnoException & { code?: number; stderr?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(2);
  });
});
