// src/infrastructure/plugins/pluginSandbox.ts — Plugin sandbox 策略：Trusted=crash-isolation；Untrusted 必须 OS 强制且有完整 probe evidence
import type { OperationResult } from '../../protocol/results.js';
import type { PluginBroker } from './pluginProtocol.js';

export interface SandboxProbeEvidence {
  strength: 'crash-isolation' | 'os-enforced';
  environmentCleared: boolean;
  inheritedHandlesBlocked: boolean;
  filesystemDenied: boolean;
  networkDenied: boolean;
  processDenied: boolean;
  credentialDenied: boolean;
  evidenceIds: string[];
}

export interface PluginCandidate {
  id: string;
  manifestPath: string;
  entrypointPath: string;
  trustLevel: 'trusted' | 'untrusted';
}

export interface PluginRegistration {
  kind: 'tool' | 'command' | 'event' | 'nl-trigger';
  id: string;
  value: unknown;
}

export interface PluginProcess {
  readonly processId: string;
  registrations?(): PluginRegistration[] | null;
  stop(reason: string, signal: AbortSignal): Promise<OperationResult<{ stopped: true }>>;
}

export interface PluginSandbox {
  readonly strength: 'crash-isolation' | 'os-enforced';
  probe(signal: AbortSignal): Promise<OperationResult<SandboxProbeEvidence>>;
  start(
    candidate: PluginCandidate,
    broker: PluginBroker,
    signal: AbortSignal,
  ): Promise<OperationResult<PluginProcess>>;
}

export function assertSandboxAvailable(
  trustLevel: PluginCandidate['trustLevel'],
  probe: SandboxProbeEvidence,
): OperationResult<SandboxProbeEvidence> {
  if (trustLevel === 'trusted') return { ok: true, value: probe, evidenceIds: probe.evidenceIds };
  const enforced = probe.strength === 'os-enforced'
    && probe.environmentCleared
    && probe.inheritedHandlesBlocked
    && probe.filesystemDenied
    && probe.networkDenied
    && probe.processDenied
    && probe.credentialDenied;
  if (!enforced) {
    return {
      ok: false,
      error: {
        code: 'PLUGIN_SANDBOX_UNAVAILABLE',
        message: 'Untrusted Plugin requires a verified OS-enforced sandbox',
        messageKey: 'PLUGIN_SANDBOX_UNAVAILABLE',
        retryable: false,
        details: { strength: probe.strength },
      },
      evidenceIds: probe.evidenceIds,
    };
  }
  return { ok: true, value: probe, evidenceIds: probe.evidenceIds };
}
