// src/application/extensions/extensionLifecycleService.ts — 扩展生命周期：stage → register candidate → smoke → activate（唯一顺序）
import type { OperationResult } from '../../protocol/results.js';
import type { ExtensionRegistrationSnapshot } from '../../domain/extensions/registrationScope.js';
import { ExtensionScopeManager } from './extensionScopeManager.js';

export interface LifecycleInput {
  owner: string;
  version: string;
  tools?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  disposers?: Array<() => void | Promise<void>>;
  smoke(): Promise<boolean>;
}

export class ExtensionLifecycleService {
  constructor(private readonly manager: ExtensionScopeManager) {}
  async load(input: LifecycleInput): Promise<OperationResult<ExtensionRegistrationSnapshot>> {
    const staged = this.manager.stage(input.owner, input.version);
    if (!staged.ok) return staged;
    for (const [id, value] of Object.entries(input.tools ?? {})) {
      const registered = staged.value.registerTool(id, value);
      if (!registered.ok) return registered;
    }
    for (const [id, value] of Object.entries(input.commands ?? {})) {
      const registered = staged.value.registerCommand(id, value);
      if (!registered.ok) return registered;
    }
    for (const disposer of input.disposers ?? []) staged.value.addDisposer(disposer);
    return this.manager.activate(staged.value, input.smoke);
  }
  deactivate(owner: string) { return this.manager.deactivate(owner); }
  resolveTool(id: string): unknown { return this.manager.resolveTool(id); }
  snapshot(owner: string) { return this.manager.snapshot(owner); }
}
