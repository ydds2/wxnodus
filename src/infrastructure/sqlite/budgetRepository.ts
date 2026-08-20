// src/infrastructure/sqlite/budgetRepository.ts — 预算账本仓储：account/reservation/settle（evidence 链持久化）
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BudgetDimension } from '../../domain/autonomy/budgetDimensions.js';
export class BudgetRepository {
  constructor(private readonly db: InstanceType<typeof Database>) {}
  open(runId: string, limits: Record<BudgetDimension,number>): void { this.db.prepare('INSERT OR REPLACE INTO budget_accounts VALUES(?,?)').run(runId,JSON.stringify(limits)); }
  limits(runId: string): Record<BudgetDimension,number> { const row=this.db.prepare('SELECT limits_json FROM budget_accounts WHERE run_id=?').get(runId) as {limits_json:string}; return JSON.parse(row.limits_json); }
  totals(runId: string, dimension: BudgetDimension) { return this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved ELSE 0 END),0) reserved,
    COALESCE(SUM(committed),0) committed FROM budget_reservations WHERE run_id=? AND dimension=?`).get(runId,dimension) as {reserved:number;committed:number}; }
  reserve(runId:string,dimension:BudgetDimension,amount:number,evidenceId:string): string { const id=randomUUID(); this.db.prepare('INSERT INTO budget_reservations VALUES(?,?,?,?,0,?,?)')
    .run(id,runId,dimension,amount,'reserved',JSON.stringify([evidenceId])); return id; }
  settle(id:string,status:'committed'|'released',committed:number,evidenceId:string): boolean { const row=this.db.prepare('SELECT evidence_json FROM budget_reservations WHERE id=? AND status=?').get(id,'reserved') as {evidence_json:string}|undefined;
    if(!row)return false; return this.db.prepare('UPDATE budget_reservations SET status=?,committed=?,evidence_json=? WHERE id=? AND status=?')
      .run(status,committed,JSON.stringify([...JSON.parse(row.evidence_json),evidenceId]),id,'reserved').changes===1; }
  account(runId:string) { return this.db.prepare('SELECT dimension,reserved,committed,status,evidence_json FROM budget_reservations WHERE run_id=?').all(runId) as Array<{dimension:BudgetDimension;reserved:number;committed:number;status:string;evidence_json:string}>; }
}
