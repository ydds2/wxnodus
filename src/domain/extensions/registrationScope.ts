// src/domain/extensions/registrationScope.ts — 扩展 owned 注册作用域：同 owner 内幂等注册 + 逆序 dispose
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface ExtensionRegistrationSnapshot { owner: string; version: string; revision: number; tools: readonly string[]; commands: readonly string[] }

export class OwnedRegistrationScope {
  readonly tools = new Map<string, unknown>();
  readonly commands = new Map<string, unknown>();
  private readonly disposers: Array<() => void | Promise<void>> = [];
  private disposed = false;
  constructor(readonly owner: string, readonly version: string, readonly revision: number) {}
  registerTool(id: string, value: unknown): OperationResult<void> {
    if (this.disposed || this.tools.has(id)) return err(gatewayError('EXTENSION_OWNER_CONFLICT', id, 'extension.owner.conflict'));
    this.tools.set(id, value); return ok(undefined);
  }
  registerCommand(id: string, value: unknown): OperationResult<void> {
    if (this.disposed || this.commands.has(id)) return err(gatewayError('EXTENSION_OWNER_CONFLICT', id, 'extension.owner.conflict'));
    this.commands.set(id, value); return ok(undefined);
  }
  addDisposer(disposer: () => void | Promise<void>): void { this.disposers.push(disposer); }
  snapshot(): ExtensionRegistrationSnapshot { return Object.freeze({ owner: this.owner, version: this.version,
    revision: this.revision, tools: Object.freeze([...this.tools.keys()].sort()), commands: Object.freeze([...this.commands.keys()].sort()) }); }
  async dispose(): Promise<OperationResult<void>> {
    if (this.disposed) return ok(undefined); this.disposed = true;
    try { for (const disposer of [...this.disposers].reverse()) await disposer(); return ok(undefined); }
    catch (cause) { return err(gatewayError('EXTENSION_DISPOSE_FAILED', String(cause), 'extension.dispose.failed')); }
  }
}
