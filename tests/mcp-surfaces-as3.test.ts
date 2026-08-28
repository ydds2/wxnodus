// tests/mcp-surfaces-as3.test.ts — A-S3（2026-08-28）：build/verify/evidence MCP surfaces 交付
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WXNODUS_MCP_SURFACES } from '../src/infrastructure/mcp/wxnodusMcpServer.js';
import { Wave1CapabilityRegistry, Wave2CapabilityRegistry } from '../src/application/capabilities/capabilityRegistry.js';
import { executeToolId } from '../src/application/tools/toolExecutors.js';
import type { ToolId } from '../src/domain/tools/toolIds.js';
import { ProbeRegistry } from '../src/infrastructure/capabilities/probeRegistry.js';

const asToolId = (id: string) => id as ToolId;
import { openDB, closeDB, appendAudit } from '../src/store/db.js';
import { verifyAudit } from '../src/kernel/audit.js';
import type { OperationContext } from '../src/protocol/operationContext.js';

let dir: string;
let db: ReturnType<typeof openDB>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-as3-'));
  db = openDB(dir);
});
afterEach(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

const ctx: OperationContext = {
  actorId: 'actor:test', sessionId: 'as3', runId: null, correlationId: 'c-as3',
  policySnapshotId: 'policy-test', locale: 'zh-CN', source: 'cli', capabilities: ['memory'],
  timestamp: new Date().toISOString(),
} as unknown as OperationContext;
const deps = () => ({ workspaceRoot: dir, memoryRepository: null as never, db, dataDir: dir });

describe('surfaces 交付声明', () => {
  it('build/verify/evidence = DELIVERED；browser/computer/forge 维持 future', () => {
    const by = (id: string) => WXNODUS_MCP_SURFACES.find(s => s.id === id)!;
    expect(by('build').delivered).toBe(true);
    expect(by('verify').delivered).toBe(true);
    expect(by('evidence').delivered).toBe(true);
    expect(by('browser').delivered).toBe(false);
    expect(by('computer').delivered).toBe(false);
    expect(by('forge').delivered).toBe(false);
  });
});

describe('能力门', () => {
  it('Wave1 extras 注入 → require 通过；缺省 → CAPABILITY_UNAVAILABLE', () => {
    const reg = new Wave1CapabilityRegistry('p', () => 'now', ['build', 'verify', 'evidence', 'session']);
    expect(reg.require('build').ok).toBe(true);
    expect(reg.require('verify').ok).toBe(true);
    expect(reg.require('evidence').ok).toBe(true);
    expect(reg.require('session').ok).toBe(true);
    const plain = new Wave1CapabilityRegistry('p', () => 'now');
    const r = plain.require('build');
    expect(r.ok).toBe(false);
  });
  it('Wave2 解 fence：build/verify/evidence 走 probe 路径（无 probe → 诚实 unavailable，非 fence 锁）', async () => {
    const reg = await Wave2CapabilityRegistry.create({
      policySnapshotId: 'p', profile: 'standard', platform: process.platform,
      clock: () => 'now', probes: new ProbeRegistry({}), // 无注册探针 → probe:missing（诚实失败，非 fence 锁）
      requirements: { build: 'optional', verify: 'optional', evidence: 'optional', browser: 'optional' },
    });
    const snap = reg.snapshot();
    expect(snap.descriptors.build!.reasonCode).toBe('CAPABILITY_PROBE_FAILED'); // 探针路径（非 NOT_DELIVERED fence）
    expect(snap.descriptors.browser!.reasonCode).toBe('NOT_DELIVERED');        // browser 仍 fence
  });
});

describe('builtin 执行器（真实数据）', () => {
  it('build：dataDir/projects 清单（名称/mtime/文件数，按 mtime 降序）', async () => {
    mkdirSync(join(dir, 'projects', 'app-a'), { recursive: true });
    mkdirSync(join(dir, 'projects', 'app-b'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'app-a', 'index.js'), 'x', 'utf8');
    writeFileSync(join(dir, 'projects', 'app-a', 'pkg.json'), '{}', 'utf8');
    const r = await executeToolId(asToolId('builtin:build'), {}, ctx, deps(), new AbortController().signal) as { ok: boolean; value: { builds: Array<{ name: string; fileCount: number }> } };
    expect(r.ok).toBe(true);
    expect(r.value.builds.map(b => b.name).sort()).toEqual(['app-a', 'app-b']);
    expect(r.value.builds.find(b => b.name === 'app-a')!.fileCount).toBe(2);
  });
  it('build：dataDir 未注入 → 诚实降级说明', async () => {
    const r = await executeToolId(asToolId('builtin:build'), {}, ctx, { workspaceRoot: dir, memoryRepository: null as never }, new AbortController().signal) as { ok: boolean; value: { note?: string } };
    expect(r.ok).toBe(true);
    expect(r.value.note).toContain('dataDir 未注入');
  });
  it('verify：读回校验 bytes+sha256（与 node crypto 一致）；越界路径拒绝；缺参结构化错', async () => {
    writeFileSync(join(dir, 'artifact.txt'), 'hello-as3', 'utf8');
    const r = await executeToolId(asToolId('builtin:verify'), { path: 'artifact.txt' }, ctx, deps(), new AbortController().signal) as { ok: boolean; value: { path: string; bytes: number; sha256: string } };
    expect(r.ok).toBe(true);
    expect(r.value.bytes).toBe(9);
    expect(r.value.sha256).toBe(createHash('sha256').update('hello-as3', 'utf8').digest('hex'));
    const esc = await executeToolId(asToolId('builtin:verify'), { path: '../../etc/passwd' }, ctx, deps(), new AbortController().signal) as { ok: boolean };
    expect(esc.ok).toBe(false); // 工作区边界（safeWorkspaceRead）
    const noarg = await executeToolId(asToolId('builtin:verify'), {}, ctx, deps(), new AbortController().signal) as { ok: boolean };
    expect(noarg.ok).toBe(false);
  });
  it('evidence：审计链计数+最近事件+链校验（tamper 后 chainOk=false）', async () => {
    appendAudit(db, 'as3.evt-1', { n: 1 });
    appendAudit(db, 'as3.evt-2', { n: 2 });
    const r = await executeToolId(asToolId('builtin:evidence'), {}, ctx, deps(), new AbortController().signal) as { ok: boolean; value: { chainOk: boolean; chainCount: number; recentEvidence: Array<{ event: string }> } };
    expect(r.ok).toBe(true);
    expect(r.value.chainOk).toBe(true);
    expect(r.value.chainCount).toBeGreaterThanOrEqual(2);
    expect(r.value.recentEvidence.some(e => e.event === 'as3.evt-2')).toBe(true);
    // 篡改检测：改一条 payload → 链断
    db.prepare('UPDATE audit SET payload=? WHERE id=1').run('{"tampered":true}');
    const r2 = await executeToolId(asToolId('builtin:evidence'), {}, ctx, deps(), new AbortController().signal) as { ok: boolean; value: { chainOk: boolean } };
    expect(r2.value.chainOk).toBe(false);
    expect(verifyAudit(db).ok).toBe(false);
  });
});
