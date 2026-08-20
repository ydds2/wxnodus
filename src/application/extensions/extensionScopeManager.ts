// src/application/extensions/extensionScopeManager.ts — owned scope 管理：stage → smoke → 原子换入 → 旧 scope 逆序 dispose
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import { OwnedRegistrationScope } from '../../domain/extensions/registrationScope.js';

export class ExtensionScopeManager {
  private revision = 0;
  private readonly active = new Map<string, OwnedRegistrationScope>();
  stage(owner: string, version: string) {
    if (!/^(mcp|skill|plugin):[a-z0-9._-]+(?:@[a-zA-Z0-9._-]+)?$/.test(owner))
      return err(gatewayError('EXTENSION_OWNER_CONFLICT', owner, 'extension.owner.invalid'));
    return ok(new OwnedRegistrationScope(owner, version, ++this.revision));
  }
  async activate(candidate: OwnedRegistrationScope, smoke: () => Promise<boolean>) {
    let passed = false;
    try { passed = await smoke(); } catch { passed = false; }
    if (!passed) { await candidate.dispose(); return err(gatewayError('EXTENSION_SMOKE_FAILED', candidate.owner, 'extension.smoke.failed')); }
    const old = this.active.get(candidate.owner);
    this.active.set(candidate.owner, candidate); // single visible revision swap happens before old disposal
    if (old) { const disposed = await old.dispose(); if (!disposed.ok) return disposed; }
    return ok(candidate.snapshot());
  }
  async deactivate(owner: string) { const old = this.active.get(owner); if (!old) return ok(undefined);
    this.active.delete(owner); return old.dispose(); }
  snapshot(owner: string) { return this.active.get(owner)?.snapshot(); }
  activeOwners(): string[] { return [...this.active.keys()]; }
  resolveTool(id: string): unknown { for (const scope of this.active.values()) if (scope.tools.has(id)) return scope.tools.get(id); }
}
