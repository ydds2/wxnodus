// src/bootstrap/bootstrapTypes.ts — 组合根阶段类型（顺序固定：config → repositories → kernel → extensions → presentation）
import type { ApplicationServices } from '../application/applicationServices.js';
import type { CapabilityPort } from '../domain/capabilities/capability.js';
import type { GatewayPort } from '../protocol/gateway.js';
import type { OperationResult } from '../protocol/results.js';

export type BootstrapPhaseName = 'config' | 'repositories' | 'kernel' | 'extensions' | 'presentation';

export interface BootstrapResource {
  id: string;
  dispose(reason: string): void | Promise<void>;
}

export interface BootstrapState {
  config?: unknown;
  repositories?: unknown;
  services?: ApplicationServices;
  gateway?: GatewayPort;
  capabilities?: CapabilityPort;
  extensions?: unknown;
  presentation?: unknown;
}

export interface BootstrapPhaseOutput {
  patch?: Partial<BootstrapState>;
  resources?: BootstrapResource[];
}

export type BootstrapPhase = (state: Readonly<BootstrapState>) => Promise<OperationResult<BootstrapPhaseOutput>>;

export interface BootstrapOptions {
  headless: boolean;
  phases: Record<BootstrapPhaseName, BootstrapPhase>;
}

export interface ApplicationInstance {
  services: ApplicationServices;
  gateway: GatewayPort;
  capabilities: CapabilityPort;
  shutdown(reason: string): Promise<void>;
}
