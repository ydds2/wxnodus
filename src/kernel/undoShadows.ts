// src/kernel/undoShadows.ts — 文件编辑影子快照（Aider /undo 精神的零 git 依赖版）
// 设计：fs_write/fs_edit 覆盖文件前，把原内容备份为 <dataDir>/undo-shadows/<id>.json；
//       /undo fs list｜restore <编号> 安全撤销编辑（不依赖 git，任何工作区可用）。
//       最多保留 SHADOW_MAX 份（FIFO 淘汰），快照为本地数据（数据不出机红线）
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface UndoShadow {
  /** 短哈希 id（path + ts） */
  id: string;
  /** 被编辑文件的绝对路径 */
  path: string;
  /** 编辑前原内容 */
  content: string;
  /** 快照时间戳 */
  ts: number;
}

const SHADOW_MAX = 50;
const shadowDir = (dataDir: string) => join(dataDir, 'undo-shadows');

function shadowFile(dataDir: string, id: string): string {
  return join(shadowDir(dataDir), `${id}.json`);
}

/** 记录编辑前快照：仅当文件存在且内容确实不同才备份；返回快照或 null */
export function snapshotFile(dataDir: string, absPath: string, oldContent: string): UndoShadow | null {
  try {
    // 内容摘要入 id：同毫秒连续快照（且同长度）此前会碰撞互相覆盖——CI 快盘实测
    // 3 版本坍缩为 2（undo 数据丢失级缺陷）；内容进哈希后彻底免疫
    const id = createHash('sha1').update(`${absPath}:${Date.now()}:${createHash('sha256').update(oldContent).digest('hex').slice(0, 16)}`).digest('hex').slice(0, 12);
    const shadow: UndoShadow = { id, path: absPath, content: oldContent, ts: Date.now() };
    mkdirSync(shadowDir(dataDir), { recursive: true });
    writeFileSync(shadowFile(dataDir, id), JSON.stringify(shadow), 'utf8');
    // FIFO 淘汰：超出上限删最旧（按文件名 mtime 序不可靠——用 ts 字段排序）
    const all = listShadows(dataDir);
    if (all.length > SHADOW_MAX) {
      // all 按 ts 降序（新在前）——保留前 SHADOW_MAX 份，删尾部最旧
      const drop = all.slice(SHADOW_MAX);
      for (const s of drop) {
        try { rmSync(shadowFile(dataDir, s.id), { force: true }); } catch { /* 忽略 */ }
      }
    }
    return shadow;
  } catch { return null; }
}

/** 列出全部快照（新的在前） */
export function listShadows(dataDir: string): UndoShadow[] {
  const dir = shadowDir(dataDir);
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: UndoShadow[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, e), 'utf8')) as UndoShadow;
      if (j && typeof j.path === 'string' && typeof j.content === 'string') out.push(j);
    } catch { /* 损坏快照跳过 */ }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** 恢复快照（按 id 或编号，编号 1 = 最新）；返回结果描述 */
export function restoreShadow(dataDir: string, idOrIndex: string): { ok: boolean; message: string; path?: string } {
  const all = listShadows(dataDir);
  if (!all.length) return { ok: false, message: '无快照（/undo fs 编辑文件前自动生成；fs_write/fs_edit 才记录）' };
  let target: UndoShadow | null = null;
  if (/^\d+$/.test(idOrIndex)) {
    const idx = parseInt(idOrIndex, 10) - 1;
    target = all[idx] ?? null;
    if (!target) return { ok: false, message: `编号超出范围（共 ${all.length} 份，编号 1 = 最新）` };
  } else {
    target = all.find(s => s.id === idOrIndex) ?? null;
    if (!target) return { ok: false, message: `未找到快照「${idOrIndex}」（/undo fs list 查看）` };
  }
  try {
    if (!existsSync(target.path)) {
      mkdirSync(dirname(target.path), { recursive: true });
    }
    writeFileSync(target.path, target.content, 'utf8');
    // 恢复成功即删除该快照（避免重复恢复）
    try { rmSync(shadowFile(dataDir, target.id), { force: true }); } catch { /* 忽略 */ }
    return { ok: true, message: `已恢复 ${target.path}（快照 ${new Date(target.ts).toLocaleString('zh-CN', { hour12: false })}）`, path: target.path };
  } catch (e: any) {
    return { ok: false, message: `恢复失败：${String(e?.message ?? e).slice(0, 120)}` };
  }
}

// ── 文件时间机器 ────────────────────────────────────────────
// /versions 与 /snapshot 的数据源：快照链本身就是「版本时间线」——
// 同一文件的多份快照按 ts 排序即历史版本，无需额外存储。

/** 某文件的历史版本（新的在前）：/versions <file> 的数据源 */
export function versionsOfFile(dataDir: string, absPath: string): UndoShadow[] {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const target = norm(absPath);
  return listShadows(dataDir).filter(s => norm(s.path) === target);
}

/** 目录级快照：递归备份目录内文本文件（跳过 node_modules/.git/dist 等与二进制/大文件）；返回快照数 */
export function snapshotDir(dataDir: string, dir: string, opts: { maxBytes?: number } = {}): { count: number; files: string[]; skipped: string[] } {
  const maxBytes = opts.maxBytes ?? 1024 * 1024; // 1MB 上限（快照体积控制）
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', 'out', '.next', '.venv', '__pycache__', '.wxnodus', '.zcode', 'undo-shadows']);
  const count = { n: 0, files: [] as string[], skipped: [] as string[] };
  const walk = (cur: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(cur, { withFileTypes: true }).map(e => e.name); } catch { return; }
    for (const name of entries) {
      const full = join(cur, name);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { /* 无权限 */ }
      if (isDir) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      try {
        const st = statSync(full);
        if (!st.isFile() || st.size > maxBytes || st.size === 0) { count.skipped.push(full); continue; }
        const buf = readFileSync(full);
        // NUL 字节判定二进制（png/exe 等）——文本文件不应含 \0
        if (buf.includes(0)) { count.skipped.push(full); continue; }
        if (snapshotFile(dataDir, full, buf.toString('utf8'))) {
          count.n++;
          count.files.push(full);
        }
      } catch { count.skipped.push(full); }
    }
  };
  walk(dir);
  return { count: count.n, files: count.files, skipped: count.skipped };
}

/** 恢复目录内全部快照（每文件恢复到最新版本）；返回恢复的文件数 */
export function restoreDirShadows(dataDir: string, dir: string): { ok: number; failed: string[] } {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const target = norm(dir);
  const shadows = listShadows(dataDir).filter(s => norm(s.path).startsWith(target + '/'));
  let ok = 0;
  const failed: string[] = [];
  for (const s of shadows) {
    try {
      if (!existsSync(s.path)) mkdirSync(dirname(s.path), { recursive: true });
      writeFileSync(s.path, s.content, 'utf8');
      try { rmSync(shadowFile(dataDir, s.id), { force: true }); } catch { /* 忽略 */ }
      ok++;
    } catch { failed.push(s.path); }
  }
  return { ok, failed };
}
