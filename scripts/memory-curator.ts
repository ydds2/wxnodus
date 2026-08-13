// scripts/memory-curator.ts — 记忆保留策略 CLI：默认 dry-run 只输出计划，--apply 才写库
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createMemoryCurator } from '../src/domain/memory/memoryCurator.js';
import { migrateMemory } from '../src/infrastructure/sqlite/memoryMigrations.js';
import { openMemoryRepository } from '../src/infrastructure/sqlite/memoryRepository.js';
import { closeDB, openDB } from '../src/store/db.js';

const args = process.argv.slice(2); const apply = args.includes('--apply');
const dataAt = args.indexOf('--data-dir'); const nowAt = args.indexOf('--now');
const dataDir = resolve(dataAt >= 0 ? String(args[dataAt + 1]) : String(process.env.WXNODUS_DATA_DIR ?? '.wxnodus'));
const now = nowAt >= 0 ? String(args[nowAt + 1]) : new Date().toISOString();
const db = openDB(dataDir);
try {
  migrateMemory(db, { embeddingDimensions: 384 });
  const repository = openMemoryRepository(db, { now: () => Date.parse(now), idFactory: prefix => `${prefix}-${randomUUID()}` });
  const result = createMemoryCurator(repository).run({ mode: apply ? 'apply' : 'dry-run', now });
  process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.ok) process.exitCode = 1;
} finally { closeDB(db); }
