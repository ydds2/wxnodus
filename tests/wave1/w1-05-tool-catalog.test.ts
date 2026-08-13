import { describe, expect, it } from 'vitest';
import { createEffectDescriptor } from '../../src/domain/effects/effectDescriptor.js';
import { createToolCatalog } from '../../src/domain/tools/toolCatalog.js';
import type { ToolDescriptor } from '../../src/domain/tools/toolDescriptor.js';
import { parseToolId } from '../../src/domain/tools/toolIds.js';

function descriptor(rawId: string, owner: string): ToolDescriptor {
  const id = parseToolId(rawId);
  if (!id.ok) throw new Error(id.error.code);
  return {
    id: id.value,
    owner,
    inputSchema: { type: 'object', additionalProperties: false },
    effects: [createEffectDescriptor({
      kind: 'filesystem.read', resource: 'workspace://**/*', operation: 'read',
      external: false, dataClassification: 'internal', reversibility: 'reversible',
    })],
    timeoutMs: 5_000,
    cancellation: 'supported',
    idempotency: 'idempotent',
    evidenceProducer: true,
  };
}

describe('W1-05 ToolId', () => {
  it.each(['builtin:read', 'mcp:read', 'plugin:read', 'skill:read', 'forge:read', 'agent:read'])('accepts namespace %s', raw => {
    expect(parseToolId(raw).ok).toBe(true);
  });

  it.each([
    ['read', 'TOOL_ID_INVALID'],
    ['unknown:read', 'TOOL_NAMESPACE_UNSUPPORTED'],
    ['mcp:', 'TOOL_ID_INVALID'],
    ['mcp:../read', 'TOOL_ID_INVALID'],
    ['mcp:Read', 'TOOL_ID_INVALID'],
  ] as const)('rejects %s with %s', (raw, code) => {
    const result = parseToolId(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe('W1-05 ToolCatalog', () => {
  it('allows same local name across MCP and Plugin and rejects ambiguous bare lookup', () => {
    const catalog = createToolCatalog();
    expect(catalog.register('mcp:filesystem', [descriptor('mcp:read', 'mcp:filesystem')]).ok).toBe(true);
    expect(catalog.register('plugin:workspace', [descriptor('plugin:read', 'plugin:workspace')]).ok).toBe(true);
    expect(catalog.resolve('mcp:read').ok).toBe(true);
    expect(catalog.resolve('plugin:read').ok).toBe(true);
    const bare = catalog.resolve('read');
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe('TOOL_ID_AMBIGUOUS');
  });

  it('keeps unique bare-name compatibility and owner-scoped disposal', () => {
    const catalog = createToolCatalog();
    const mcp = catalog.register('mcp:filesystem', [descriptor('mcp:read', 'mcp:filesystem')]);
    const plugin = catalog.register('plugin:writer', [descriptor('plugin:write', 'plugin:writer')]);
    expect(mcp.ok && plugin.ok).toBe(true);
    expect(catalog.resolve('read').ok).toBe(true);
    if (!mcp.ok) return;
    mcp.value.dispose();
    expect(catalog.resolve('mcp:read').ok).toBe(false);
    expect(catalog.resolve('plugin:write').ok).toBe(true);
  });

  it('rejects duplicate ids and owner spoofing with stable codes', () => {
    const catalog = createToolCatalog();
    expect(catalog.register('mcp:a', [descriptor('mcp:read', 'mcp:a')]).ok).toBe(true);
    const duplicate = catalog.register('mcp:b', [descriptor('mcp:read', 'mcp:b')]);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('TOOL_ALREADY_REGISTERED');
    const spoofed = catalog.register('plugin:a', [descriptor('plugin:write', 'plugin:b')]);
    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) expect(spoofed.error.code).toBe('TOOL_OWNER_MISMATCH');
  });

  it.each([
    [{ effects: [] }, 'effects'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ cancellation: undefined }, 'cancellation'],
  ] as const)('rejects an external descriptor missing %s', (patch, field) => {
    const catalog = createToolCatalog();
    const invalid = { ...descriptor('mcp:external', 'mcp:a'), ...patch } as unknown as ToolDescriptor;
    const result = catalog.register('mcp:a', [invalid]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TOOL_DESCRIPTOR_INCOMPLETE');
      expect(result.error.details).toMatchObject({ field });
    }
  });

  it('returns an immutable per-turn snapshot', () => {
    const catalog = createToolCatalog();
    catalog.register('builtin:core', [descriptor('builtin:read', 'builtin:core')]);
    const snapshot = catalog.snapshot();
    catalog.register('plugin:later', [descriptor('plugin:write', 'plugin:later')]);
    expect(snapshot.map(tool => tool.id)).toEqual(['builtin:read']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });
});
