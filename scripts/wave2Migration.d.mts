// scripts/wave2Migration.d.mts — 类型声明（实现见 wave2Migration.mjs）
export interface Wave2MigrationReport {
  ok: boolean;
  step: string;
  schemaVersion: number;
  evidenceId: string;
  sequence: string[];
  evidenceIds: string[];
  newWriteTable: string;
  legacyTasksReadable: boolean;
  finalSchemaVersion: number;
}
export declare function runWave2MigrationDrill(dbPath: string): Wave2MigrationReport;
