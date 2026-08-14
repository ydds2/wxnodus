// tests/wave4/w4-english-first-run.test.ts — DX-05：English/first-run 进程级契约
// --lang en --help 无中文；--help 默认中文；--lang en --version 纯版本；catalog key 严格一致；
// en 目录除刻意双语的 selectLanguage 外无 CJK（en 禁止中文 fallback——translate 无回退机制）。
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { messageKeys, translate } from '../../src/application/i18n/i18nService.js';

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
  const d = mkdtempSync(join(tmpdir(), 'w4-en-'));
  tempDirs.push(d);
  return d;
};
const run = (args: string[], cwd: string, env: Record<string, string | undefined> = {}) =>
  execFileAsync(process.execPath, [CLI, ...args], {
    cwd, timeout: 120_000, windowsHide: true,
    env: { ...process.env, ...env, MSYS_NO_PATHCONV: '1', WXNODUS_NO_DEBUG: '1' },
  }).catch((e: NodeJS.ErrnoException & { stdout?: string }) => e);
const CJK = /[\u4e00-\u9fff]/;

describe('DX-05 English catalog contract', () => {
  it('key sets are strictly identical across en and zh-CN', () => {
    expect(messageKeys('en')).toEqual(messageKeys('zh-CN'));
    expect(messageKeys('en').length).toBeGreaterThanOrEqual(9);
  });

  it('en catalog has no CJK fallback (selectLanguage is the only intentional bilingual key)', () => {
    for (const key of messageKeys('en')) {
      const value = translate('en', key);
      if (key !== 'onboarding.selectLanguage') {
        expect(CJK.test(value), `en key ${key} contains CJK`).toBe(false);
      }
    }
  });
});

describeWithDist('DX-05 first-run process contract', () => {
  it('--lang en --help prints English only (no CJK)', async () => {
    const cwd = tmp();
    const r = await run(['--lang', 'en', '--help'], cwd);
    expect(r).not.toBeInstanceOf(Error);
    const out = (r as { stdout: string }).stdout;
    expect(out).toContain('Usage:');
    expect(out).toContain('--mcp-server');
    expect(CJK.test(out)).toBe(false);
  });

  it('default --help stays Chinese', async () => {
    const cwd = tmp();
    const r = await run(['--help'], cwd);
    expect(r).not.toBeInstanceOf(Error);
    const out = (r as { stdout: string }).stdout;
    expect(out).toContain('用法');
    expect(out).toContain('本地概念编译器');
  });

  it('--lang en --version prints only the version line', async () => {
    const cwd = tmp();
    const r = await run(['--lang', 'en', '--version'], cwd);
    expect(r).not.toBeInstanceOf(Error);
    const out = (r as { stdout: string }).stdout.trim();
    expect(out).toMatch(/^wxnodus \d+\.\d+\.\d+$/);
  });

  it('non-TTY first run never hangs and does not prompt', async () => {
    const cwd = tmp();
    const r = await run(['-p', '算一下 1+1'], cwd);
    expect(r).not.toBeInstanceOf(Error);
    expect((r as { stdout: string }).stdout).toContain('2');
  });
});
