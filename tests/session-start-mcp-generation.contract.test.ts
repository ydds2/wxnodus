// tests/session-start-mcp-generation.contract.test.ts — 目标导出物验证：
// SessionStart 显式生成（身份/locale/模型/钩子/能力 + sha256 绑定 + 原子持久化）
// MCP server 显式生成（工具签名 → 可运行 stdio 源码 + 绑定 manifest，确定性字节输出）
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStartGenerator, persistSessionStart } from '../src/application/sessions/sessionStartGenerator.js';
import { validateSessionStart } from '../src/domain/sessions/sessionStart.js';
import { generateMcpServer } from '../src/application/mcp/mcpServerGenerator.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wxnodus-gen-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const generatorPorts = (locale: 'zh-CN' | 'en' = 'zh-CN') => ({
  locale: () => locale,
  model: () => 'glm-4v-flash',
  dataDir: () => join(root, 'data'),
  hooks: () => [{ id: 'hook-1', kind: 'on-session-start' as const, enabled: true }],
  capabilities: () => ['process.execute', 'filesystem.read'],
  now: () => '2026-08-13T00:00:00.000Z',
});

describe('SessionStart 显式生成', () => {
  it('generates a valid session start document with full sha256 binding', () => {
    const generated = new SessionStartGenerator(generatorPorts()).generate('sess-1');
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value).toMatchObject({
      schemaVersion: 1, sessionId: 'sess-1', locale: 'zh-CN', model: 'glm-4v-flash',
      hooks: [{ id: 'hook-1', kind: 'on-session-start', enabled: true }],
      capabilities: ['process.execute', 'filesystem.read'],
    });
    expect(validateSessionStart(generated.value)).toMatchObject({ ok: true });
  });

  it('binds locale into the document and detects drift', () => {
    const zh = new SessionStartGenerator(generatorPorts('zh-CN')).generate('sess-1');
    const en = new SessionStartGenerator(generatorPorts('en')).generate('sess-1');
    expect(zh.ok && en.ok).toBe(true);
    if (!zh.ok || !en.ok) return;
    expect(zh.value.locale).toBe('zh-CN');
    expect(en.value.locale).toBe('en');
    expect(zh.value.sha256).not.toBe(en.value.sha256);
    // W3 Session 第 1 步：validate 重算 canonical 哈希并比对——全零/漂移一律拒绝
    expect(validateSessionStart({ ...en.value, sha256: '0'.repeat(64) })).toMatchObject({
      ok: false, error: { code: 'SESSION_START_HASH_MISMATCH' },
    });
    expect(validateSessionStart({ ...en.value, model: 'drifted-model' })).toMatchObject({
      ok: false, error: { code: 'SESSION_START_HASH_MISMATCH' },
    });
    // 字段漂移 → 哈希漂移（同 sessionId 不同模型）
    const otherModel = new SessionStartGenerator({ ...generatorPorts('en'), model: () => 'deepseek-v4' }).generate('sess-1');
    expect(otherModel.ok && otherModel.value.sha256).not.toBe(en.value.sha256);
  });

  it('persists atomically and rejects invalid documents', async () => {
    const generated = new SessionStartGenerator(generatorPorts()).generate('sess-2');
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const file = join(root, 'sessions', 'sess-2', 'session-start.json');
    await expect(persistSessionStart(file, generated.value)).resolves.toMatchObject({ ok: true });
    expect(existsSync(file)).toBe(true);
    const readBack = JSON.parse(readFileSync(file, 'utf8'));
    expect(readBack.sha256).toBe(generated.value.sha256);
    // 读回重算：磁盘上的合法文档通过 readSessionStart
    const { readSessionStart } = await import('../src/application/sessions/sessionStartGenerator.js');
    const reread = await readSessionStart(file);
    expect(reread.ok && reread.value.sha256).toBe(generated.value.sha256);
    // 磁盘篡改（改字段不改哈希）→ 读回拒绝
    writeFileSync(file, JSON.stringify({ ...generated.value, model: 'tampered' }), 'utf8');
    const tampered = await readSessionStart(file);
    expect(tampered).toMatchObject({ ok: false, error: { code: 'SESSION_START_HASH_MISMATCH' } });
    // 半写/非 JSON → 拒绝
    writeFileSync(file, '{broken', 'utf8');
    const malformed = await readSessionStart(file);
    expect(malformed).toMatchObject({ ok: false, error: { code: 'SESSION_START_INVALID' } });
    await expect(persistSessionStart(file, { ...generated.value, locale: 'fr' } as never)).resolves.toMatchObject({
      ok: false, error: { code: 'SESSION_START_INVALID' },
    });
  });

  it('rejects structurally invalid session start documents', () => {
    expect(validateSessionStart(null)).toMatchObject({ ok: false, error: { code: 'SESSION_START_INVALID' } });
    expect(validateSessionStart({ schemaVersion: 1, sessionId: 'x', createdAt: 't', locale: 'fr', model: 'm', dataDir: 'd', hooks: [], capabilities: ['c'], sha256: 'a'.repeat(64) }))
      .toMatchObject({ ok: false, error: { code: 'SESSION_START_INVALID' } });
    expect(validateSessionStart({ schemaVersion: 1, sessionId: 'x', createdAt: 't', locale: 'en', model: 'm', dataDir: 'd', hooks: [], capabilities: [], sha256: 'a'.repeat(64) }))
      .toMatchObject({ ok: false, error: { code: 'SESSION_START_INVALID' } });
  });
});

describe('MCP server 显式生成', () => {
  const signatures = [
    { name: 'memory_search', description: 'Search long-term memory', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'calc_eval', description: 'Evaluate a deterministic expression', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  ];

  it('emits a runnable stdio server source with declared tools and a bound manifest', () => {
    const generated = generateMcpServer({ serverName: 'wxnodus-demo', tools: signatures });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.files.map(file => file.path)).toEqual(['server.ts', 'manifest.json']);
    const source = generated.value.files[0].content;
    expect(source).toContain('new McpServer');
    expect(source).toContain('StdioServerTransport');
    for (const tool of signatures) {
      expect(source).toContain(`registerTool('${tool.name}'`);
      expect(source).toContain(`'${tool.name}',`);
    }
    const manifest = JSON.parse(generated.value.files[1].content);
    expect(manifest).toMatchObject({ schemaVersion: 1, serverName: 'wxnodus-demo', protocolVersion: '2026-07-28', tools: ['memory_search', 'calc_eval'] });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.sha256).toBe(generated.value.manifest.sha256);
  });

  it('is byte-deterministic for the same inputs', () => {
    const first = generateMcpServer({ serverName: 'wxnodus-demo', tools: signatures });
    const second = generateMcpServer({ serverName: 'wxnodus-demo', tools: signatures });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.files).toEqual(second.value.files);
    expect(first.value.manifest.sha256).toBe(second.value.manifest.sha256);
  });

  it('rejects invalid names, empty tool sets, and malformed schemas with stable codes', () => {
    expect(generateMcpServer({ serverName: 'Bad Name!', tools: signatures })).toMatchObject({
      ok: false, error: { code: 'MCP_GENERATE_INVALID_NAME' },
    });
    expect(generateMcpServer({ serverName: 'ok', tools: [] })).toMatchObject({
      ok: false, error: { code: 'MCP_GENERATE_NO_TOOLS' },
    });
    expect(generateMcpServer({ serverName: 'ok', tools: [{ name: '9bad', description: 'x', inputSchema: {} }] })).toMatchObject({
      ok: false, error: { code: 'MCP_GENERATE_INVALID_TOOL' },
    });
    expect(generateMcpServer({ serverName: 'ok', tools: [{ name: 'ok_tool', description: '', inputSchema: {} }] })).toMatchObject({
      ok: false, error: { code: 'MCP_GENERATE_INVALID_TOOL' },
    });
    expect(generateMcpServer({ serverName: 'ok', tools: [{ name: 'ok_tool', description: 'x', inputSchema: 'not-schema' as never }] })).toMatchObject({
      ok: false, error: { code: 'MCP_GENERATE_INVALID_TOOL' },
    });
  });
});
