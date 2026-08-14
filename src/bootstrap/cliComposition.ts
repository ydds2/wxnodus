// src/bootstrap/cliComposition.ts — W8-00：组合根接管第一刀（CLI 核心依赖装配）
// 固定阶段 config → repositories → kernel：同一装配权威、失败只 dispose 已启动资源（fail-closed）、
// shutdown 幂等（bootstrapShutdown 语义）。CLI 组合根不再内联 createConfig/openDB/createMemory——
// 依赖装配从这里产出（presentation/services 现代翻转留后续切片）。
import { randomUUID } from 'node:crypto';
import type { Config } from '../store/config.js';
import type { Db } from '../store/db.js';
import type { Memory } from '../kernel/memory.js';
import type { MemoryRepository } from '../domain/memory/memoryRepository.js';
import type { CodeIndexRepository } from '../infrastructure/code/codeIndexRepository.js';
import type { OperationResult } from '../protocol/results.js';
import { configError } from '../domain/config/configSchema.js';
import { createShutdown } from './bootstrapShutdown.js';

export interface CliCompositionDeps {
  dataDir: string;
  /** W7-00：主工作区根（下载/同化边界——本阶段透传，供上层工具装配使用） */
  workspaceRoot: string;
}

export interface CliCompositionValue {
  config: Config;
  db: Db;
  codeIndex: CodeIndexRepository;
  memoryRepository: MemoryRepository;
  mem: Memory;
  shutdown(reason: string): Promise<string[]>;
}

type Phase = (state: Readonly<Record<string, unknown>>) => Promise<OperationResult<{ patch?: Record<string, unknown>; resources?: Array<{ id: string; dispose(): void }> }>>;

const ORDER = ['config', 'repositories', 'kernel'] as const;

export async function createCliComposition(deps: CliCompositionDeps): Promise<OperationResult<CliCompositionValue>> {
  const state: Record<string, unknown> = {};
  const resources: Array<{ id: string; dispose(): void }> = [];
  const shutdown = createShutdown(resources);

  const phases: Record<(typeof ORDER)[number], Phase> = {
    config: async () => {
      const { createConfig } = await import('../store/config.js');
      return { ok: true, value: { patch: { config: createConfig(deps.dataDir) } } };
    },
    repositories: async () => {
      const { openDB, closeDB } = await import('../store/db.js');
      const { CodeIndexRepository: Repo } = await import('../infrastructure/code/codeIndexRepository.js');
      const { openMemoryRepository } = await import('../infrastructure/sqlite/memoryRepository.js');
      const db = openDB(deps.dataDir);
      const codeIndex = new Repo(db);
      codeIndex.install();
      const memoryRepository = openMemoryRepository(db, {
        now: () => Date.now(),
        idFactory: prefix => `${prefix}-${randomUUID()}`,
      });
      return {
        ok: true,
        value: {
          patch: { db, codeIndex, memoryRepository },
          resources: [{ id: 'db', dispose: () => { closeDB(db); } }],
        },
      };
    },
    kernel: async (current) => {
      const { createMemory } = await import('../kernel/memory.js');
      const { createMemoryShadow } = await import('../application/memory/memoryShadow.js');
      const memBase = createMemory(current.db as Db);
      const mem = createMemoryShadow({ legacy: memBase, repository: current.memoryRepository as MemoryRepository, db: current.db as Db });
      return { ok: true, value: { patch: { mem } } };
    },
  };

  for (const name of ORDER) {
    let result: OperationResult<{ patch?: Record<string, unknown>; resources?: Array<{ id: string; dispose(): void }> }>;
    try {
      result = await phases[name](state);
    } catch (cause) {
      result = { ok: false, error: configError('CLI_COMPOSITION_PHASE_THREW', 'cli.composition.phase_threw', { phase: name, cause: String((cause as Error).message ?? cause) }) };
    }
    if (!result.ok) {
      await shutdown(`cli-composition:${name}:failed`);
      return { ok: false, error: configError('CLI_COMPOSITION_PHASE_FAILED', 'cli.composition.phase_failed', { phase: name, cause: result.error.code }) };
    }
    Object.assign(state, result.value.patch ?? {});
    resources.push(...(result.value.resources ?? []));
  }

  return {
    ok: true,
    value: {
      config: state.config as Config,
      db: state.db as Db,
      codeIndex: state.codeIndex as CodeIndexRepository,
      memoryRepository: state.memoryRepository as MemoryRepository,
      mem: state.mem as Memory,
      shutdown,
    },
  };
}
