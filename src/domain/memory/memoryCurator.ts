// src/domain/memory/memoryCurator.ts — 保留策略执行器：dry-run 只读，apply 才写库
import type { MemoryRepository } from './memoryRepository.js';
import { ok } from '../../protocol/results.js';

export function createMemoryCurator(repository: MemoryRepository) {
  return { run(input: { mode: 'dry-run'|'apply'; now: string }) {
    const actions = repository.retentionPlan(Date.parse(input.now));
    if (input.mode === 'dry-run') return ok({ mode: input.mode, actions, applied: 0 });
    const applied = repository.applyRetention(actions, Date.parse(input.now));
    return applied.ok ? ok({ mode: input.mode, actions, applied: applied.value }) : applied;
  } };
}
