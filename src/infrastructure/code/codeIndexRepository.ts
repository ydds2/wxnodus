// src/infrastructure/code/codeIndexRepository.ts — W7-03：同化索引持久层（SQLite FTS5）
// code_chunks + code_fts（unicode61 + bigram_zh 中文预处理，与 memory_fts 同款）；插件/MCP 面索引同表
// 不同 source；检索按来源过滤并标注（绝不混标记忆与代码来源）。
import type { Db } from '../../store/db.js';
import { bigramZh } from '../sqlite/bigramZh.js';
import type { CodeChunk } from './codeIndexer.js';

export type IndexedSource = 'code' | 'plugin' | 'mcp';

export interface SurfaceEntry {
  source: Exclude<IndexedSource, 'code'>;
  id: string;
  title: string;
  body: string;
}

export interface SearchHit {
  source: IndexedSource;
  head: string;
  title: string;
  /** code 来源的相对路径（检索命中标注） */
  path?: string;
  /** plugin/mcp 来源的 id（检索命中标注） */
  id?: string;
}

export interface SearchOptions { limit?: number; sources?: IndexedSource[] }

export class CodeIndexRepository {
  constructor(private readonly db: Db) {}

  install(): void {
    this.db.function('bigram_zh', { deterministic: true }, (s: unknown) => bigramZh(String(s ?? '')));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_chunks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, ref TEXT NOT NULL, chunk_index INTEGER NOT NULL,
        head TEXT NOT NULL, title TEXT, body TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_code_chunks_ref ON code_chunks(source, ref, chunk_index);
      CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
        source UNINDEXED, ref UNINDEXED, chunk_index UNINDEXED, head, title, body, tokenize='unicode61'
      );
    `);
  }

  indexChunks(chunks: readonly CodeChunk[], now = Date.now()): void {
    const del = this.db.prepare(`DELETE FROM code_chunks WHERE source='code' AND ref=?`);
    const delFts = this.db.prepare(`DELETE FROM code_fts WHERE source='code' AND ref=?`);
    const insert = this.db.prepare(`INSERT INTO code_chunks(source, ref, chunk_index, head, title, body, indexed_at) VALUES ('code', ?, ?, ?, ?, ?, ?)`);
    const insertFts = this.db.prepare(`INSERT INTO code_fts(rowid, source, ref, chunk_index, head, title, body) VALUES (?, 'code', ?, ?, ?, ?, ?)`);
    const run = this.db.transaction((items: readonly CodeChunk[]) => {
      for (const c of items) {
        del.run(c.path);
        delFts.run(c.path);
        const info = insert.run(c.path, c.chunkIndex, c.head, null, c.text, now);
        // FTS 存 bigram 预处理文本（与 memory_fts 同款：中文 2 字滑窗 + 英文单词保留），查询侧同处理
        insertFts.run(Number(info.lastInsertRowid), c.path, c.chunkIndex, bigramZh(c.head), null, bigramZh(c.text));
      }
    });
    run(chunks);
  }

  indexSurfaces(entries: readonly SurfaceEntry[], now = Date.now()): void {
    const del = this.db.prepare(`DELETE FROM code_chunks WHERE source=? AND ref=?`);
    const delFts = this.db.prepare(`DELETE FROM code_fts WHERE source=? AND ref=?`);
    const insert = this.db.prepare(`INSERT INTO code_chunks(source, ref, chunk_index, head, title, body, indexed_at) VALUES (?, ?, 0, '', ?, ?, ?)`);
    const insertFts = this.db.prepare(`INSERT INTO code_fts(rowid, source, ref, chunk_index, head, title, body) VALUES (?, ?, ?, 0, '', ?, ?)`);
    const run = this.db.transaction((items: readonly SurfaceEntry[]) => {
      for (const e of items) {
        del.run(e.source, e.id);
        delFts.run(e.source, e.id);
        const info = insert.run(e.source, e.id, e.title, e.body, now);
        insertFts.run(Number(info.lastInsertRowid), e.source, e.id, bigramZh(e.title), bigramZh(e.body));
      }
    });
    run(entries);
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = Math.min(Math.max(Number.isInteger(opts.limit) ? opts.limit! : 10, 1), 50);
    const sources = opts.sources?.length ? opts.sources : (['code', 'plugin', 'mcp'] as IndexedSource[]);
    const filter = `source IN (${sources.map(() => '?').join(',')})`;
    const rows = this.db.prepare(`SELECT source, ref, head, title FROM code_fts WHERE code_fts MATCH @match AND ${filter} ORDER BY rank LIMIT @limit`)
      .all({ match: bigramZh(query), limit }, ...sources) as Array<{ source: IndexedSource; ref: string; head: string; title: string }>;
    return rows.map(r => ({
      source: r.source,
      head: r.head,
      title: r.title ?? '',
      ...(r.source === 'code' ? { path: r.ref } : { id: r.ref }),
    }));
  }
}
