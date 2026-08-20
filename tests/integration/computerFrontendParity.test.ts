// tests/integration/computerFrontendParity.test.ts — W3-05 Step 1：四入口对高影响动作返回同一决策（计划原文）
import { expect, it, vi } from 'vitest';
import { createComputerFrontendHandler } from '../../src/application/computer/computerFrontendHandler.js';

it('keeps CLI, Wire, HTTP, and TUI decisions identical for high-impact actions', async () => {
  const execute = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', message: 'approval', messageKey: 'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED', retryable: false },
  }));
  const service = { execute };
  const request = { kind: 'publish', target: { type: 'site', id: 'prod' }, effect: { summary: 'publish release', parameters: { version: '4.0.0' } } };
  const results = (await Promise.all(['cli', 'wire', 'http', 'tui'].map(frontend =>
    createComputerFrontendHandler(frontend, service).handle(request, { sessionId: 's', runId: 'r', actorId: 'a' }, AbortSignal.timeout(100))))) as Array<{ ok: boolean; error?: { code: string } }>;
  expect(results.map(result => (result.ok ? 'ok' : result.error?.code))).toEqual([
    'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED',
    'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED',
    'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED',
    'COMPUTER_HIGH_IMPACT_APPROVAL_REQUIRED',
  ]);
  expect(execute).toHaveBeenCalledTimes(4);
});
