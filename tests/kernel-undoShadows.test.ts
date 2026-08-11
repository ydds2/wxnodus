// tests/kernel-undoShadows.test.ts — 文件编辑影子快照：快照/FIFO/恢复
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotFile, listShadows, restoreShadow } from '../src/kernel/undoShadows.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-undo-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('undoShadows 影子快照', () => {
  it('快照 → 列表 → 恢复全链路（内容一致）', () => {
    const d = tmp();
    const dataDir = join(d, 'data');
    const file = join(d, 'app.ts');
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'src', 'app.ts'), 'v1 原始内容');
    // 编辑前快照
    const s = snapshotFile(dataDir, file, 'v1 原始内容');
    expect(s).not.toBeNull();
    // 模拟覆盖
    writeFileSync(file, 'v2 被改坏的内容');
    const list = listShadows(dataDir);
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe(file);
    // 恢复
    const r = restoreShadow(dataDir, '1');
    expect(r.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('v1 原始内容');
    // 恢复后快照被删除（不重复恢复）
    expect(listShadows(dataDir)).toHaveLength(0);
  });

  it('FIFO 上限 50：超出后最旧快照被淘汰', () => {
    const d = tmp();
    const dataDir = join(d, 'data');
    for (let i = 0; i < 55; i++) {
      snapshotFile(dataDir, join(d, `f${i}.ts`), `内容${i}`);
    }
    const list = listShadows(dataDir);
    expect(list).toHaveLength(50);
    // 最旧（f0）被淘汰，最新（f54）保留
    expect(list.some(s => s.path.endsWith('f0.ts'))).toBe(false);
    expect(list[0]!.path.endsWith('f54.ts')).toBe(true);
  });

  it('非法编号/不存在 id → 明确错误；空目录 → 提示', () => {
    const d = tmp();
    const dataDir = join(d, 'data');
    expect(restoreShadow(dataDir, '1').ok).toBe(false);
    expect(restoreShadow(dataDir, '1').message).toContain('无快照');
    snapshotFile(dataDir, join(d, 'a.ts'), 'x');
    expect(restoreShadow(dataDir, '99').ok).toBe(false);
    expect(restoreShadow(dataDir, 'nope').ok).toBe(false);
  });

  it('恢复已删除文件：重建目录并写回', () => {
    const d = tmp();
    const dataDir = join(d, 'data');
    const file = join(d, 'deep', 'nested', 'x.ts');
    mkdirSync(join(d, 'deep', 'nested'), { recursive: true });
    writeFileSync(file, '原始');
    snapshotFile(dataDir, file, '原始');
    rmSync(file, { force: true });
    expect(existsSync(file)).toBe(false);
    const r = restoreShadow(dataDir, '1');
    expect(r.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('原始');
  });
});
