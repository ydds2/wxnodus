import { AssertionError } from 'node:assert';

export async function runKnownFailureCase(input: {
  failureId: string;
  expectedFailureCode: string;
  assertionMessage: string;
  run: () => Promise<void>;
}): Promise<void> {
  try {
    await input.run();
    process.stdout.write(`${JSON.stringify({
      failureId: input.failureId,
      outcome: 'unexpected-pass',
    })}\n`);
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof AssertionError && error.message.includes(input.assertionMessage)) {
      process.stderr.write(`${JSON.stringify({
        failureId: input.failureId,
        failureCode: input.expectedFailureCode,
        outcome: 'known-failure-observed',
      })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${JSON.stringify({
      failureId: input.failureId,
      failureCode: 'KNOWN_FAILURE_ORACLE_CRASHED',
      outcome: 'harness-error',
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 2;
  }
}
