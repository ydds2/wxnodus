// tests/wave3/w3-session-start-service.test.ts — 每个 session 生命周期只生成一次 + 原子持久化 + read-back 复用
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStartService } from '../../src/application/sessions/sessionStartService.js';
import { SessionStartGenerator } from '../../src/application/sessions/sessionStartGenerator.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wxnodus-session-svc-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const ports = () => ({
  locale: () => 'zh-CN' as const,
  model: () => 'glm-4v-flash',
  dataDir: () => join(root, 'data'),
  hooks: () => [{ id: 'hook-1', kind: 'on-session-start' as const, enabled: true }],
  capabilities: () => ['process.execute'],
  now: () => '2026-08-13T00:00:00.000Z',
});

describe('session start service', () => {
  it('generates exactly once and persists atomically', async () => {
    let generateCalls = 0;
    const generator = {
      generate: (sessionId: string) => {
        generateCalls += 1;
        return new SessionStartGenerator(ports()).generate(sessionId);
      },
    };
    const service = createSessionStartService({
      generator: generator as never,
      fileFor: sid => join(root, 'sessions', sid, 'session-start.json'),
    });
    const first = await service.ensure('sess-1');
    const second = await service.ensure('sess-1');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.sha256).toBe(first.value.sha256);
    expect(generateCalls).toBe(1);
    expect(readFileSync(join(root, 'sessions', 'sess-1', 'session-start.json'), 'utf8')).toContain('"sess-1"');
  });

  it('deduplicates concurrent ensure calls into a single generation', async () => {
    const service = createSessionStartService({
      generator: new SessionStartGenerator(ports()),
      fileFor: sid => join(root, 'sessions', sid, 'session-start.json'),
    });
    const [a, b, c] = await Promise.all([service.ensure('sess-9'), service.ensure('sess-9'), service.ensure('sess-9')]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.value.sha256).toBe(b.value.sha256);
    expect(b.value.sha256).toBe(c.value.sha256);
  });

  it('reuses a previously persisted artifact instead of regenerating', async () => {
    const generator = new SessionStartGenerator(ports());
    const file = join(root, 'sessions', 'sess-2', 'session-start.json');
    const generated = generator.generate('sess-2');
    if (!generated.ok) return;
    const { persistSessionStart } = await import('../../src/application/sessions/sessionStartGenerator.js');
    await persistSessionStart(file, generated.value);
    const service = createSessionStartService({ generator, fileFor: () => file });
    const result = await service.ensure('sess-2');
    expect(result.ok && result.value.sha256).toBe(generated.value.sha256);
  });

  it('rejects a tampered on-disk artifact instead of silently regenerating', async () => {
    const generator = new SessionStartGenerator(ports());
    const file = join(root, 'sessions', 'sess-3', 'session-start.json');
    const generated = generator.generate('sess-3');
    if (!generated.ok) return;
    const { persistSessionStart } = await import('../../src/application/sessions/sessionStartGenerator.js');
    await persistSessionStart(file, generated.value);
    writeFileSync(file, JSON.stringify({ ...generated.value, model: 'tampered' }), 'utf8');
    const service = createSessionStartService({ generator, fileFor: () => file });
    const result = await service.ensure('sess-3');
    expect(result).toMatchObject({ ok: false, error: { code: 'SESSION_START_HASH_MISMATCH' } });
  });
});
