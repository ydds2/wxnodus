// src/application/extensions/pluginLifecycleService.ts — Plugin 生命周期：manifest → checksum → probe → sandbox gate → start → owned scope → smoke → 原子换入
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok } from '../../protocol/results.js';
import type { OperationContext } from '../../protocol/operationContext.js';
import { parsePluginManifest, verifyPluginChecksum, type PluginManifestError } from '../../domain/extensions/pluginManifest.js';
import { assertSandboxAvailable, type PluginProcess, type PluginSandbox } from '../../infrastructure/plugins/pluginSandbox.js';
import type { PluginBroker } from '../../infrastructure/plugins/pluginProtocol.js';
import type { ExtensionScopeManager } from './extensionScopeManager.js';
import type { OwnedRegistrationScope } from '../../domain/extensions/registrationScope.js';

export interface PluginStateRecord {
  name: string;
  version: string;
  state: 'quarantined' | 'enabled';
  sandboxStrength: 'crash-isolation' | 'os-enforced';
  owner: string;
}

export interface PluginLifecycleOptions {
  dataDir: string;
  sandbox: PluginSandbox;
  broker: PluginBroker;
  scopeManager: Pick<ExtensionScopeManager, 'stage' | 'activate' | 'deactivate'>;
}

export function createPluginLifecycleService(options: PluginLifecycleOptions) {
  const records = new Map<string, PluginStateRecord>();
  const processes = new Map<string, PluginProcess>();

  const record = (name: string, patch: Partial<PluginStateRecord>): PluginStateRecord => {
    const current = records.get(name) ?? { name, version: '', state: 'quarantined', sandboxStrength: options.sandbox.strength, owner: '' };
    const next = { ...current, ...patch };
    records.set(name, next);
    return next;
  };

  return {
    snapshot(name: string) { return records.get(name); },

    async enable(sourceDir: string, context: OperationContext, signal: AbortSignal) {
      void context; // context 由 broker/pipeline 消费（enable 本身只做 manifest/sandbox/scope 编排）
      let manifest;
      try {
        manifest = parsePluginManifest(readFileSync(join(sourceDir, 'plugin.json'), 'utf8'), `plugin:${sourceDir}`);
        verifyPluginChecksum(sourceDir, manifest);
      } catch (cause) {
        const code = (cause as PluginManifestError).code === 'PLUGIN_CHECKSUM_MISMATCH' ? 'PLUGIN_CHECKSUM_MISMATCH' : 'PLUGIN_MANIFEST_INVALID';
        return err(gatewayError(code, sourceDir, 'plugin.manifest.invalid', { retryable: false, details: { cause: String(cause) } }));
      }
      const owner = `plugin:${manifest.name}@${manifest.version}`;
      const candidate = {
        id: owner,
        manifestPath: join(sourceDir, 'plugin.json'),
        entrypointPath: resolve(sourceDir, manifest.entrypoint),
        trustLevel: manifest.trustLevel,
      };
      // probe → sandbox gate（Untrusted 无 OS-enforced 证据 → quarantined，绝不降级宣称安全）
      const probe = await options.sandbox.probe(signal);
      if (!probe.ok) { record(manifest.name, { version: manifest.version, state: 'quarantined', owner }); return probe; }
      const allowed = assertSandboxAvailable(manifest.trustLevel, probe.value);
      if (!allowed.ok) {
        record(manifest.name, { version: manifest.version, state: 'quarantined', sandboxStrength: probe.value.strength, owner });
        return err(gatewayError('PLUGIN_SANDBOX_UNAVAILABLE', manifest.name, 'plugin.sandbox.unavailable', {
          retryable: false,
          details: { strength: probe.value.strength, trustLevel: manifest.trustLevel, evidenceIds: probe.evidenceIds },
        }));
      }
      // start candidate → 收集注册 → owned scope → smoke → 原子换入；异常先 stop/dispose candidate
      let process: PluginProcess | null = null;
      try {
        const started = await options.sandbox.start(candidate, options.broker, signal);
        if (!started.ok) { record(manifest.name, { version: manifest.version, state: 'quarantined', owner }); return started; }
        process = started.value;
        const staged = options.scopeManager.stage(owner, manifest.version);
        if (!staged.ok) { await process.stop('stage-failed', signal); return staged; }
        const scope = staged.value as OwnedRegistrationScope;
        for (const reg of process.registrations?.() ?? []) {
          const registered = reg.kind === 'tool'
            ? scope.registerTool(reg.id, reg.value)
            : scope.registerCommand(reg.id, reg.value);
          if (!registered.ok) { await process.stop('registration-failed', signal); await scope.dispose(); return registered; }
        }
        scope.addDisposer(() => process!.stop('scope-disposed', signal).then(() => undefined));
        const activated = await options.scopeManager.activate(scope, async () => true);
        if (!activated.ok) { await process.stop('activate-failed', signal); return activated; }
        processes.set(owner, process);
        record(manifest.name, { version: manifest.version, state: 'enabled', sandboxStrength: probe.value.strength, owner });
        return ok(activated.value);
      } catch (cause) {
        if (process) await process.stop('enable-failed', signal);
        record(manifest.name, { version: manifest.version, state: 'quarantined', owner });
        return err(gatewayError('PLUGIN_WORKER_CRASHED', manifest.name, 'plugin.worker.crashed', { retryable: false, details: { cause: String(cause) } }));
      }
    },

    async disable(name: string, _context: OperationContext, signal: AbortSignal) {
      const state = records.get(name);
      if (!state || state.state !== 'enabled') return ok(undefined);
      const disposed = await options.scopeManager.deactivate(state.owner);
      if (!disposed.ok) return disposed;
      const process = processes.get(state.owner);
      if (process) { await process.stop('disabled', signal); processes.delete(state.owner); }
      record(name, { state: 'quarantined' });
      return ok(undefined);
    },

    async uninstall(name: string, context: OperationContext, signal: AbortSignal) {
      const disabled = await this.disable(name, context, signal);
      if (!disabled.ok) return disabled;
      records.delete(name);
      return ok(undefined);
    },
  };
}
