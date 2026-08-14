// tests/wave7/w7-00-workspace.test.ts — W7-00：主工作区动态指定（用户动态确定的项目文件夹）
// 优先级：cli(--workspace) > env(WXNODUS_WORKSPACE) > persisted(settings.workspace) > cwd（默认项目文件夹）；
// 显式给出但非法的值 fail-closed（绝不静默降级）；所有文件操作/下载/同化边界由此根动态解析。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveWorkspaceRoot } from '../../src/domain/config/workspaceRoot.js';
import { validateConfigDocument } from '../../src/domain/config/configSchema.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'w7-ws-')); tempDirs.push(d); return d; };

describe('resolveWorkspaceRoot 优先级与 fail-closed', () => {
  it('cli > env > persisted > cwd，逐级回退并标注来源', () => {
    const [a, b, c, d] = [tmp(), tmp(), tmp(), tmp()];
    const cases: Array<[Partial<Omit<Parameters<typeof resolveWorkspaceRoot>[0], 'cwd'>> & { cwd: string }, string, string]> = [
      [{ cli: a, env: b, persisted: c, cwd: d }, a, 'cli'],
      [{ env: b, persisted: c, cwd: d }, b, 'env'],
      [{ persisted: c, cwd: d }, c, 'persisted'],
      [{ cwd: d }, d, 'cwd'],
    ];
    for (const [input, value, source] of cases) {
      const r = resolveWorkspaceRoot(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ value, source });
    }
  });

  it('相对路径（显式给出）→ WORKSPACE_INVALID fail-closed', () => {
    const r = resolveWorkspaceRoot({ cli: 'relative/dir', cwd: tmp() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('WORKSPACE_INVALID');
  });

  it('不存在的绝对路径（显式给出）→ WORKSPACE_NOT_FOUND fail-closed', () => {
    const r = resolveWorkspaceRoot({ cli: join(tmp(), 'missing-dir'), cwd: tmp() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('显式值非法绝不静默降级到低优先级来源', () => {
    // cli 非法 + env 合法 → 仍拒绝（不假装用 env）
    const r = resolveWorkspaceRoot({ cli: 'not-absolute', env: tmp(), cwd: tmp() });
    expect(r.ok).toBe(false);
  });

  it('env 来源读取 WXNODUS_WORKSPACE 语义（空串视为未给出）', () => {
    const d = tmp();
    const r = resolveWorkspaceRoot({ env: '', cwd: d });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ value: d, source: 'cwd' });
  });
});

describe('config schema workspaceRoot', () => {
  it('接受绝对路径字符串并保留', () => {
    const r = validateConfigDocument({
      configVersion: 1, onboardingVersion: 1, installationProfile: 'standard', extensions: {},
      workspaceRoot: 'C:/Users/x/work',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.workspaceRoot).toBe('C:/Users/x/work');
  });

  it('拒绝相对路径与控制字符', () => {
    expect(validateConfigDocument({
      configVersion: 1, onboardingVersion: 1, installationProfile: 'standard', extensions: {}, workspaceRoot: 'relative',
    }).ok).toBe(false);
    expect(validateConfigDocument({
      configVersion: 1, onboardingVersion: 1, installationProfile: 'standard', extensions: {}, workspaceRoot: 'C:/a\u0000b',
    }).ok).toBe(false);
  });
});
