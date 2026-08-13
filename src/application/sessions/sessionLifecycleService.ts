// src/application/sessions/sessionLifecycleService.ts — 会话生命周期：durable revision + 精确 W1 envelope
import { createGatewayEvent } from '../../protocol/events.js';
import type { LifecycleBase, SessionLifecycleEvent, SessionLifecyclePayload } from '../../domain/sessions/sessionLifecycle.js';
import type { OperationResult } from '../../protocol/results.js';

interface Store { load(sessionId: string): Promise<number | undefined>; save(sessionId: string, revision: number): Promise<void> }

export class SessionLifecycleService {
  constructor(private readonly store: Store) {}
  private event(type: SessionLifecyclePayload['kind'], sessionId: string, revision: number, base: LifecycleBase,
    ids: { runId?: string; turnId?: string } = {}): OperationResult<SessionLifecycleEvent> {
    const lifecycleRevision = type === 'session.start' ? 1 : revision;
    return createGatewayEvent({ ...base, schemaVersion: 1, type, sessionId, ...ids,
      payload: { kind: type, lifecycleRevision } as SessionLifecyclePayload });
  }
  async session(sessionId: string, resume: boolean, base: LifecycleBase) {
    const prior = await this.store.load(sessionId); const revision = (prior ?? 0) + 1;
    await this.store.save(sessionId, revision);
    return this.event(prior === undefined && !resume ? 'session.start' : 'session.resume', sessionId, revision, base);
  }
  async run(sessionId: string, runId: string, base: LifecycleBase) {
    const revision = await this.store.load(sessionId) ?? 1; return this.event('run.start', sessionId, revision, base, { runId });
  }
  async turn(sessionId: string, runId: string, turnId: string, base: LifecycleBase) {
    const revision = await this.store.load(sessionId) ?? 1; return this.event('turn.start', sessionId, revision, base, { runId, turnId });
  }
}
