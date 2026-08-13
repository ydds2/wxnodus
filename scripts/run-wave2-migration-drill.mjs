// scripts/run-wave2-migration-drill.mjs — Wave 2 迁移演练入口（真实文件 DB；失败非零退出）
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runWave2MigrationDrill } from './wave2Migration.mjs';
const dbPath = resolve(process.env.WXNODUS_WAVE2_DB ?? '.wxnodus/wave2-migration-drill.db');
mkdirSync(dirname(dbPath), { recursive:true });
const report = runWave2MigrationDrill(dbPath);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) process.exitCode = 1;
