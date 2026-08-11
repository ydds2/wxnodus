// tests/kernel-undoShadows.test.ts — 文件编辑影子快照：快照/FIFO/恢复/版本时间线/目录快照
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotFile, listShadows, restoreShadow, versionsOfFile, snapshotDir, restoreDirShadows } from '../src/kernel/undoShadows.js';

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

describe('文件时间机器（versionsOfFile）', () => {
  it('同一文件多版本按时间倒序；路径归一化（反斜杠兼容）', () => {
    const d = tmp();
    const dataDir = join(d, 'data');
    const file = join(d, 'a.ts');
    writeFileSync(file, 'v1');
    snapshotFile(dataDir, file, 'v1');
    snapshotFile(dataDir, file, 'v2');
    snapshotFile(dataDir, file, 'v3');
    const versions = versionsOfFile(dataDir, file);
    expect(versions).toHaveLength(3);
    expect(versions[0]!.content).toBe('v3'); // 最新在前
    // 反斜杠路径同样命中
    expect(versionsOfFile(dataDir, file.replace(/\\/g, '/'))).toHaveLength(3);
    // 其他文件不串扰
    expect(versionsOfFile(dataDir, join(d, 'b.ts'))).toHaveLength(0);
  });
});

describe('目录级快照（snapshotDir / restoreDirShadows）', () => {
  it('递归建档文本文件；跳过 node_modules/二进制/空文件', () => {
    const d = tmp();
    const dataDir = join(d, 'data');
    mkdirSync(join(d, 'proj', 'src'), { recursive: true });
    mkdirSync(join(d, 'proj', 'node_modules'), { recursive: true });
    writeFileSync(join(d, 'proj', 'a.ts'), '文本A');
    writeFileSync(join(d, 'proj', 'src', 'b.ts'), '文本B');
    writeFileSync(join(d, 'proj', 'node_modules', 'c.ts'), '不该建档');
    writeFileSync(join(d, 'proj', 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])); // 含 NUL 的二进制
    writeFileSync(join(d, 'proj', 'empty.ts'), '');
    const r = snapshotDir(dataDir, join(d, 'proj'));
    expect(r.count).toBe(2);
    expect(r.files.some(f => f.endsWith('a.ts'))).toBe(true);
    expect(r.files.some(f => f.endsWith('b.ts'))).toBe(true);
    // node_modules 是忽略目录（不扫描、不建档、也不计入 skipped）
    expect(r.files.some(f => f.endsWith('c.ts'))).toBe(false);
    expect(r.skipped.some(f => f.endsWith('c.ts'))).toBe(false);
    expect(r.skipped.some(f => f.endsWith('img.png'))).toBe(true);
    expect(r.skipped.some(f => f.endsWith('empty.ts'))).toBe(true);
  });

  it('整体回滚：改坏后 restoreDirShadows 恢复全部文本文件', () => {
    const d = tmp();
    const dataDir = join(d, 'data');
    mkdirSync(join(d, 'proj'), { recursive: true });
    writeFileSync(join(d, 'proj', 'a.ts'), '原A');
    writeFileSync(join(d, 'proj', 'b.ts'), '原B');
    snapshotDir(dataDir, join(d, 'proj'));
    writeFileSync(join(d, 'proj', 'a.ts'), '改坏A');
    writeFileSync(join(d, 'proj', 'b.ts'), '改坏B');
    const r = restoreDirShadows(dataDir, join(d, 'proj'));
    expect(r.ok).toBe(2);
    expect(r.failed).toHaveLength(0);
    expect(readFileSync(join(d, 'proj', 'a.ts'), 'utf8')).toBe('原A');
    expect(readFileSync(join(d, 'proj', 'b.ts'), 'utf8')).toBe('原B');
    expect(listShadows(dataDir)).toHaveLength(0); // 恢复后清空
  });

  it('目录外快照不受 restoreDir 影响（前缀严格匹配）', () => {
    const d = tmp();
    const dataDir = join(d, 'data');
    mkdirSync(join(d, 'proj'), { recursive: true });
    mkdirSync(join(d, 'proj2'), { recursive: true });
    writeFileSync(join(d, 'proj', 'a.ts'), 'A');
    writeFileSync(join(d, 'proj2', 'b.ts'), 'B');
    snapshotDir(dataDir, join(d, 'proj'));
    snapshotDir(dataDir, join(d, 'proj2'));
    const r = restoreDirShadows(dataDir, join(d, 'proj'));
    expect(r.ok).toBe(1);
    expect(listShadows(dataDir)).toHaveLength(1); // proj2 的保留
  });
});
