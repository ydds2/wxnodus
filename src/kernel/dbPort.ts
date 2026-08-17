// src/kernel/dbPort.ts — kernel 层数据库最小结构端口（分层泄漏修复 audit §13.45）
// kernel 不再 import store 的 Db 类型——真实 Db（better-sqlite3）自然满足本结构。
export type DbPort = {
  prepare(sql: string): {
    all(...a: unknown[]): unknown[];
    get(...a: unknown[]): unknown;
    run(...a: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  };
};
