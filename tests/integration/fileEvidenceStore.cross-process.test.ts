// tests/integration/fileEvidenceStore.cross-process.test.ts — W0-01：跨进程 evidence 写入安全
// 两个独立进程并发 appendClosed 同一 run：两份成功都必须保留在最终 manifest，无 .lock/.tmp/.bak 残留。
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FileEvidenceStore } from '../../src/infrastructure/quality/fileEvidenceStore.js';

const testsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(testsRoot, '..');
const tsxCli = resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const writerPath = resolve(testsRoot, 'fixtures/file-evidence-store-writer.ts');

function spawnWriter(root: string, runId: string, recordId: string): Promise<{ code: number; output: string }> {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, [tsxCli, writerPath, root, runId, recordId], { cwd: projectRoot });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('close', code => resolveResult({ code: code ?? 1, output }));
  });
}

describe('cross-process evidence writes', () => {
  it('preserves both records under concurrent process writes and leaves no lock artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-cross-process-'));
    const runId = 'run-cross-process';
    try {
      const [first, second] = await Promise.all([
        spawnWriter(root, runId, 'a'),
        spawnWriter(root, runId, 'b'),
      ]);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(JSON.parse(first.output)).toMatchObject({ ok: true, id: 'record-a' });
      expect(JSON.parse(second.output)).toMatchObject({ ok: true, id: 'record-b' });

      const store = new FileEvidenceStore(root);
      const integrity = await store.verifyIntegrity(runId);
      expect(integrity.ok).toBe(true);
      if (!integrity.ok) throw new Error(integrity.error.code);
      const recordIds = integrity.value.entries.filter(entry => entry.path.startsWith('records/'))
        .map(entry => entry.path.slice('records/'.length, -'.json'.length)).sort();
      expect(recordIds).toEqual(['record-a', 'record-b']);

      // Q6 加固（2026-09-04 CI 实测竞态）：子进程退出后锁清理可能仍在一个 readdir 窗口内——
      // 轮询至清理完成（≤5s）再断言；超时残留即真失败（fail-closed）
      let leftovers: string[] = [];
      for (let i = 0; i < 50; i++) {
        leftovers = (await readdir(root)).filter(name =>
          name.includes('.lock') || name.endsWith('.tmp') || name.endsWith('.bak'));
        if (!leftovers.length) break;
        await new Promise(r => setTimeout(r, 100));
      }
      expect(leftovers).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed on a pre-existing writer lock without mutating the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wxnodus-cross-locked-'));
    const runId = 'run-locked';
    try {
      await writeFile(join(root, '.evidence-write.lock'), JSON.stringify({ pid: 999999, token: 'stale' }));
      const writer = await spawnWriter(root, runId, 'locked');

      expect(writer.code).toBe(1);
      expect(JSON.parse(writer.output)).toMatchObject({ ok: false, code: 'EVIDENCE_WRITE_LOCKED' });

      const store = new FileEvidenceStore(root);
      expect(await store.verifyIntegrity(runId)).toMatchObject({ ok: false });
      const entries = await readdir(root);
      expect(entries.filter(name => name === runId || name.includes('.tmp') || name.includes('.bak'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
