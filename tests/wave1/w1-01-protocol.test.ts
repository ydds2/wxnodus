import { describe, expect, it } from 'vitest';
import { gatewayError } from '../../src/protocol/errors.js';
import { err, ok } from '../../src/protocol/results.js';
import { isRunFinalStatus } from '../../src/protocol/runs.js';
import { createGatewayEvent } from '../../src/protocol/events.js';

const baseEnvelope = {
  schemaVersion: 1 as const,
  producer: 'test.kernel',
  timestamp: '2026-08-13T00:00:00.000Z',
  locale: 'zh-CN',
  source: 'kernel' as const,
  capabilities: ['command', 'memory'] as const,
  policySnapshotId: 'policy-001',
  correlationId: 'corr-001',
  sensitivity: 'internal' as const,
  retention: 'session' as const,
};

describe('W1-01 stable result protocol', () => {
  it('branches on stable code even when localized message changes', () => {
    const zh = err(gatewayError('GATEWAY_METHOD_UNSUPPORTED', '不支持的方法', 'gateway.unsupported'));
    const en = err(gatewayError('GATEWAY_METHOD_UNSUPPORTED', 'Unsupported method', 'gateway.unsupported'));
    expect(zh.ok).toBe(false);
    expect(en.ok).toBe(false);
    if (!zh.ok && !en.ok) expect(zh.error.code).toBe(en.error.code);
  });

  it('does not treat OperationResult.ok as a RunFinalStatus', () => {
    const result = ok({ accepted: true });
    expect(result.ok).toBe(true);
    expect(isRunFinalStatus(String(result.ok))).toBe(false);
    expect(isRunFinalStatus('succeeded')).toBe(true);
  });
});

describe('W1-01 lifecycle envelope', () => {
  it('requires the same locale/source/capabilities/policy/correlation/timestamp envelope', () => {
    const event = createGatewayEvent({
      ...baseEnvelope,
      type: 'session.start',
      sessionId: 'session-001',
      payload: { restored: false },
    });
    expect(event.ok).toBe(true);
    if (event.ok) {
      expect(event.value).toMatchObject({
        locale: 'zh-CN',
        source: 'kernel',
        capabilities: ['command', 'memory'],
        policySnapshotId: 'policy-001',
        correlationId: 'corr-001',
        timestamp: '2026-08-13T00:00:00.000Z',
        sessionId: 'session-001',
      });
      expect(event.value).not.toHaveProperty('runId');
    }
  });

  it.each([
    ['session.start', {}, 'EVENT_LIFECYCLE_SESSION_REQUIRED'],
    ['run.start', { sessionId: 's1' }, 'EVENT_LIFECYCLE_RUN_REQUIRED'],
    ['turn.start', { sessionId: 's1', runId: 'r1' }, 'EVENT_LIFECYCLE_TURN_REQUIRED'],
  ] as const)('rejects invalid %s identity with a stable code', (type, ids, code) => {
    const result = createGatewayEvent({ ...baseEnvelope, ...ids, type, payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('requires audit retention and explicit redaction for secret events', () => {
    const missingRedaction = createGatewayEvent({
      ...baseEnvelope,
      type: 'secret.request',
      sessionId: 's1',
      sensitivity: 'secret',
      retention: 'audit',
      payload: { requestId: 'secret-1' },
    });
    expect(missingRedaction.ok).toBe(false);
    if (!missingRedaction.ok) expect(missingRedaction.error.code).toBe('EVENT_SECRET_REDACTION_REQUIRED');

    const wrongRetention = createGatewayEvent({
      ...baseEnvelope,
      type: 'secret.request',
      sessionId: 's1',
      sensitivity: 'secret',
      retention: 'session',
      redaction: { strategy: 'drop', fields: ['payload.value'] },
      payload: { requestId: 'secret-1' },
    });
    expect(wrongRetention.ok).toBe(false);
    if (!wrongRetention.ok) expect(wrongRetention.error.code).toBe('EVENT_SECRET_RETENTION_REQUIRED');
  });

  it('rejects a non-ISO timestamp', () => {
    const result = createGatewayEvent({
      ...baseEnvelope,
      type: 'session.start',
      sessionId: 's1',
      timestamp: '08/13/2026',
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EVENT_TIMESTAMP_INVALID');
  });
});
