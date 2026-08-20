// src/infrastructure/sqlite/progressStateRepository.ts — ProgressDetector 状态持久化（restart 后计数器/reason 延续）
import type Database from 'better-sqlite3';
import type { ProgressState } from '../../domain/autonomy/progressReasons.js';
export class ProgressStateRepository {
  constructor(private readonly db:InstanceType<typeof Database>) { this.db.exec('CREATE TABLE IF NOT EXISTS progress_detector_state(run_id TEXT PRIMARY KEY,body TEXT NOT NULL)'); }
  load(runId:string):ProgressState|undefined { const row=this.db.prepare('SELECT body FROM progress_detector_state WHERE run_id=?').get(runId) as {body:string}|undefined;
    return row?JSON.parse(row.body) as ProgressState:undefined; }
  save(value:ProgressState):void { this.db.prepare('INSERT INTO progress_detector_state VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body').run(value.runId,JSON.stringify(value)); }
}
