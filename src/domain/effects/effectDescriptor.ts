// src/domain/effects/effectDescriptor.ts — 副作用描述符（ToolCatalog/PDP/EffectJournal 共用）
export type EffectKind =
  | 'filesystem.read' | 'filesystem.write' | 'process.spawn' | 'network.request'
  | 'memory.read' | 'memory.write' | 'config.write' | 'extension.manage' | 'ui.external';

export interface EffectDescriptor {
  kind: EffectKind;
  resource: string;
  operation: string;
  external: boolean;
  dataClassification: 'public' | 'internal' | 'secret';
  reversibility: 'reversible' | 'compensatable' | 'irreversible';
}

export function createEffectDescriptor(input: EffectDescriptor): EffectDescriptor {
  return Object.freeze({ ...input });
}
