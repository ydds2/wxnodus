// tests/wave3/w3-session-start-cli.test.ts — Session 第 3 步：/new 生产入口真实接线（进程级）
// spawn 真实 dist/cli -p "/new"：会话启动工件（能力/hook 快照 + sha256 绑定）落盘且通过
// validateSessionStart（重算比对）。dist 未构建时诚实 skip。
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { validateSessionStart } from '../../src/domain/sessions/sessionStart.js';

const execFileAsync = promisify(execFile);
const CLI = resolve(__dirname, '../../dist/cli/index.js');
const hasDist = existsSync(CLI);
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败静默 */ }
  }
});
const describeWithDist = hasDist ? describe : describe.skip;

describeWithDist('session start production entry (/new)', () => {
  it('creates a session artifact with valid sha256 binding via the real CLI', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wxnodus-session-cli-'));
    tempDirs.push(cwd);
    const r = await execFileAsync(process.execPath, [CLI, '-p', '/new'], {
      cwd,
      timeout: 120_000,
      windowsHide: true,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' }, // Git Bash MSYS 不得改写 /new
    }).catch((e: NodeJS.ErrnoException & { stdout?: string; code?: number }) => e);
    expect(r).not.toBeInstanceOf(Error);
    const out = (r as { stdout: string }).stdout;
    expect(out).toContain('已新建会话');
    const sessionsDir = join(cwd, 'data', 'sessions');
    expect(existsSync(sessionsDir)).toBe(true);
    const dirs = readdirSync(sessionsDir);
    expect(dirs.length).toBeGreaterThan(0);
    const artifact = join(sessionsDir, dirs[0]!, 'session-start.json');
    expect(existsSync(artifact)).toBe(true);
    const parsed = JSON.parse(readFileSync(artifact, 'utf8'));
    const validated = validateSessionStart(parsed);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.capabilities.length).toBeGreaterThan(0);
    }
  });
});
