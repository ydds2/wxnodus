// scripts/run-wave2-gates.mjs — Wave 2 Gate 入口：migration drill + gate 求值（失败非零退出）
import { resolve } from 'node:path';
import { runWave2MigrationDrill } from './wave2Migration.mjs';
import { runWave2Gates } from './wave2GateRunner.mjs';
const rootDir = resolve(process.env.WXNODUS_ROOT ?? process.cwd());
const migration = runWave2MigrationDrill(resolve(process.env.WXNODUS_WAVE2_DB ?? '.wxnodus/wave2-gate.db'));
const report = runWave2Gates({ rootDir, migration });
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 1;
