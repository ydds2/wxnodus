// src/application/quality/reviewerKeyService.ts — Wave 3 Build 生产接线：reviewer 密钥持久化
// 红线合规：Ed25519 私钥经 AES-256-GCM（机器指纹绑定）加密落盘，明文绝不落盘；
// 首次启动生成并持久化（后续 review 验签跨进程可用）；密文篡改 fail-closed
// （REVIEWER_KEY_CORRUPT——不静默重生成，否则历史 attestation 全部失验）。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayError } from '../../protocol/errors.js';
import { err, ok, type OperationResult } from '../../protocol/results.js';

export interface ReviewerSignerPort {
  issuer: string;
  keyId: string;
  sign(hash: Uint8Array): Promise<Uint8Array>;
}

export interface ReviewerKeyBundle {
  issuer: string;
  keyId: string;
  signer: ReviewerSignerPort;
  trustPolicy: {
    resolve(issuer: string, keyId: string): {
      issuer: string;
      keyId: string;
      algorithm: 'Ed25519';
      publicKey: ReturnType<typeof createPublicKey>;
      reviewerActorIds: readonly string[];
      activeFrom: string;
      activeUntil: string;
      maxAgeMs: number;
      maxClockSkewMs: number;
    } | undefined;
  };
}

interface ReviewerKeyFile {
  schemaVersion: 1;
  issuer: string;
  keyId: string;
  encryptedPrivateKey: string;
  publicKeyPem: string;
  activeFrom: string;
  activeUntil: string;
}

export interface ReviewerKeyServiceInput {
  dataDir: string;
  encrypt(plain: string): string;
  decrypt(stored: string): string | null;
  clock?: () => string;
}

const KEY_FILE = 'reviewer-key.json';

export function createReviewerKeyService(input: ReviewerKeyServiceInput) {
  const clock = input.clock ?? (() => new Date().toISOString());
  const dir = join(input.dataDir, 'reviewer');
  const path = join(dir, KEY_FILE);

  const persist = (file: ReviewerKeyFile): OperationResult<void> => {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${path}.tmp-${Date.now().toString(36)}`;
      writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
      renameSync(tmp, path);
      return ok(undefined);
    } catch {
      return err(gatewayError('REVIEWER_KEY_PERSIST_FAILED', 'reviewer 密钥持久化失败', 'reviewer.key.persistFailed'));
    }
  };

  const load = (): OperationResult<ReviewerKeyFile | null> => {
    if (!existsSync(path)) return ok(null);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReviewerKeyFile;
      if (parsed.schemaVersion !== 1 || typeof parsed.encryptedPrivateKey !== 'string' || typeof parsed.publicKeyPem !== 'string') {
        return err(gatewayError('REVIEWER_KEY_CORRUPT', 'reviewer 密钥文件结构损坏', 'reviewer.key.corrupt'));
      }
      return ok(parsed);
    } catch {
      return err(gatewayError('REVIEWER_KEY_CORRUPT', 'reviewer 密钥文件不可读', 'reviewer.key.corrupt'));
    }
  };

  const bundleFrom = (file: ReviewerKeyFile, privateKey: ReturnType<typeof createPrivateKey>): OperationResult<ReviewerKeyBundle> => {
    const publicKey = createPublicKey(file.publicKeyPem);
    return ok({
      issuer: file.issuer,
      keyId: file.keyId,
      signer: {
        issuer: file.issuer,
        keyId: file.keyId,
        sign: async hash => sign(null, hash, privateKey),
      },
      trustPolicy: {
        resolve: (issuer, keyId) => issuer === file.issuer && keyId === file.keyId ? {
          issuer,
          keyId,
          algorithm: 'Ed25519' as const,
          publicKey,
          reviewerActorIds: ['reviewer'],
          activeFrom: file.activeFrom,
          activeUntil: file.activeUntil,
          maxAgeMs: 86_400_000,
          maxClockSkewMs: 5_000,
        } : undefined,
      },
    });
  };

  return {
    async loadOrCreate(): Promise<OperationResult<ReviewerKeyBundle>> {
      const loaded = load();
      if (!loaded.ok) return loaded;
      if (loaded.value) {
        const privatePem = input.decrypt(loaded.value.encryptedPrivateKey);
        if (!privatePem) {
          // 密文解密失败（机器指纹变化/篡改）：fail-closed，绝不静默重生成
          return err(gatewayError('REVIEWER_KEY_CORRUPT', 'reviewer 密钥解密失败（机器指纹或密文变更）', 'reviewer.key.corrupt'));
        }
        try {
          return bundleFrom(loaded.value, createPrivateKey(privatePem));
        } catch {
          return err(gatewayError('REVIEWER_KEY_CORRUPT', 'reviewer 私钥解析失败', 'reviewer.key.corrupt'));
        }
      }
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
      const file: ReviewerKeyFile = {
        schemaVersion: 1,
        issuer: 'review-service',
        keyId,
        encryptedPrivateKey: input.encrypt(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString('utf8')),
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString('utf8'),
        activeFrom: clock(),
        activeUntil: new Date(new Date(clock()).getTime() + 10 * 365 * 86_400_000).toISOString(),
      };
      const persisted = persist(file);
      if (!persisted.ok) return persisted;
      return bundleFrom(file, privateKey);
    },
    keyFilePath: path,
  };
}
