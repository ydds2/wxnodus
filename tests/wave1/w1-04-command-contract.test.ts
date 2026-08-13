import { describe, expect, it, vi } from 'vitest';
import { createCommandService } from '../../src/application/commandService.js';
import { parseCommand } from '../../src/application/commandGrammar.js';
import { createCommandRegistry } from '../../src/application/commandRegistry.js';
import { validateSafeName } from '../../src/domain/safeNames.js';
import { ok } from '../../src/protocol/results.js';

const context = {
  actorId: 'user-1', sessionId: 'session-1', runId: null,
  correlationId: 'corr-1', policySnapshotId: 'policy-1',
  locale: 'zh-CN', source: 'cli' as const,
  capabilities: ['command'] as const,
  timestamp: '2026-08-13T00:00:00.000Z',
};

describe('W1-04 command grammar', () => {
  it('parses quotes, escaped quotes/backslashes, JSON with spaces, flags, and -- terminator', () => {
    const result = parseCommand(String.raw`/deploy "C:\Program Files\wx" '{"name": "wx nodus", "quote": "a\"b"}' --mode=release --target "local host" -- --literal`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      name: '/deploy',
      args: ['C:\\Program Files\\wx', '{"name": "wx nodus", "quote": "a\\"b"}', '--literal'],
      flags: { mode: 'release', target: 'local host' },
      raw: String.raw`/deploy "C:\Program Files\wx" '{"name": "wx nodus", "quote": "a\"b"}' --mode=release --target "local host" -- --literal`,
    });
  });

  it('treats --flag=value and --flag value identically', () => {
    const inline = parseCommand('/build app --mode=release');
    const separate = parseCommand('/build app --mode release');
    expect(inline.ok && inline.value.flags).toEqual(separate.ok && separate.value.flags);
  });

  it('returns a stable code for unterminated quotes', () => {
    const result = parseCommand('/build "unfinished');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMMAND_PARSE_UNTERMINATED_QUOTE');
  });
});

describe('W1-04 registry and entrypoint contract', () => {
  it('distinguishes unknown, missing, excess, unknown-flag, and missing-flag-value codes', async () => {
    const registry = createCommandRegistry();
    registry.register({
      name: '/deploy', owner: 'core', minArgs: 1, maxArgs: 1,
      flags: { mode: { type: 'string', required: true }, force: { type: 'boolean' } },
    }, async input => ok({ output: `${input.args[0]}:${input.flags.mode}` }));

    const cases = [
      ['/ghost', 'COMMAND_UNKNOWN'],
      ['/deploy --mode release', 'COMMAND_ARGUMENT_MISSING'],
      ['/deploy app extra --mode release', 'COMMAND_ARGUMENT_EXCESS'],
      ['/deploy app --bogus x --mode release', 'COMMAND_FLAG_UNKNOWN'],
      ['/deploy app --mode', 'COMMAND_FLAG_VALUE_MISSING'],
    ] as const;
    for (const [raw, code] of cases) {
      const parsed = parseCommand(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const result = await registry.execute(parsed.value, context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
  });

  it('never downgrades an unknown slash command into chat', async () => {
    const chatFallback = vi.fn();
    const service = createCommandService(createCommandRegistry(), chatFallback);
    const result = await service.execute({ raw: '/definitely-unknown', sessionId: 'session-1' }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('COMMAND_UNKNOWN');
    expect(chatFallback).not.toHaveBeenCalled();
  });

  it('disposes only the registration captured by its owner and supports owner cleanup', () => {
    const registry = createCommandRegistry();
    const a = registry.register({ name: '/a', owner: 'plugin:a', minArgs: 0, flags: {} }, async () => ok({ output: 'a' }));
    const b = registry.register({ name: '/b', owner: 'plugin:b', minArgs: 0, flags: {} }, async () => ok({ output: 'b' }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    a.value.dispose();
    expect(registry.list().map(x => x.name)).toEqual(['/b']);
    expect(registry.unregisterOwner('plugin:a')).toBe(0);
    expect(registry.unregisterOwner('plugin:b')).toBe(1);
    expect(registry.list()).toEqual([]);
  });
});

describe('W1-04 safe names', () => {
  it.each([
    ['..', 'SAFE_NAME_TRAVERSAL'],
    ['C:\\temp', 'SAFE_NAME_ABSOLUTE_PATH'],
    ['\\\\server\\share', 'SAFE_NAME_ABSOLUTE_PATH'],
    ['a/b', 'SAFE_NAME_SEPARATOR'],
    ['a\\b', 'SAFE_NAME_SEPARATOR'],
    ['bad\u0000name', 'SAFE_NAME_CONTROL_CHAR'],
    ['trailing.', 'SAFE_NAME_TRAILING_DOT_SPACE'],
    ['trailing ', 'SAFE_NAME_TRAILING_DOT_SPACE'],
    ['CON', 'SAFE_NAME_WINDOWS_RESERVED'],
    ['nul.txt', 'SAFE_NAME_WINDOWS_RESERVED'],
  ] as const)('rejects %s with %s', (name, code) => {
    const result = validateSafeName(name, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('detects case and NFKC collisions after normalization', () => {
    const caseCollision = validateSafeName('Plugin', ['plugin']);
    expect(caseCollision.ok).toBe(false);
    if (!caseCollision.ok) expect(caseCollision.error.code).toBe('SAFE_NAME_COLLISION');
    const unicodeCollision = validateSafeName('Ａgent', ['Agent']);
    expect(unicodeCollision.ok).toBe(false);
    if (!unicodeCollision.ok) expect(unicodeCollision.error.code).toBe('SAFE_NAME_COLLISION');
  });
});
