// scripts/wave2GateRunner.d.mts — 类型声明（实现见 wave2GateRunner.mjs）
export interface Wave2GateReport {
  ok: boolean;
  failures: string[];
  unavailable: { computer: string; forge: string };
  checked: string[];
}
export declare function runWave2Gates(input: { rootDir: string; migration: unknown }): Wave2GateReport;
