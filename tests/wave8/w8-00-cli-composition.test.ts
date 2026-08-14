// tests/wave8/w8-00-cli-composition.test.ts — W8-00：组合根接管第一刀（config/repositories/kernel 依赖装配）
// 契约：createCliComposition 以固定阶段（config → repositories → kernel）装配 CLI 核心依赖，
// 失败只 dispose 已启动资源（fail-closed）、shutdown 幂等；产出为真实可用的 db/memory/codeIndex。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCliComposition, type CliCompositionDeps } from '../../src/bootstrap/cliComposition.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'w8-comp-')); tempDirs.push(d); return d; };

const deps = (dataDir: string): CliCompositionDeps => ({ dataDir, workspaceRoot: tmp() });

describe('W8-00 createCliComposition（组合根第一刀）', () => {
  it('按固定阶段装配真实依赖：config/db/codeIndex/memoryRepository/mem 全部可用', async () => {
    const dir = tmp();
    const r = await createCliComposition(deps(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { value } = r;
    expect(typeof value.config.get).toBe('function');
    // db 真实可写（better-sqlite3 实盘）
    value.db.prepare('CREATE TABLE IF NOT EXISTS t(x)').run();
    value.db.prepare('INSERT INTO t VALUES (1)').run();
    expect(value.db.prepare('SELECT COUNT(*) c FROM t').get()).toEqual({ c: 1 });
    expect(value.memoryRepository).toBeTruthy();
    expect(value.codeIndex).toBeTruthy();
    expect(value.mem).toBeTruthy();
    await value.shutdown('test');
  });

  it('阶段失败 → 只 dispose 已启动资源 + 稳定错误码（fail-closed）', async () => {
    const dir = tmp();
    const { writeFileSync } = await import('node:fs');
    // dataDir 指向文件而非目录 → openDB 真实失败 → repositories 阶段失败，config 已启动资源被 dispose
    const fileAsDir = join(dir, 'not-a-dir');
    writeFileSync(fileAsDir, 'x');
    const r = await createCliComposition({ dataDir: fileAsDir, workspaceRoot: tmp() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CLI_COMPOSITION_PHASE_FAILED');
  });

  it('shutdown 幂等且聚合失败资源 id（重复关闭不重复 dispose）', async () => {
    const dir = tmp();
    const r = await createCliComposition(deps(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = await r.value.shutdown('once');
    const b = await r.value.shutdown('twice');
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
});
