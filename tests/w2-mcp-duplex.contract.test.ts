import { describe, expect, it, vi } from 'vitest';
import { MCP_PROTOCOL_VERSION, buildMcpMeta, mcpUnavailable } from '../src/domain/mcp/mcpProtocol.js';
import { McpTransportPolicy } from '../src/infrastructure/mcp/mcpTransportPolicy.js';
import { InMemoryMcpTranscriptStore } from '../src/infrastructure/mcp/mcpTranscriptStore.js';
import { createRegisteredServer, WxNodusMcpAdapter, WXNODUS_MCP_SURFACES } from '../src/infrastructure/mcp/wxnodusMcpServer.js';

const context = { actorId: 'actor:host', sessionId: 's1', runId: 'r1', correlationId: 'c1',
  policySnapshotId: 'p1', locale: 'en', source: 'kernel', capabilities: ['session'],
  timestamp: '2026-08-13T00:00:00.000Z' } as const;

const modernClientCapabilities = { tools: {}, resources: {}, prompts: {}, elicitation: { form: {} } };

// server factory 需要 ≥256-bit requestState 密钥（生产由环境注入；测试注入固定值）
process.env.WXNODUS_MCP_REQUEST_STATE_KEY = Buffer.alloc(32, 1).toString('base64');

describe('W2-06 current duplex MCP', () => {
  it('builds required per-request metadata and does not advertise disabled Tasks Preview', () => {
    expect(buildMcpMeta({ name: 'wxnodus', version: '4.0.0' }, modernClientCapabilities)).toEqual({
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'wxnodus', version: '4.0.0' },
      'io.modelcontextprotocol/clientCapabilities': modernClientCapabilities,
    });
    expect(WXNODUS_MCP_SURFACES.map(x => x.id)).toEqual([
      'session','memory','build','verify','evidence','browser','computer','forge',
    ]);
    // A-S3（2026-08-28）：build/verify/evidence 交付（DELIVERED）；browser/computer/forge 维持未交付
    for (const id of ['build','verify','evidence'] as const) {
      expect(WXNODUS_MCP_SURFACES.find(x => x.id === id)).toMatchObject({ delivered: true, stableStatus: 'DELIVERED' });
    }
    for (const id of ['browser','computer','forge'] as const) {
      expect(WXNODUS_MCP_SURFACES.find(x => x.id === id)).toMatchObject({ delivered: false,
        stableStatus: 'NOT_DELIVERED', reasonCode: 'NOT_DELIVERED' });
    }
    expect(WxNodusMcpAdapter.releaseContract).toEqual({ tasks: 'disabled', gaDependencies: [] });
  });

  it('validates the SDK discovery DTO and registers real modern surfaces', async () => {
    const { specTypeSchemas } = await import('@modelcontextprotocol/server');
    const server = createRegisteredServer({ tasksPreview: false, capabilities: {} as never, pipeline: {} as never,
      transcript: {} as never, contextFactory: () => context as never });
    const discovery = {
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true }, subscriptions: {}, elicitation: { form: {} } },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'wxnodus', version: '4.0.0' } },
    };
    expect(specTypeSchemas.DiscoverResult['~standard'].validate(discovery).issues).toBeUndefined();
    expect(discovery).not.toHaveProperty('protocolVersions');
    expect(server.registrations).toEqual(['server/discover', 'tools', 'resources', 'prompts', 'subscriptions/listen', 'elicitation/form']);
    // SDK DiscoverResult schema 只保留其认识的 capability 键（tools/resources/prompts）——按 SDK round-trip 断言
    expect(server.discovery()).toMatchObject({ supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: {
      tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true },
    } });
    expect(server.discovery()).not.toHaveProperty('protocolVersions');
  });

  it('discovers, pipelines delivered calls, denies context override, and returns stable unavailable', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, value: { id: 'receipt-1' }, evidenceIds: ['ev-1'] }));
    const transcript = new InMemoryMcpTranscriptStore(() => '2026-08-13T00:00:00.000Z');
    const adapter = new WxNodusMcpAdapter({
      capabilities: { snapshot: () => ({ id: 'caps-1' }), require: (id: string) => ['build','verify','evidence','browser','computer','forge'].includes(id)
        ? ({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } }) : ({ ok: true, value: { id, snapshotId: 'caps-1' } }) } as never,
      pipeline: { execute } as never, transcript, contextFactory: () => context as never,
    });
    expect(adapter.discovery()).toMatchObject({ supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: {
      tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true },
    } });
    expect(adapter.discovery()).not.toHaveProperty('protocolVersions');
    expect(await adapter.call('session', {}, buildMcpMeta({ name: 'test', version: '1' }, modernClientCapabilities), context,
      new AbortController().signal)).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(await adapter.call('computer', {}, buildMcpMeta({ name: 'test', version: '1' }, modernClientCapabilities), context,
      new AbortController().signal)).toEqual(mcpUnavailable('computer', 'tools', 'stdio', 'NOT_DELIVERED'));
    expect(await adapter.call('session', { _meta: { sessionId: 'attacker' } },
      buildMcpMeta({ name: 'test', version: '1' }, modernClientCapabilities), context, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'MCP_CONTEXT_OVERRIDE_FORBIDDEN' } });
    expect(transcript.records().map(x => x.status)).toEqual(['ok','denied','denied']);
  });

  it('blocks initial, redirected, and DNS-resolved private HTTP targets', async () => {
    const policy = new McpTransportPolicy({ resolve: vi.fn(async host => host === 'public.example'
      ? ['203.0.113.8'] : ['127.0.0.1']) });
    await expect(policy.assertHttpTarget(new URL('http://127.0.0.1/mcp'))).rejects.toMatchObject({ code: 'MCP_SSRF_BLOCKED' });
    await expect(policy.assertRedirect(new URL('https://public.example/mcp'), new URL('http://localhost/mcp')))
      .rejects.toMatchObject({ code: 'MCP_SSRF_BLOCKED' });
    await expect(policy.assertHttpTarget(new URL('https://internal.example/mcp'))).rejects.toMatchObject({ code: 'MCP_SSRF_BLOCKED' });
  });

  it('records cancellation and does not convert it to success', async () => {
    const transcript = new InMemoryMcpTranscriptStore(() => '2026-08-13T00:00:00.000Z');
    const controller = new AbortController(); controller.abort('test');
    const adapter = new WxNodusMcpAdapter({ capabilities: { require: () => ({ ok: true }), snapshot: () => ({ id: 'c' }) } as never,
      pipeline: { execute: vi.fn() } as never, transcript, contextFactory: () => context as never });
    expect(await adapter.call('browser', { token: 'secret' }, buildMcpMeta({ name: 'test', version: '1' }, modernClientCapabilities),
      context, controller.signal)).toEqual(mcpUnavailable('browser', 'tools', 'stdio', 'CANCELLED'));
    expect(transcript.records()[0]).toMatchObject({ status: 'cancelled', redactedPayload: { token: '[REDACTED]' } });
  });
});
