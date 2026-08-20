// src/infrastructure/quality/fileReviewNonceStore.ts — durable nonce 消耗（create-if-absent），replay fail closed
import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewNonceStore } from '../../domain/quality/review.js';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export class FileReviewNonceStore implements ReviewNonceStore {
  constructor(private readonly root: string) {}
  async consume(input: { issuer: string; keyId: string; nonce: string; reviewInputHash: string; expiresAt: string }): Promise<OperationResult<void>> {
    const key = createHash('sha256').update(`${input.issuer}\0${input.keyId}\0${input.nonce}`).digest('hex');
    try {
      await mkdir(this.root, { recursive: true }); const handle = await open(join(this.root, `${key}.used`), 'wx');
      try { await handle.writeFile(JSON.stringify(input)); await handle.sync(); } finally { await handle.close(); }
      return ok(undefined);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? err(gatewayError('REVIEW_ATTESTATION_REPLAYED', 'Review nonce already consumed', 'review.attestation.replayed'))
        : err(gatewayError('REVIEW_ATTESTATION_INVALID', 'Review nonce store unavailable', 'review.nonce.unavailable'));
    }
  }
}
