// src/application/forge/exemplarPool.ts — exemplar 池最小版（蓝图公理六）：按能力指纹 keyed 的 few-shot 沉淀与召回（确定性：最近优先、容量封顶）
export interface Exemplar { id: string; capabilityKey: string; content: Record<string, unknown>; createdAt: string }

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ExemplarPool {
  private readonly entries: Exemplar[] = [];

  constructor(private readonly capacity = 100) {}

  add(exemplar: Exemplar): { ok: true } | { ok: false; error: { code: 'EXEMPLAR_INVALID'; message: string } } {
    if (!SAFE_KEY.test(exemplar.capabilityKey) || !exemplar.id || !exemplar.createdAt) {
      return { ok: false, error: { code: 'EXEMPLAR_INVALID', message: 'exemplar fields invalid' } };
    }
    this.entries.push({ ...exemplar });
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return { ok: true };
  }

  /** 最近优先（后进先回）——few-shot 池随使用量演进（蓝图：越用越强） */
  recall(capabilityKey: string, limit = 5): Exemplar[] {
    return this.entries
      .filter(item => item.capabilityKey === capabilityKey)
      .slice(-limit)
      .reverse();
  }

  snapshot(): Exemplar[] { return [...this.entries]; }
}
