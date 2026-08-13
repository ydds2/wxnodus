// tests/unit/computer/postcondition.test.ts — W3-05：driver 收据未经验证的效果不得成功
import { describe, expect, it } from 'vitest';
import { evaluatePostcondition } from '../../../src/domain/computer/postcondition.js';

describe('postcondition evaluation', () => {
  const verification = { verifierId: 'database.query', description: 'ledger contains one settled payment' };

  it('accepts a passed verification and carries the observed value', () => {
    expect(evaluatePostcondition(verification, { status: 'passed', observed: { rows: 1 } })).toMatchObject({
      ok: true,
      value: { verifierId: 'database.query', observed: { rows: 1 } },
    });
  });

  it('fails closed with COMPUTER_POSTCONDITION_FAILED when verification did not pass', () => {
    expect(evaluatePostcondition(verification, { status: 'failed', observed: { rows: 0 } })).toMatchObject({
      ok: false,
      error: { code: 'COMPUTER_POSTCONDITION_FAILED', details: { verifierId: 'database.query' } },
    });
  });
});
