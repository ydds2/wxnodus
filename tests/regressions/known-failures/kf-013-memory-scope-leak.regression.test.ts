// tests/regressions/known-failures/kf-013-memory-scope-leak.regression.test.ts — KF-013 迁移绿回归
// 契约：recallHybrid 的 KNN 分支必须按 session 过滤——跨会话向量召回不得泄漏。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (): string => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/kernel/memory.ts'), 'utf8');

describe('KF-013 resolved: 向量召回按会话隔离', () => {
  it('KNN 查询带 session 过滤（knnStmt JOIN messages + session_id 参数）', () => {
    const s = src();
    const start = s.indexOf('knnStmt.all(');
    const call = s.slice(start, s.indexOf('as Array', start) + 'as Array'.length);
    expect(call).toContain('sessionId');
    const prepare = s.match(/knnStmt\s*=\s*\(\(\)\s*=>\s*\{[^}]*prepare\([^`]*`([^`]*)`/s)?.[1] ?? '';
    expect(prepare).toContain('m.session_id');
  });
});
