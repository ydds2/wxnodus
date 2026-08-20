import { describe, expect, it } from 'vitest';
import { isSharedAgentReentrantCommand } from '../src/application/runs/internalCommandGuard.js';

describe('wx_cmd shared Agent reentrancy guard', () => {
  it.each(['/goal finish', '/flow next', '/arena compare', '/self-evolve --report'])(
    'blocks %s inside an active Agent turn',
    input => {
      expect(isSharedAgentReentrantCommand(input)).toBe(true);
    },
  );

  it.each(['/status', '/delegate inspect', '/agent run reviewer task', '/review changes'])(
    'allows %s when it does not re-enter the shared Agent',
    input => {
      expect(isSharedAgentReentrantCommand(input)).toBe(false);
    },
  );
});
