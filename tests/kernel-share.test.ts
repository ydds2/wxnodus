// tests/kernel-share.test.ts — /share 离线加密打包（数据不出机的 share 变体）
// 覆盖：导出/导入往返（消息全量保真）、sha256 防篡改（改包即拒）、AES-256-GCM 加密往返、
// 错误口令拒绝、明文导入血缘标记 share:<源id>
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { exportSessionBundle, importSessionBundle } from '../src/kernel/share.js';

let dir: string;
let db: ReturnType<typeof openDB>;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-share-')); db = openDB(dir); });
afterAll(() => { closeDB(db); rmSync(dir, { recursive: true, force: true }); });

const seed = (id: string) => {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`).run(id, '分享源', Date.now(), Date.now());
  db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, parts, ts) VALUES (?,?,?,?,?,?)`)
    .run(id, 'user', '帮我做待办系统', null, null, 1000);
  db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, parts, ts) VALUES (?,?,?,?,?,?)`)
    .run(id, 'assistant', '好的', null, null, 1001);
  db.prepare(`INSERT INTO messages (session_id, role, content, tool_call_id, parts, ts) VALUES (?,?,?,?,?,?)`)
    .run(id, 'tool', 'fs_read: x', 'call1', '[{"kind":"tool"}]', 1002);
};

describe('share 导出/导入', () => {
  it('明文往返：消息全量保真 + 血缘标记 share:<源id>', () => {
    seed('src-share');
    const r = exportSessionBundle(db, 'src-share');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toEqual({ msgCount: 3, encrypted: false });
    const imp = importSessionBundle(db, r.bundle);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    expect(imp.msgCount).toBe(3);
    expect(imp.sourceId).toBe('src-share');
    const rows = db.prepare(`SELECT role, content, tool_call_id, parts FROM messages WHERE session_id=? ORDER BY id`).all(imp.sessionId) as any[];
    expect(rows.map(x => x.role)).toEqual(['user', 'assistant', 'tool']);
    expect(rows[2]).toMatchObject({ content: 'fs_read: x', tool_call_id: 'call1', parts: '[{"kind":"tool"}]' });
    const sess = db.prepare(`SELECT forked_from_id, title FROM sessions WHERE id=?`).get(imp.sessionId) as any;
    expect(sess.forked_from_id).toBe('share:src-share');
    expect(sess.title).toContain('（导入）');
  });

  it('sha256 防篡改：改一个字符即拒绝', () => {
    seed('src-tamper');
    const r = exportSessionBundle(db, 'src-tamper');
    if (!r.ok) throw new Error(r.error);
    const tampered = r.bundle.replace('好的', '坏的');
    const imp = importSessionBundle(db, tampered);
    expect(imp.ok).toBe(false);
    if (!imp.ok) expect(imp.error).toContain('sha256');
  });

  it('加密往返：AES-256-GCM + scrypt（口令正确解密、错误拒绝）', () => {
    seed('src-enc');
    const r = exportSessionBundle(db, 'src-enc', { password: 'p@ss123' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.encrypted).toBe(true);
    expect(r.bundle).not.toContain('帮我做待办系统'); // 密文不含明文
    expect(r.bundle).toContain('wxn-share-enc');
    // 无口令导入 → 明确提示
    const noPass = importSessionBundle(db, r.bundle);
    expect(noPass.ok).toBe(false);
    // 错误口令 → 拒绝
    const wrong = importSessionBundle(db, r.bundle, { password: 'wrong' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('口令');
    // 正确口令 → 保真
    const ok = importSessionBundle(db, r.bundle, { password: 'p@ss123' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.msgCount).toBe(3);
  });

  it('不存在的会话 → ok:false；非法 JSON/伪造格式 → 拒绝', () => {
    expect(exportSessionBundle(db, 'nope').ok).toBe(false);
    expect(importSessionBundle(db, 'not json').ok).toBe(false);
    expect(importSessionBundle(db, JSON.stringify({ format: 'other' })).ok).toBe(false);
  });
});
