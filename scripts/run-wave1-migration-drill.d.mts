// scripts/run-wave1-migration-drill.d.mts — 类型声明（实现见 run-wave1-migration-drill.mjs）
export interface WaveMigrationDrillDescriptor {
  id: string;
  strategy: 'rollbackable' | 'forward-only';
  upgrade(): Promise<void>;
  confirmNewWrite(): Promise<void>;
  rollback?(): Promise<void>;
  reconcile?(): Promise<void>;
  recovery?(): Promise<void>;
  reupgrade(): Promise<void>;
}
export declare function runWaveMigrationDrill(descriptor: WaveMigrationDrillDescriptor):
  Promise<{ ok: true } | { ok: false; error: { code: 'MIGRATION_DRILL_FAILED'; stage: string; cause?: string } }>;
