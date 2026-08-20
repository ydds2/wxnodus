// tests/unit/computer/highImpactApproval.test.ts — W3-05 Step 1：高影响授权作用域契约（计划原文）
import { describe, expect, it } from 'vitest';
import {
  createHighImpactApprovalRequest,
  validateHighImpactGrant,
  type HighImpactAction,
} from '../../../src/domain/computer/highImpactApproval.js';

const action = (amount: number): HighImpactAction => ({
  kind: 'payment',
  target: { type: 'account', id: 'vendor-7', display: 'Vendor Seven' },
  effect: { summary: 'Pay invoice INV-9', parameters: { amount, currency: 'USD', invoiceId: 'INV-9' } },
  reversibility: { reversible: false, method: null, deadline: null },
  verification: { verifierId: 'database.query', description: 'ledger contains one settled payment' },
});

describe('high-impact approval scope', () => {
  it('contains target, effect, reversibility, verification, and stable rule ID', () => {
    expect(createHighImpactApprovalRequest(action(125), { actorId: 'a1', sessionId: 's1', runId: 'r1' })).toMatchObject({
      ruleId: 'computer.high-impact.payment.v1',
      actionKind: 'payment',
      target: { id: 'vendor-7' },
      reversibility: { reversible: false },
      verification: { verifierId: 'database.query' },
    });
  });

  it('invalidates the grant when any parameter changes', () => {
    const approved = createHighImpactApprovalRequest(action(125), { actorId: 'a1', sessionId: 's1', runId: 'r1' });
    const grant = {
      id: 'grant-1', actorId: 'a1', sessionId: 's1', runId: 'r1',
      requestHash: approved.requestHash, status: 'issued' as const,
    };
    expect(validateHighImpactGrant(grant, approved)).toMatchObject({ ok: true });
    const changed = createHighImpactApprovalRequest(action(126), { actorId: 'a1', sessionId: 's1', runId: 'r1' });
    expect(validateHighImpactGrant(grant, changed)).toMatchObject({
      ok: false,
      error: { code: 'APPROVAL_GRANT_SCOPE_MISMATCH' },
    });
  });
});
