// src/application/autonomy/progressDetector.ts — 六类无进展检测：计数器持久化，达阈值即稳定停止
import type { ProgressObservation, ProgressState, ProgressStopReason } from '../../domain/autonomy/progressReasons.js';
import type { ProgressStateRepository } from '../../infrastructure/sqlite/progressStateRepository.js';

export class ProgressDetector {
  private state:ProgressState;
  constructor(runId:string,private readonly repository:ProgressStateRepository,private readonly threshold=3) {
    this.state=repository.load(runId)??{runId,total:0,noStateChange:0,repeatedAction:0,repeatedError:0,
      noNewEvidence:0,oscillations:0,budgetStagnation:0,lastAction:null,lastError:null,lastDirection:null,stoppedReason:null};
  }
  observe(value:ProgressObservation):{reasonCode:ProgressStopReason|null} {
    if(this.state.stoppedReason)return {reasonCode:this.state.stoppedReason}; this.state.total+=1;
    this.state.noStateChange=value.stateChanged?0:this.state.noStateChange+1;
    // repeatedAction 只在 actionKey 与 planDirection 同时重复时累计（方向交替=计划在动，不算原地重复动作）
    this.state.repeatedAction=value.actionKey===this.state.lastAction&&value.planDirection===this.state.lastDirection
      ?this.state.repeatedAction+1:1;
    this.state.repeatedError=value.errorCode&&value.errorCode===this.state.lastError?this.state.repeatedError+1:value.errorCode?1:0;
    this.state.noNewEvidence=value.evidenceDelta>0?0:this.state.noNewEvidence+1;
    const changed=value.planDirection!=='same'&&this.state.lastDirection!==null&&value.planDirection!==this.state.lastDirection;
    this.state.oscillations=changed?this.state.oscillations+1:value.planDirection==='forward'?0:this.state.oscillations;
    this.state.budgetStagnation=value.budgetCommittedDelta>0?0:this.state.budgetStagnation+1;
    this.state.lastAction=value.actionKey; this.state.lastError=value.errorCode; this.state.lastDirection=value.planDirection;
    // 检查顺序：具体信号优先于 REPEATED_ACTION（actionKey 恒定时其在各类序列中都会先达阈值——
    // NO_STATE_CHANGE/REPEATED_ERROR/NO_NEW_EVIDENCE/PLAN_OSCILLATION/BUDGET_STAGNATION 先裁决）
    const checks:Array<[ProgressStopReason,number]>=[['NO_STATE_CHANGE',this.state.noStateChange],
      ['REPEATED_ERROR',this.state.repeatedError],
      ['NO_NEW_EVIDENCE',this.state.noNewEvidence],['PLAN_OSCILLATION',this.state.oscillations],
      ['BUDGET_STAGNATION',this.state.budgetStagnation],
      ['REPEATED_ACTION',this.state.repeatedAction]];
    this.state.stoppedReason=checks.find(([,count])=>count>=this.threshold)?.[0]??null;
    this.repository.save(this.state); return {reasonCode:this.state.stoppedReason};
  }
  snapshot():Readonly<ProgressState>{return structuredClone(this.state);}
}
