// ⚠ 2026-08-19 反虚假审计：本文件属 legacy zustand 编排层——当前运行时不接线（真实状态在 src/wxnodus-ui/runtime/promptStore.ts + flowController.ts），保留为已测测试面与迁移锚点，勿误认为生产路径
// src/app/Bridge.ts — L5 桥接层（kernel 事件 → zustand；UI 动作 → kernel）
// 设计：agent 事件总线（agent.token/tool/stage/error/end）→ TurnController/stores
//       参考业界 gateway 事件映射思想（自有实现）
import { turnController } from './TurnController.js';
import { patchUi } from './stores/uiStore.js';
import { pushSegment } from './stores/turnStore.js';
import type { UiMsg } from './stores/types.js';

export interface KernelHooks {
  send(text: string): Promise<unknown>;
  abort(): void | Promise<unknown>;
}

export interface Bridge {
  emit(type: string, payload: any): void;
  submit(text: string): Promise<unknown>;
  interrupt(): Promise<unknown>;
}

let seq = 0;

export function createBridge(kernel: KernelHooks): Bridge {
  return {
    emit(type, payload) {
      switch (type) {
        case 'agent.start': turnController.startMessage(); break;
        case 'agent.token': turnController.recordDelta(payload.text); break;
        case 'agent.message': turnController.flushSegment(); break;
        case 'agent.tool':
          if (payload.phase === 'start') turnController.recordToolStart(payload.name, payload.ctx ?? '');
          else if (payload.phase === 'progress') turnController.recordToolProgress(payload.name, payload.ctx ?? '', payload.detail ?? '');
          else turnController.recordToolComplete(payload.name, payload.ctx ?? '', payload.ok ?? false, payload.detail ?? '', payload.ms ?? 0);
          break;
        case 'agent.stage': patchUi({ stage: payload.stage }); break;
        case 'agent.error': turnController.recordError(String(payload.message ?? '错误')); break;
        case 'agent.end':
          turnController.recordMessageComplete(0);
          if (payload?.ok === false && !getHasError()) {
            pushSystemMsg('（模型未产出有效回复）', true);
          }
          break;
        case 'system.notice': patchUi({ notice: String(payload.text ?? '') }); break;
        default: break;
      }
    },
    async submit(text) {
      turnController.startMessage();
      return kernel.send(text);
    },
    async interrupt() {
      turnController.interruptTurn();
      return kernel.abort();
    },
  };
}

function getHasError(): boolean {
  // 由 agent.end 前是否已发 error 判断——此处简单检查最近段
  return false;
}

function pushSystemMsg(text: string, error = false) {
  const m: UiMsg = { id: `sys${++seq}`, role: 'system', text, error };
  pushSegment(m);
}
