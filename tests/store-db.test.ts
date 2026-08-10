// tests/store-db.test.ts — L1-1 数据库层：schema/迁移/容错/FTS5 中文/审计链/checkpoint
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB, appendAudit, saveCheckpoint, restoreCheckpoint, searchMessages, bigramZh, auditHash, forkSession } from '../src/store/db.js';

let dir: string;
let db: ReturnType<typeof openDB>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wxn-db-'));
  db = openDB(dir);
});
afterAll(() => {
  closeDB(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('db 基础', () => {
  it('必需表全部存在', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name);
    for (const t of ['sessions', 'messages', 'settings', 'checkpoints', 'audit']) {
      expect(tables).toContain(t);
    }
  });

  it('WAL 与 foreign_keys 开启', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('幂等：重复 openDB 不报错', () => {
    const extra = openDB(dir);
    closeDB(extra); // 立即关闭，防 WAL 文件锁导致清理失败
    expect(true).toBe(true);
  });
});

describe('bigramZh（中文检索预处理）', () => {
  it('「黑洞引擎」→「黑洞 洞引 引擎」', () => {
    expect(bigramZh('黑洞引擎')).toBe('黑洞 洞引 引擎');
  });
  it('混合中英：「wxnodus 黑洞」保留英文词', () => {
    expect(bigramZh('wxnodus 黑洞')).toContain('wxnodus');
    expect(bigramZh('wxnodus 黑洞')).toContain('黑洞');
  });
  it('auditHash 确定性', () => {
    expect(auditHash('a', 'e', 'p', 1)).toBe(auditHash('a', 'e', 'p', 1));
    expect(auditHash('a', 'e', 'p', 1)).not.toBe(auditHash('b', 'e', 'p', 1));
  });
});

describe('sessions/messages', () => {
  it('建会话 + 写消息 + 读回', () => {
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
      .run('s1', '测试会话', Date.now(), Date.now());
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES (?,?,?,?)`)
      .run('s1', 'user', '你好，黑洞引擎', Date.now());
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES (?,?,?,?)`)
      .run('s1', 'assistant', '收到', Date.now());
    const rows = db.prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY id`).all('s1') as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].content).toContain('黑洞');
  });
});

describe('searchMessages（FTS5 中文检索）', () => {
  it('中文关键词命中（bigram 转换）', () => {
    const hits = searchMessages(db, '黑洞引擎', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('黑洞');
  });
  it('英文/数字可检索', () => {
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES (?,?,?,?)`)
      .run('s1', 'assistant', 'API 端口 9825 已启动', Date.now());
    const hits = searchMessages(db, '9825', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });
  it('无关词零命中', () => {
    const hits = searchMessages(db, '不存在的词xyzzy', { limit: 5 });
    expect(hits.length).toBe(0);
  });
});

describe('appendAudit（合规红线：审计哈希链）', () => {
  it('追加事件 + 链连续可校验', () => {
    const id1 = appendAudit(db, 'user.login', { user: 'u1' });
    const r1 = db.prepare(`SELECT * FROM audit WHERE id=?`).get(id1) as any;
    expect(r1.prev_hash).toBe('GENESIS');
    const id2 = appendAudit(db, 'user.logout', {});
    const r2 = db.prepare(`SELECT * FROM audit WHERE id=?`).get(id2) as any;
    expect(r2.prev_hash).toBe(r1.hash); // 链连续
    // 篡改检测：重算链校验
    const rows = db.prepare(`SELECT * FROM audit ORDER BY id`).all() as any[];
    let prev = 'GENESIS';
    for (const r of rows) {
      const expectHash = auditHash(r.prev_hash, r.event, r.payload, r.ts);
      expect(r.hash).toBe(expectHash);
      expect(r.prev_hash).toBe(prev);
      prev = r.hash;
    }
  });
});

describe('saveCheckpoint/restoreCheckpoint（差距补齐 #6）', () => {
  it('保存/恢复快照 + 上限 10 份', () => {
    for (let i = 0; i < 12; i++) saveCheckpoint(db, 's2', { n: i });
    const cnt = (db.prepare(`SELECT COUNT(*) c FROM checkpoints WHERE session_id='s2'`).get() as any).c;
    expect(cnt).toBeLessThanOrEqual(10);
    const restored = restoreCheckpoint(db, 's2') as any;
    expect(restored.n).toBeGreaterThanOrEqual(9); // 最新一份
  });
  it('未知会话返回 null', () => {
    expect(restoreCheckpoint(db, 'nope')).toBeNull();
  });
});

describe('迁移版本', () => {
  it('schema_version 存在且 >= 1', () => {
    const row = db.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get() as any;
    expect(Number(row?.value ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('类型约束', () => {
  it('unknown 角色被拒绝（check 约束）', () => {
    expect(() =>
      db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES (?,?,?,?)`)
        .run('s1', 'hacker', 'x', Date.now())
    ).toThrow();
  });
});

describe('旧版库迁移（用户在任意目录运行的兼容性）', () => {
  it('V2 遗留库（settings 为 id/data 结构）→ 自动备份重建', () => {
    const { mkdtempSync, rmSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    const d2 = mkdtempSync(join(tmpdir(), 'wxn-legacy-'));
    // 构造旧版库
    const old = new (require('better-sqlite3'))(join(d2, 'nodus.db'));
    old.exec(`CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT); CREATE TABLE recall (id INTEGER PRIMARY KEY, content TEXT);`);
    old.prepare(`INSERT INTO settings (id, data) VALUES (1, 'legacy')`).run();
    old.close();
    // 打开 → 应重建
    const ndb = openDB(d2);
    const v = ndb.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get() as any;
    expect(Number(v.value)).toBeGreaterThanOrEqual(1);
    // 旧库被备份（数据未破坏）
    expect(readdirSync(d2).some(f => f.startsWith('nodus-legacy-'))).toBe(true);
    closeDB(ndb);
    rmSync(d2, { recursive: true, force: true });
  });
});

// ── 会话 fork（M4）────
describe('forkSession 会话分支', () => {
  it('复制会话与全部消息', () => {
    db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('f-src', '源会话', 1, 1)`).run();
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES ('f-src', 'user', '你好', 1)`).run();
    db.prepare(`INSERT INTO messages (session_id, role, content, ts) VALUES ('f-src', 'assistant', '回复', 2)`).run();
    const n = forkSession(db, 'f-src', 'f-dst');
    expect(n).toBe(2);
    const rows = db.prepare(`SELECT role, content FROM messages WHERE session_id='f-dst' ORDER BY id`).all() as any[];
    expect(rows.map(r => r.content)).toEqual(['你好', '回复']);
    const title = db.prepare(`SELECT title FROM sessions WHERE id='f-dst'`).get() as { title: string };
    expect(title.title).toContain('(fork)');
  });
  it('源会话不存在返回 0', () => {
    expect(forkSession(db, 'nope', 'f-x')).toBe(0);
  });
});
