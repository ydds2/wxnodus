// tests/wave3/w3-reviewer-key-service.test.ts — reviewer 密钥持久化（红线：明文绝不落盘）
import { mkdtemp, readFileSync, rm, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createReviewerKeyService } from '../../src/application/quality/reviewerKeyService.js';

const mkdtempAsync = promisify(mkdtemp);
const rmAsync = promisify(rm);

// 注入的对称加密（测试用可逆映射，验证「经注入加密通道」这一边界而非 AES 本身——
// AES-256-GCM 实现由 kernel/providers 的既有测试覆盖）
const fakeCipher = () => {
  const map = new Map<string, string>();
  return {
    encrypt: (plain: string) => {
      const token = `enc:${map.size + 1}`;
      map.set(token, plain);
      return token;
    },
    decrypt: (stored: string) => map.get(stored) ?? null,
    peek: () => [...map.values()].join('\n'),
  };
};

describe('reviewer key service', () => {
  it('generates a keypair on first run and persists it without plaintext private key', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-reviewer-'));
    try {
      const cipher = fakeCipher();
      const service = createReviewerKeyService({ dataDir: root, encrypt: cipher.encrypt, decrypt: cipher.decrypt });
      const bundle = await service.loadOrCreate();
      expect(bundle.ok).toBe(true);
      if (!bundle.ok) throw new Error(bundle.error.code);
      expect(bundle.value.signer.issuer).toBe('review-service');
      const onDisk = readFileSync(service.keyFilePath, 'utf8');
      expect(onDisk).not.toContain('PRIVATE KEY');
      expect(onDisk).toContain('"encryptedPrivateKey"');
    } finally {
      await rmAsync(root, { recursive: true, force: true });
    }
  });

  it('reuses the same key on subsequent runs (idempotent identity)', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-reviewer-'));
    try {
      const cipher = fakeCipher();
      const service = createReviewerKeyService({ dataDir: root, encrypt: cipher.encrypt, decrypt: cipher.decrypt });
      const first = await service.loadOrCreate();
      const second = await service.loadOrCreate();
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error('unreachable');
      expect(second.value.keyId).toBe(first.value.keyId);
    } finally {
      await rmAsync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on corrupted ciphertext instead of silently regenerating', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-reviewer-'));
    try {
      const cipher = fakeCipher();
      const service = createReviewerKeyService({ dataDir: root, encrypt: cipher.encrypt, decrypt: cipher.decrypt });
      const first = await service.loadOrCreate();
      expect(first.ok).toBe(true);
      // 模拟机器指纹变化：解密通道不可用
      const broken = createReviewerKeyService({ dataDir: root, encrypt: cipher.encrypt, decrypt: () => null });
      const result = await broken.loadOrCreate();
      expect(result).toMatchObject({ ok: false, error: { code: 'REVIEWER_KEY_CORRUPT' } });
    } finally {
      await rmAsync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a structurally corrupted key file', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-reviewer-'));
    try {
      const cipher = fakeCipher();
      const service = createReviewerKeyService({ dataDir: root, encrypt: cipher.encrypt, decrypt: cipher.decrypt });
      await service.loadOrCreate();
      writeFileSync(service.keyFilePath, '{"schemaVersion":99}', 'utf8');
      const result = await service.loadOrCreate();
      expect(result).toMatchObject({ ok: false, error: { code: 'REVIEWER_KEY_CORRUPT' } });
    } finally {
      await rmAsync(root, { recursive: true, force: true });
    }
  });

  it('exposes a trust policy that resolves only its own key id', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'wxnodus-reviewer-'));
    try {
      const cipher = fakeCipher();
      const service = createReviewerKeyService({ dataDir: root, encrypt: cipher.encrypt, decrypt: cipher.decrypt });
      const bundle = await service.loadOrCreate();
      if (!bundle.ok) throw new Error(bundle.error.code);
      expect(bundle.value.trustPolicy.resolve('review-service', bundle.value.keyId)).toBeDefined();
      expect(bundle.value.trustPolicy.resolve('other', bundle.value.keyId)).toBeUndefined();
    } finally {
      await rmAsync(root, { recursive: true, force: true });
    }
  });
});
