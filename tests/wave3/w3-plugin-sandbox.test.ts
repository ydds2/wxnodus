// tests/wave3/w3-plugin-sandbox.test.ts — W3 Plugin facade：生产 sandbox（crash-isolation 如实证据 + Untrusted 拒绝）
import { describe, expect, it } from 'vitest';
import { createProcessIsolationSandbox } from '../../src/infrastructure/plugins/processIsolationSandbox.js';
import { assertSandboxAvailable } from '../../src/infrastructure/plugins/pluginSandbox.js';

describe('production plugin sandbox', () => {
  it('probes truthfully: crash-isolation with OS-enforcement items false', async () => {
    const sandbox = createProcessIsolationSandbox();
    expect(sandbox.strength).toBe('crash-isolation');
    const probe = await sandbox.probe(new AbortController().signal);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.strength).toBe('crash-isolation');
    expect(probe.value.environmentCleared).toBe(true);
    expect(probe.value.inheritedHandlesBlocked).toBe(true);
    expect(probe.value.filesystemDenied).toBe(false);
    expect(probe.value.networkDenied).toBe(false);
  });

  it('quarantines untrusted plugins (no OS enforcement, no launch)', async () => {
    const sandbox = createProcessIsolationSandbox();
    const probe = await sandbox.probe(new AbortController().signal);
    if (!probe.ok) throw new Error('unreachable');
    const gate = assertSandboxAvailable('untrusted', probe.value);
    expect(gate).toMatchObject({ ok: false, error: { code: 'PLUGIN_SANDBOX_UNAVAILABLE' } });
  });

  it('allows trusted plugins through the crash-isolation gate', async () => {
    const sandbox = createProcessIsolationSandbox();
    const probe = await sandbox.probe(new AbortController().signal);
    if (!probe.ok) throw new Error('unreachable');
    const gate = assertSandboxAvailable('trusted', probe.value);
    expect(gate).toMatchObject({ ok: true });
  });

  it('starts a plugin as a real isolated child process and stops it atomically', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'wxnodus-plugin-'));
    try {
      const entry = join(dir, 'plugin.js');
      writeFileSync(entry, "setInterval(() => {}, 1000);\n", 'utf8');
      const sandbox = createProcessIsolationSandbox();
      const started = await sandbox.start({ id: 'p1', manifestPath: join(dir, 'plugin.json'), entrypointPath: entry, trustLevel: 'trusted' }, {} as never, new AbortController().signal);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value.processId).toContain('p1:');
      const stopped = await started.value.stop('test', new AbortController().signal);
      expect(stopped).toMatchObject({ ok: true, value: { stopped: true } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
