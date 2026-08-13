// tests/skill-legacy-layout-migration.test.ts — W2-07 legacy 布局迁移：staging → hash/read-back → activate → report；源不删
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillLifecycleService } from '../src/application/extensions/skillLifecycleService.js';
import { ExtensionScopeManager } from '../src/application/extensions/extensionScopeManager.js';

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'wxn-skill-migrate-')); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const context = { actorId: 'test', sessionId: 's', runId: 'r', correlationId: 'c', policySnapshotId: 'p',
  locale: 'en', source: 'kernel' as const, capabilities: [], timestamp: '2026-08-13T00:00:00.000Z' };
const signal = () => new AbortController().signal;

function skillDoc(name: string, version: string): string {
  const hash = createHash('sha256').update('artifact-content').digest('hex');
  return `---\nschemaVersion: 1\nname: ${name}\nversion: ${version}\ndescription: d\ndependencies: []\ncapabilities: []\nentrypoints:\n  - prompts/review.md\nsource: project\nartifactHash: ${hash}\ntrustLevel: reviewed\nextensions: {}\n---\n# Body\n`;
}

function writeLegacySkill(dir: string, name: string, version: string): void {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'review.md'), '# review', 'utf8');
  writeFileSync(join(dir, 'SKILL.md'), skillDoc(name, version), 'utf8');
}

describe('Skill legacy layout migration', () => {
  it('migrates both legacy layouts without deleting sources and reports read-back evidence', async () => {
    const dataDir = makeRoot();
    const manager = new ExtensionScopeManager();
    const service = new SkillLifecycleService({
      dataDir,
      scopeManager: manager,
      copy: async (source, target) => { cpSync(source, target, { recursive: true }); return { ok: true, value: undefined }; },
      promote: async (stagedDir, targetDir) => {
        const { renameSync, existsSync } = await import('node:fs');
        if (existsSync(targetDir)) return { ok: false, error: { code: 'SKILL_TARGET_EXISTS', message: 'exists', messageKey: 'skill.target.exists', retryable: false } };
        renameSync(stagedDir, targetDir); return { ok: true, value: undefined };
      },
      remove: async dir => { rmSync(dir, { recursive: true, force: true }); return { ok: true, value: undefined }; },
      hashOf: async () => createHash('sha256').update('artifact-content').digest('hex'),
      smoke: async () => true,
    });

    // fixture 1：<dataDir>/skills/<name>/SKILL.md
    const legacyA = join(dataDir, 'skills', 'audit-helper');
    writeLegacySkill(legacyA, 'audit-helper', '1.0.0');
    const bytesA = readFileSync(join(legacyA, 'SKILL.md'), 'utf8');
    // fixture 2：<dataDir>/forge/<package>/<name>/SKILL.md
    const legacyB = join(dataDir, 'forge', 'quality-toolkit', 'review-check');
    writeLegacySkill(legacyB, 'review-check', '2.0.0');
    const bytesB = readFileSync(join(legacyB, 'SKILL.md'), 'utf8');

    const report = await service.migrateLegacy(context, signal());
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.migrated.map(x => x.name).sort()).toEqual(['audit-helper', 'review-check']);
    // 源路径未删除、字节不变（report 持久化前不删源）
    expect(readFileSync(join(legacyA, 'SKILL.md'), 'utf8')).toBe(bytesA);
    expect(readFileSync(join(legacyB, 'SKILL.md'), 'utf8')).toBe(bytesB);
    // 迁移后两个 scope 可调用
    expect(manager.resolveTool('audit-helper')).toBeDefined();
    expect(manager.resolveTool('review-check')).toBeDefined();
  });

  it('fails closed with SKILL_LEGACY_LAYOUT_INVALID and preserves source bytes on a bad layout', async () => {
    const dataDir = makeRoot();
    const manager = new ExtensionScopeManager();
    const service = new SkillLifecycleService({
      dataDir,
      scopeManager: manager,
      copy: async (source, target) => { cpSync(source, target, { recursive: true }); return { ok: true, value: undefined }; },
      promote: async (stagedDir, targetDir) => {
        const { renameSync } = await import('node:fs');
        renameSync(stagedDir, targetDir); return { ok: true, value: undefined };
      },
      remove: async dir => { rmSync(dir, { recursive: true, force: true }); return { ok: true, value: undefined }; },
      hashOf: async () => createHash('sha256').update('artifact-content').digest('hex'),
      smoke: async () => true,
    });
    // 损坏布局：SKILL.md 存在但 frontmatter 非法
    const bad = join(dataDir, 'skills', 'broken-skill');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'SKILL.md'), 'not a skill document', 'utf8');
    const bytes = readFileSync(join(bad, 'SKILL.md'), 'utf8');

    const report = await service.migrateLegacy(context, signal());
    expect(report).toMatchObject({ ok: false, error: { code: 'SKILL_LEGACY_LAYOUT_INVALID' } });
    expect(readFileSync(join(bad, 'SKILL.md'), 'utf8')).toBe(bytes);
    expect(manager.resolveTool('broken-skill')).toBeUndefined();
  });
});
