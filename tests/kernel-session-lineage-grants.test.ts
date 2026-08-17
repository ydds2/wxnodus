// tests/kernel-session-lineage-grants.test.ts — 会话血缘 + approve_for_session 真实授权（gap P2-1 部分 / P1-4）
// 覆盖：forkSession 血缘/消息复制、listSessionsStructured 首问摘要/分支计数、sessionLineage 链、
// grantKey 构造、授权 upsert/deny 优先/撤销、agent 授权流（批准一次→同键跳过确认→执行；
// session-deny 直拒不执行；红线仍不可被授权绕过）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createAgent, type ModelCall, type ToolCallMsg } from '../src/kernel/agent.js';
import { forkSession, listSessionsStructured, sessionLineage } from '../src/kernel/sessionLineage.js';
import { grantKey, checkSessionGrant, grantSession, revokeSessionGrant, listSessionGrants } from '../src/kernel/sessionGrants.js';

let dir: string;
let db: ReturnType<typeof openDB>;
let bus: ReturnType<typeof createEventBus>;
let mem: ReturnType<typeof createMemory>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-lineage-'));
  db = openDB(dir);
  bus = createEventBus(dir);
  mem = createMemory(db);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

const seedSession = (id: string, title: string, msgs: Array<[string, string]> = []) => {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
    .run(id, title, Date.now(), Date.now());
  msgs.forEach(([role, content], i) => {
    db.prepare(`INSERT INTO messages (session_id, role, content, archived, ts) VALUES (?,?,?,0,?)`)
      .run(id, role, content, Date.now() + i);
  });
};

describe('会话血缘与结构化列表', () => {
  it('forkSession：复制消息 + 记 forked_from_id；listSessionsStructured 含首问摘要/分支数/血缘', () => {
    seedSession('src1', '源头会话', [
      ['user', '请帮我做一个待办系统'],
      ['assistant', '好的'],
      ['tool', 'fs_read: x'],
    ]);
    const r = forkSession(db, 'src1', 'fork1');
    expect(r.ok).toBe(true);
    expect(r.msgCount).toBe(3);
    const list = listSessionsStructured(db);
    const fork = list.find(s => s.id === 'fork1')!;
    expect(fork.forkedFromId).toBe('src1');
    expect(fork.msgCount).toBe(3);
    expect(fork.firstUser).toBe('请帮我做一个待办系统');
    const src = list.find(s => s.id === 'src1')!;
    expect(src.forkCount).toBe(1);
    expect(src.forkedFromId).toBeNull();
  });

  it('forkSession 不存在的源 → ok:false；sessionLineage 链（含自身，旧→新）', () => {
    expect(forkSession(db, 'nope', 'x').ok).toBe(false);
    forkSession(db, 'fork1', 'fork2');
    const chain = sessionLineage(db, 'fork2');
    expect(chain).toEqual(['src1', 'fork1', 'fork2']);
    const self = sessionLineage(db, 'src1');
    expect(self).toEqual(['src1']);
  });

  it('firstUser 摘要清洗空白并截断 80 字', () => {
    seedSession('wrap1', 't', [['user', '  ' + '长'.repeat(100) + '  \n换行']]);
    const s = listSessionsStructured(db).find(x => x.id === 'wrap1')!;
    expect(s.firstUser.length).toBeLessThanOrEqual(80);
    expect(s.firstUser.includes('\n')).toBe(false);
  });
});

describe('sessionGrants（P1-4 授权存储）', () => {
  it('grantKey：bash 精确命令 / fs 精确 path / 其余规范化 JSON', () => {
    expect(grantKey('bash', { command: 'npm test' })).toBe('npm test');
    expect(grantKey('fs_write', { path: 'a.txt' })).toBe('a.txt');
    expect(grantKey('http_get', { url: 'x', b: 1, a: 2 })).toBe(grantKey('http_get', { a: 2, b: 1, url: 'x' }));
  });

  it('授权 upsert + deny 优先 + 撤销计数', () => {
    grantSession(db, 's1', 'bash', { command: 'npm test' }, 'allow');
    expect(checkSessionGrant(db, 's1', 'bash', { command: 'npm test' })).toBe('allow');
    // upsert 改 deny（同键覆盖）
    grantSession(db, 's1', 'bash', { command: 'npm test' }, 'deny');
    expect(checkSessionGrant(db, 's1', 'bash', { command: 'npm test' })).toBe('deny');
    // 会话隔离
    expect(checkSessionGrant(db, 's2', 'bash', { command: 'npm test' })).toBeNull();
    // 撤销（按 tool+key）
    expect(revokeSessionGrant(db, 's1', 'bash', 'npm test')).toBe(1);
    expect(checkSessionGrant(db, 's1', 'bash', { command: 'npm test' })).toBeNull();
    // 撤销全工具/全会话
    grantSession(db, 's1', 'fs_write', { path: 'a' }, 'allow');
    grantSession(db, 's1', 'bash', { command: 'x' }, 'allow');
    expect(revokeSessionGrant(db, 's1', 'fs_write')).toBe(1);
    expect(revokeSessionGrant(db, 's1')).toBe(1);
    expect(listSessionGrants(db, 's1')).toHaveLength(0);
  });
});

describe('agent approve_for_session 授权流（P1-4）', () => {
  const writeTool: Record<string, import('../src/kernel/tools.js').ToolDef> = {
    grant_write: {
      schema: { type: 'function', function: { name: 'grant_write', description: 'w', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      danger: true,
      run: async ({ path }: any) => `已写入 ${path}`,
    },
  };

  it('批准一次 → 同键第二次跳过确认（onApproval 只调一次）且两次都真实执行', async () => {
    let approvalCount = 0;
    let call = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 'grant-agent',
      config: { settings: { baseURL: 'https://mock', model: 'mock' } } as any,
      mode: 'manual' as const, // manual：确认链必走（排除模式放行干扰）
      approveForSession: true,
      onApproval: async () => { approvalCount++; return true; },
      extraTools: writeTool,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        call++;
        if (call <= 2) return { type: 'tool_call', name: 'grant_write', args: { path: 'a.txt' } } as ToolCallMsg;
        return { type: 'text', content: '测试结束' } as ModelCall;
      },
    });
    const r = await agent.run('写两次');
    expect(r.ok).toBe(true);
    expect(approvalCount).toBe(1); // 第二次走会话授权，未再弹窗
    const writes = db.prepare(`SELECT COUNT(*) c FROM messages WHERE session_id=? AND role='tool'`).get('grant-agent') as { c: number };
    expect(writes.c).toBe(2);
    revokeSessionGrant(db, 'grant-agent');
  });

  it('session-deny → 直拒不执行（不弹确认）；红线仍不可被授权绕过', async () => {
    let approvalCount = 0;
    grantSession(db, 'grant-agent', 'grant_write', { path: 'b.txt' }, 'deny');
    grantSession(db, 'grant-agent', 'bash', { command: 'rm -rf /' }, 'allow');
    let call = 0;
    const agent = createAgent({
      db, bus, mem, sessionId: 'grant-agent',
      config: { settings: { baseURL: 'https://mock', model: 'mock' } } as any,
      mode: 'manual' as const,
      approveForSession: true,
      onApproval: async () => { approvalCount++; return true; },
      extraTools: writeTool,
      callModel: async (): Promise<ModelCall | ToolCallMsg> => {
        call++;
        if (call === 1) return { type: 'tool_call', name: 'grant_write', args: { path: 'b.txt' } } as ToolCallMsg;
        if (call === 2) return { type: 'tool_call', name: 'bash', args: { command: 'rm -rf /' } } as ToolCallMsg;
        return { type: 'text', content: '测试结束' } as ModelCall;
      },
    });
    const r = await agent.run('deny 与红线');
    expect(r.ok).toBe(true);
    expect(approvalCount).toBe(0); // deny 直拒 + 红线拒绝均不弹确认
    const tools = (db.prepare(`SELECT content FROM messages WHERE session_id=? AND role='tool' ORDER BY id DESC LIMIT 2`).all('grant-agent') as Array<{ content: string }>).reverse();
    expect(tools[0]!.content).toContain('会话授权规则拒绝');
    expect(tools[1]!.content).toContain('权限红线');
    expect(tools[1]!.content).not.toContain('会话授权放行');
    revokeSessionGrant(db, 'grant-agent');
  });
});
