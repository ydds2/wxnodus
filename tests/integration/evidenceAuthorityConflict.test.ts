// tests/integration/evidenceAuthorityConflict.test.ts — W3-01 Step 4：篡改检测（绝不信任自报 pass）
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';

describe('evidence authority', () => {
  it('detects any record or attachment byte change and never trusts self-reported pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-evidence-'));
    const store = new FileEvidenceStore(root);
    const appended = await store.appendBundle({
      runId: 'run-tamper',
      records: [],
      attachments: { 'authoritative-stdout.log': Buffer.from('authoritative stdout') },
    });
    expect(appended.ok).toBe(true);
    const manifestPath = join(root, 'run-tamper', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      entries: Array<{ path: string }>;
    };
    const attachment = manifest.entries.find(entry => entry.path.startsWith('attachments/'))!;
    await writeFile(join(root, 'run-tamper', attachment.path), 'tampered');

    await expect(store.verifyIntegrity('run-tamper')).resolves.toMatchObject({
      ok: false,
      error: { code: 'EVIDENCE_INTEGRITY_FAILED' },
    });
  });
});
