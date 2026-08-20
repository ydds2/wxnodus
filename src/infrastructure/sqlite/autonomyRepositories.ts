// src/infrastructure/sqlite/autonomyRepositories.ts — 五类记录仓储（JSON body + revision；Run 支持 CAS 状态迁移）
import type Database from 'better-sqlite3';
import type { Attempt, Goal, Plan, PlanStep, Run, TaskState } from '../../domain/autonomy/autonomyRecords.js';
type Kind = 'goal'|'plan'|'step'|'run'|'attempt'; type WithId = { id: string };
class JsonRepository<T extends WithId> {
  constructor(protected readonly db: InstanceType<typeof Database>, private readonly kind: Kind) {}
  put(value: T): void { this.db.prepare(`INSERT INTO autonomy_records(kind,id,body,revision) VALUES(?,?,?,1)
    ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,revision=autonomy_records.revision+1`).run(this.kind,value.id,JSON.stringify(value)); }
  get(id: string): T|undefined { const row = this.db.prepare('SELECT body FROM autonomy_records WHERE kind=? AND id=?').get(this.kind,id) as {body:string}|undefined;
    return row ? JSON.parse(row.body) as T : undefined; }
}
class RunRepository extends JsonRepository<Run> {
  casState(id: string, revision: number, state: TaskState): boolean {
    const body = this.db.prepare('SELECT body FROM autonomy_records WHERE kind=? AND id=? AND revision=?').get('run',id,revision) as {body:string}|undefined;
    if (!body) return false;
    const next = { ...(JSON.parse(body.body) as Run), state, revision: revision + 1 };
    return this.db.prepare('UPDATE autonomy_records SET body=?,revision=? WHERE kind=? AND id=? AND revision=?')
      .run(JSON.stringify(next), revision + 1, 'run', id, revision).changes === 1;
  }
}
export function createAutonomyRepositories(db: InstanceType<typeof Database>) { return {
  goals: new JsonRepository<Goal>(db,'goal'), plans: new JsonRepository<Plan>(db,'plan'),
  steps: new JsonRepository<PlanStep>(db,'step'), runs: new RunRepository(db,'run'),
  attempts: new JsonRepository<Attempt>(db,'attempt'),
}; }
export type AutonomyRepositories = ReturnType<typeof createAutonomyRepositories>;
