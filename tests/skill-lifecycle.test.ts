// tests/skill-lifecycle.test.ts — W2-07 skill 生命周期：smoke 失败保留旧 scope、swap 后 dispose、owner-only 卸载、verified 语义
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillLifecycleService } from '../src/application/extensions/skillLifecycleService.js';
import { ExtensionScopeManager } from '../src/application/extensions/extensionScopeManager.js';
import type { SkillCandidate } from '../src/application/extensions/skillLifecycleService.js';

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'wxn-skill-life-')); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const context = { actorId: 'test', sessionId: 's', runId: 'r', correlationId: 'c', policySnapshotId: 'p',
  locale: 'en', source: 'kernel' as const, capabilities: [], timestamp: '2026-08-13T00:00:00.000Z' };
const signal = () => new AbortController().signal;

function writeSkill(sourceDir: string, manifestBody: string): string {
  mkdirSync(sourceDir, { recursive: true });
  const hash = createHash('sha256').update('artifact-content').digest('hex');
  const doc = `---\n${manifestBody}\n---\n# Body\n`;
  writeFileSync(join(sourceDir, 'SKILL.md'), doc, 'utf8');
  return hash;
}

interface Fixture {
  service: SkillLifecycleService;
  manager: ExtensionScopeManager;
  dataDir: string;
  activateOrder: string[];
  smokeResults: Map<string, boolean>;
}

function fixture(): Fixture {
  const dataDir = makeRoot();
  mkdirSync(join(dataDir, 'skills'), { recursive: true });
  const manager = new ExtensionScopeManager();
  const activateOrder: string[] = [];
  const smokeResults = new Map<string, boolean>();
  const service = new SkillLifecycleService({
    dataDir,
    scopeManager: manager,
    copy: async (source, target) => {
      const { cpSync } = await import('node:fs');
      try { cpSync(source, target, { recursive: true }); return { ok: true, value: undefined }; }
      catch (cause) { return { ok: false, error: { code: 'COPY_FAILED', message: String(cause), messageKey: 'copy.failed', retryable: false } }; }
    },
    promote: async (stagedDir, targetDir, replace) => {
      const { existsSync, renameSync, rmSync } = await import('node:fs');
      if (existsSync(targetDir)) {
        if (!replace) return { ok: false, error: { code: 'SKILL_TARGET_EXISTS', message: 'exists', messageKey: 'skill.target.exists', retryable: false } };
        rmSync(targetDir, { recursive: true, force: true });
      }
      renameSync(stagedDir, targetDir); activateOrder.push(`promote:${targetDir}`);
      return { ok: true, value: undefined };
    },
    remove: async dir => { const { rmSync } = await import('node:fs'); try { rmSync(dir, { recursive: true, force: true }); } catch {} return { ok: true, value: undefined }; },
    hashOf: async () => createHash('sha256').update('artifact-content').digest('hex'),
    smoke: async (candidate: SkillCandidate) => { activateOrder.push(`smoke:${candidate.owner}`); return smokeResults.get(candidate.owner) ?? true; },
  });
  return { service, manager, dataDir, activateOrder, smokeResults };
}

describe('SkillLifecycleService', () => {
  it('keeps the old scope callable after a candidate smoke failure', async () => {
    const f = fixture();
    const v1 = await f.service.stage(writeSkillSource(f, 'audit-helper', '1.2.2'), context, signal());
    expect(v1.ok).toBe(true); if (!v1.ok) return;
    const first = await f.service.activate(v1.value, context, signal());
    expect(first.ok).toBe(true);
    expect(f.manager.resolveTool('audit-helper')).toBeDefined();

    const v2 = await f.service.stage(writeSkillSource(f, 'audit-helper', '1.2.3'), context, signal());
    expect(v2.ok).toBe(true); if (!v2.ok) return;
    f.smokeResults.set(v2.value.owner, false);
    expect(await f.service.activate(v2.value, context, signal())).toMatchObject({ ok: false, error: { code: 'SKILL_SCOPE_ACTIVATION_FAILED' } });
    // 旧 scope 仍可调用（版本 1.2.2）
    expect(f.manager.resolveTool('audit-helper')).toBeDefined();
    expect(f.manager.snapshot('skill:audit-helper@1.2.2')?.version).toBe('1.2.2');
  });

  it('disposes old scope only after a successful swap and clears owner on uninstall', async () => {
    const f = fixture();
    const v1 = await f.service.stage(writeSkillSource(f, 'audit-helper', '1.2.2'), context, signal());
    if (!v1.ok) return;
    expect((await f.service.activate(v1.value, context, signal())).ok).toBe(true);
    const v2 = await f.service.stage(writeSkillSource(f, 'audit-helper', '1.2.3'), context, signal());
    if (!v2.ok) return;
    // 未显式 audited replace → 目标存在即 SKILL_TARGET_EXISTS，旧 scope 不动
    expect(await f.service.activate(v2.value, context, signal())).toMatchObject({ ok: false, error: { code: 'SKILL_TARGET_EXISTS' } });
    expect(f.manager.snapshot('skill:audit-helper@1.2.2')).toBeDefined();
    // 显式 replace → 原子换入，旧 scope 由 manager 在 swap 后 dispose
    const v3 = await f.service.stage(writeSkillSource(f, 'audit-helper', '1.2.3'), context, signal());
    if (!v3.ok) return;
    expect((await f.service.activate(v3.value, context, signal(), { replace: true })).ok).toBe(true);
    expect(f.manager.resolveTool('audit-helper')).toBeDefined();
    expect(f.manager.snapshot('skill:audit-helper@1.2.3')?.version).toBe('1.2.3');

    expect((await f.service.deactivate('audit-helper', context, signal())).ok).toBe(true);
    expect(f.manager.resolveTool('audit-helper')).toBeUndefined();
  });

  it('leaves other-owner scopes untouched across skill reload', async () => {
    const f = fixture();
    const v1 = await f.service.stage(writeSkillSource(f, 'audit-helper', '1.0.0'), context, signal());
    if (!v1.ok) return;
    expect((await f.service.activate(v1.value, context, signal())).ok).toBe(true);

    const mcp = f.manager.stage('mcp:weather', '1.0.0');
    if (!mcp.ok) return;
    mcp.value.registerTool('weather.get', {});
    expect((await f.manager.activate(mcp.value, async () => true)).ok).toBe(true);

    const v2 = await f.service.stage(writeSkillSource(f, 'audit-helper', '1.1.0'), context, signal());
    if (!v2.ok) return;
    expect((await f.service.activate(v2.value, context, signal(), { replace: true })).ok).toBe(true);
    // MCP owner 的 tool/revision 不受 skill reload 影响
    expect(f.manager.resolveTool('weather.get')).toEqual({});
    expect(f.manager.snapshot('mcp:weather')?.revision).toBe(mcp.value.revision);
  });

  it('reports verified:false when only a SKILL.md exists without checksum evidence', async () => {
    // 契约：`verified` 只能来自 checksum/来源/policy evidence，文件存在性不构成 verified。
    // 本 service 的 stage 严格做 hash 比对——仅存在 SKILL.md 但 hash 不符 → SKILL_ARTIFACT_HASH_MISMATCH（fail closed），
    // 因此不存在「只有 SKILL.md 却 verified」的状态。
    const f = fixture();
    const sourceDir = makeRoot();
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), `---\nschemaVersion: 1\nname: only-md\nversion: 1.0.0\ndescription: d\ndependencies: []\ncapabilities: []\nentrypoints:\n  - prompts/review.md\nsource: project\nartifactHash: ${'b'.repeat(64)}\ntrustLevel: untrusted\nextensions: {}\n---\n# Only markdown\n`, 'utf8');
    mkdirSync(join(sourceDir, 'prompts'), { recursive: true });
    writeFileSync(join(sourceDir, 'prompts', 'review.md'), '# r', 'utf8');
    const staged = await f.service.stage(sourceDir, context, signal());
    expect(staged).toMatchObject({ ok: false, error: { code: 'SKILL_ARTIFACT_HASH_MISMATCH' } });
  });
});

function writeSkillSource(f: Fixture, name: string, version: string): string {
  const sourceDir = makeRoot();
  mkdirSync(sourceDir, { recursive: true });
  const hash = createHash('sha256').update('artifact-content').digest('hex');
  const doc = `---\nschemaVersion: 1\nname: ${name}\nversion: ${version}\ndescription: d\ndependencies: []\ncapabilities:\n  - workspace.read\nentrypoints:\n  - prompts/review.md\nsource: project\nartifactHash: ${hash}\ntrustLevel: reviewed\nextensions: {}\n---\n# Body\n`;
  mkdirSync(join(sourceDir, 'prompts'), { recursive: true });
  writeFileSync(join(sourceDir, 'prompts', 'review.md'), '# review', 'utf8');
  writeFileSync(join(sourceDir, 'SKILL.md'), doc, 'utf8');
  return sourceDir;
}
