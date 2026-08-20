// src/application/extensions/skillLifecycleService.ts — Skill 生命周期：pipeline-backed staging → parse → boundary → hash → owned scope → smoke → 原子换入
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { ExtensionScopeManager } from './extensionScopeManager.js';
import type { ExtensionRegistrationSnapshot } from '../../domain/extensions/registrationScope.js';
import {
  parseSkillDocument,
  resolveSkillEntrypoints,
  type SkillManifest,
} from '../../infrastructure/skills/skillManifest.js';

export interface SkillCandidate {
  owner: string;
  name: string;
  version: string;
  manifest: SkillManifest;
  body: string;
  stagedDir: string;
}

export interface SkillMigrationReport {
  migrated: Array<{ name: string; version: string; from: string; to: string }>;
  skipped: string[];
}

export interface SkillLifecycleDeps {
  dataDir: string;
  scopeManager: ExtensionScopeManager;
  /** staging 拷贝（生产走 W1 pipeline effect；测试注入受控实现） */
  copy(source: string, target: string): Promise<OperationResult<void>>;
  /** 目录原子换入（staging → live；replace=false 且目标存在 → SKILL_TARGET_EXISTS） */
  promote(stagedDir: string, targetDir: string, replace: boolean): Promise<OperationResult<void>>;
  remove(targetDir: string): Promise<OperationResult<void>>;
  /** 目录内容 SHA-256（与 manifest.artifactHash 比对） */
  hashOf(dir: string): Promise<string>;
  smoke(candidate: SkillCandidate): Promise<boolean>;
}

export class SkillLifecycleService {
  constructor(private readonly deps: SkillLifecycleDeps) {}

  async stage(sourceDir: string, _context: OperationContext, signal: AbortSignal): Promise<OperationResult<SkillCandidate>> {
    if (signal.aborted) return err(gatewayError('OPERATION_CANCELLED', 'stage cancelled', 'operation.cancelled'));
    const stagingDir = join(this.deps.dataDir, 'skills', '.staging', randomUUID());
    const copied = await this.deps.copy(sourceDir, stagingDir);
    if (!copied.ok) { await this.deps.remove(stagingDir); return copied; }
    const skillPath = join(stagingDir, 'SKILL.md');
    try {
      const text = readFileSync(skillPath, 'utf8');
      const parsed = parseSkillDocument(text, `skill:${sourceDir}`);
      resolveSkillEntrypoints(stagingDir, parsed.manifest);
      const actual = await this.deps.hashOf(stagingDir);
      if (actual !== parsed.manifest.artifactHash) {
        await this.deps.remove(stagingDir);
        return err(gatewayError('SKILL_ARTIFACT_HASH_MISMATCH', parsed.manifest.name, 'skill.artifact.hash'));
      }
      return ok({
        owner: `skill:${parsed.manifest.name}@${parsed.manifest.version}`,
        name: parsed.manifest.name,
        version: parsed.manifest.version,
        manifest: parsed.manifest,
        body: parsed.body,
        stagedDir: stagingDir,
      });
    } catch (cause) {
      await this.deps.remove(stagingDir);
      const code = (cause as { code?: string }).code;
      return err(gatewayError(typeof code === 'string' && code.startsWith('SKILL_') ? code : 'SKILL_MANIFEST_INVALID',
        sourceDir, 'skill.stage.failed', { retryable: false, details: { cause: String(cause) } }));
    }
  }

  async activate(candidate: SkillCandidate, _context: OperationContext, signal: AbortSignal, options: { replace?: boolean } = {}): Promise<OperationResult<ExtensionRegistrationSnapshot>> {
    const registered = await this.registerScope(candidate, signal);
    if (!registered.ok) return registered;
    const target = join(this.deps.dataDir, 'skills', candidate.name);
    const promoted = await this.deps.promote(candidate.stagedDir, target, options.replace === true);
    if (!promoted.ok) { await registered.value.dispose(); return promoted; }
    // 换入成功后先 dispose 旧版本 owner（skill:<name>@<旧版本>——版本不同 owner key 不同，须按 name 前缀清理）
    const previous = this.deps.scopeManager.activeOwners()
      .filter(owner => owner.startsWith(`skill:${candidate.name}@`) && owner !== candidate.owner);
    for (const old of previous) {
      const disposed = await this.deps.scopeManager.deactivate(old);
      if (!disposed.ok) return disposed;
    }
    return this.deps.scopeManager.activate(registered.value, async () => true);
  }

  /** scope-only 注册（activate 的前半段：stage → 注册 candidate scope → smoke；不 promote、不删 staging） */
  private async registerScope(candidate: SkillCandidate, signal: AbortSignal) {
    if (signal.aborted) { await this.deps.remove(candidate.stagedDir); return err(gatewayError('OPERATION_CANCELLED', 'activate cancelled', 'operation.cancelled')); }
    const staged = this.deps.scopeManager.stage(candidate.owner, candidate.version);
    if (!staged.ok) { await this.deps.remove(candidate.stagedDir); return staged; }
    const scope = staged.value;
    const tool = scope.registerTool(candidate.name, { manifest: candidate.manifest, body: candidate.body });
    if (!tool.ok) { await scope.dispose(); await this.deps.remove(candidate.stagedDir); return tool; }
    for (const capability of candidate.manifest.capabilities) {
      const registered = scope.registerCommand(`${candidate.name}:${capability}`, { capability });
      if (!registered.ok) { await scope.dispose(); await this.deps.remove(candidate.stagedDir); return registered; }
    }
    const passed = await this.deps.smoke(candidate);
    if (!passed) {
      await scope.dispose();
      await this.deps.remove(candidate.stagedDir);
      return err(gatewayError('SKILL_SCOPE_ACTIVATION_FAILED', candidate.name, 'skill.scope.activation'));
    }
    return ok(scope);
  }

  async deactivate(name: string, _context: OperationContext, signal: AbortSignal): Promise<OperationResult<void>> {
    if (signal.aborted) return err(gatewayError('OPERATION_CANCELLED', 'deactivate cancelled', 'operation.cancelled'));
    const owner = this.deps.scopeManager.activeOwners().find(candidate => candidate.startsWith(`skill:${name}@`));
    if (owner) {
      const disposed = await this.deps.scopeManager.deactivate(owner);
      if (!disposed.ok) return disposed;
    }
    return this.deps.remove(join(this.deps.dataDir, 'skills', name));
  }

  /** 迁移两个 legacy 布局：<dataDir>/skills/<name>/SKILL.md 与 <dataDir>/forge/<pkg>/<name>/SKILL.md；
   *  先 copy 到 staging、hash/read-back、activate，成功才写 report；源路径不删除，失败源字节不变。 */
  async migrateLegacy(_context: OperationContext, signal: AbortSignal): Promise<OperationResult<SkillMigrationReport>> {
    const report: SkillMigrationReport = { migrated: [], skipped: [] };
    const roots: string[] = [];
    try {
      const skillsRoot = join(this.deps.dataDir, 'skills');
      const forgeRoot = join(this.deps.dataDir, 'forge');
      if (existsSync(skillsRoot)) {
        const { readdirSync } = await import('node:fs');
        for (const entry of readdirSync(skillsRoot)) {
          if (existsSync(join(skillsRoot, entry, 'SKILL.md'))) roots.push(join(skillsRoot, entry));
        }
      }
      if (existsSync(forgeRoot)) {
        const { readdirSync } = await import('node:fs');
        for (const pkg of readdirSync(forgeRoot)) {
          const pkgDir = join(forgeRoot, pkg);
          for (const entry of (() => { try { return readdirSync(pkgDir); } catch { return []; } })()) {
            if (existsSync(join(pkgDir, entry, 'SKILL.md'))) roots.push(join(pkgDir, entry));
          }
        }
      }
      for (const from of roots) {
        if (signal.aborted) return err(gatewayError('OPERATION_CANCELLED', 'migration cancelled', 'operation.cancelled'));
        const staged = await this.stage(from, _context, signal);
        if (!staged.ok) {
          if (staged.error.code === 'SKILL_TARGET_EXISTS') { report.skipped.push(from); continue; }
          return err(gatewayError('SKILL_LEGACY_LAYOUT_INVALID', from, 'skill.legacy.layout', { retryable: false, details: { cause: staged.error.code } }));
        }
        // legacy 迁移只做 scope-only 激活：源路径是 canonical 位置，report 持久化前不得删除/移动
        const registered = await this.registerScope(staged.value, signal);
        if (!registered.ok) return err(gatewayError('SKILL_LEGACY_LAYOUT_INVALID', from, 'skill.legacy.layout', { retryable: false, details: { cause: registered.error.code } }));
        const activated = await this.deps.scopeManager.activate(registered.value, async () => true);
        if (!activated.ok) return err(gatewayError('SKILL_LEGACY_LAYOUT_INVALID', from, 'skill.legacy.layout', { retryable: false, details: { cause: activated.error.code } }));
        await this.deps.remove(staged.value.stagedDir);
        report.migrated.push({ name: staged.value.name, version: staged.value.version, from, to: from });
      }
      return ok(report);
    } catch (cause) {
      return err(gatewayError('SKILL_LEGACY_LAYOUT_INVALID', 'migrate', 'skill.legacy.layout', { retryable: false, details: { cause: String(cause) } }));
    }
  }
}
