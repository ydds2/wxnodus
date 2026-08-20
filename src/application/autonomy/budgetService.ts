// src/application/autonomy/budgetService.ts — 全维预算服务：reserve/commit/release + restart 快照 + evidence
import type { BudgetDimension } from '../../domain/autonomy/budgetDimensions.js';
import { ALL_BUDGET_DIMENSIONS } from '../../domain/autonomy/budgetDimensions.js';
import type { BudgetRepository } from '../../infrastructure/sqlite/budgetRepository.js';

const fail = () => ({ ok:false as const,error:{code:'BUDGET_EXCEEDED',message:'budget exceeded',messageKey:'budget.exceeded',retryable:false} });

export class BudgetService {
  constructor(private readonly repository: BudgetRepository, private readonly clock:()=>string) { void clock; }
  open(runId:string,limits:Record<BudgetDimension,number>):void { this.repository.open(runId,limits); }
  reserve(runId:string,dimension:BudgetDimension,amount:number,evidenceId:string) { if(!Number.isFinite(amount)||amount<=0)return fail();
    const totals=this.repository.totals(runId,dimension); if(totals.reserved+totals.committed+amount>this.repository.limits(runId)[dimension])return fail();
    return {ok:true as const,value:{reservationId:this.repository.reserve(runId,dimension,amount,evidenceId),timestamp:this.clock()}}; }
  commit(id:string,amount:number,evidenceId:string){ return this.repository.settle(id,'committed',amount,evidenceId)?{ok:true as const,value:undefined}:fail(); }
  release(id:string,evidenceId:string){ return this.repository.settle(id,'released',0,evidenceId)?{ok:true as const,value:undefined}:fail(); }
  snapshot(runId:string){ const limits=this.repository.limits(runId); return {runId,dimensions:Object.fromEntries(ALL_BUDGET_DIMENSIONS.map(d=>[d,{...this.repository.totals(runId,d),limit:limits[d]}])) as Record<BudgetDimension,{reserved:number;committed:number;limit:number}>}; }
  evidence(runId:string):string[]{ return this.repository.account(runId).flatMap(x=>JSON.parse(x.evidence_json) as string[]); }
}
