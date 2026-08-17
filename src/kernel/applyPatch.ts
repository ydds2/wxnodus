// src/kernel/applyPatch.ts — apply_patch 结构化多文件补丁（gap P0-3 落地，2026-08-18）
// 语法取 codex apply_patch.lark 子集（Add/Update/Delete/Move + @@ 锚定），容错抄 aider：
// ① 匹配三级容错：精确 → 行内空白容忍（perfect_or_whitespace）→ 重缩进（忽略行首空白）
// ② 全量校验通过才落盘（绝不写一半——codex verify-then-apply 语义）
// ③ 失败逐块报「文件/第 N 块/原因」+ did_you_mean 相似行提示
// ④ 每文件落盘前 undoShadows 快照（/undo fs 可回滚）
// 补丁示例：
//   *** Begin Patch
//   *** Update File: src/a.ts
//   @@
//    const x = 1;
//   -const y = 2;
//   +const y = 3;
//   *** Add File: src/b.ts
//   +export const b = 1;
//   *** End Patch
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, sep, dirname } from 'node:path';

export interface PatchHunk {
  /** 锚定块（ctx 与 - 行按序拼接，用于在文件中定位） */
  anchor: string[];
  /** 替换块（ctx 与 + 行按序拼接，- 行移除） */
  replacement: string[];
}

export interface PatchFile {
  action: 'add' | 'update' | 'delete' | 'move';
  path: string;
  toPath?: string;   // move 目标
  hunks: PatchHunk[]; // update 用
  content: string[];  // add 用（不含 + 前缀）
}

export interface PatchDoc {
  files: PatchFile[];
}

// 生产护栏（防恶意/失控补丁打爆内存与文件系统）
const MAX_PATCH_CHARS = 500_000;
const MAX_FILES = 50;
const MAX_HUNKS_PER_FILE = 200;
const MAX_ANCHOR_LINES = 500;

export type ParseOutcome = { ok: true; doc: PatchDoc } | { ok: false; error: string };

/** 纯解析（可单测）：codex 子集语法 → 结构化文档。解析错误带行号。 */
export function parsePatch(patch: string): ParseOutcome {
  if (patch.length > MAX_PATCH_CHARS) return { ok: false, error: `补丁过大（${patch.length} 字 > ${MAX_PATCH_CHARS} 上限）` };
  const lines = patch.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
  const doc: PatchDoc = { files: [] };
  let cur: PatchFile | null = null;
  let hunk: PatchHunk | null = null;
  let anchorCtxTail = 0; // 锚定块末尾「纯上下文行」计数（退化 ctx==minus 容错用）
  let inPatch = false;
  let sawBegin = false;
  const fail = (i: number, msg: string): ParseOutcome => ({ ok: false, error: `第 ${i + 1} 行：${msg}` });
  const flushHunk = () => { if (hunk && cur) { cur.hunks.push(hunk); hunk = null; } };
  const flushFile = () => { flushHunk(); if (cur) { doc.files.push(cur); } cur = null; };
  // 文件路径捕获（单字符路径也须命中——.+? 至少要 1 字符，不能用 \S.+?）
  const pathOf = (line: string, re: RegExp): string | null => {
    const m = line.match(re);
    return m ? m[1]!.trim() : null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inPatch) {
      if (/^\*\*\*\s*Begin Patch/.test(line)) { inPatch = true; sawBegin = true; continue; }
      continue; // Begin 之前的杂质行容忍（模型常带说明文字）
    }
    if (/^\*\*\*\s*End Patch/.test(line)) { flushFile(); inPatch = false; continue; }
    const addFile = pathOf(line, /^\*\*\*\s*Add File:\s*(.+?)\s*$/);
    if (addFile !== null) {
      flushFile();
      if (doc.files.length >= MAX_FILES) return fail(i, `文件数超限（>${MAX_FILES}）`);
      cur = { action: 'add', path: addFile, hunks: [], content: [] };
      continue;
    }
    const deleteFile = pathOf(line, /^\*\*\*\s*Delete File:\s*(.+?)\s*$/);
    if (deleteFile !== null) {
      flushFile();
      if (doc.files.length >= MAX_FILES) return fail(i, `文件数超限（>${MAX_FILES}）`);
      cur = { action: 'delete', path: deleteFile, hunks: [], content: [] };
      continue;
    }
    const moveFile = pathOf(line, /^\*\*\*\s*Move File:\s*(.+?)\s*$/);
    if (moveFile !== null) {
      flushFile();
      if (doc.files.length >= MAX_FILES) return fail(i, `文件数超限（>${MAX_FILES}）`);
      cur = { action: 'move', path: moveFile, hunks: [], content: [] };
      continue;
    }
    const toFile = pathOf(line, /^\*\*\*\s*To(?: File)?:\s*(.+?)\s*$/);
    if (toFile !== null) {
      if (!cur || cur.action !== 'move') return fail(i, '*** To File 前必须有 *** Move File');
      cur.toPath = toFile;
      continue;
    }
    const updateFile = pathOf(line, /^\*\*\*\s*Update File:\s*(.+?)\s*$/);
    if (updateFile !== null) {
      flushFile();
      if (doc.files.length >= MAX_FILES) return fail(i, `文件数超限（>${MAX_FILES}）`);
      cur = { action: 'update', path: updateFile, hunks: [], content: [] };
      continue;
    }
    if (line.startsWith('***')) return fail(i, `无法识别的指令：${line.slice(0, 60)}`);
    if (!cur) return fail(i, '内容行出现在任何 *** 指令之前（需要 Add/Update/Delete/Move File）');
    if (cur.action === 'add') {
      if (line.startsWith('+')) cur.content.push(line.slice(1));
      else if (!line.trim()) cur.content.push('');
      else return fail(i, `Add File 的内容行必须以 + 开头（或空行）：${line.slice(0, 60)}`);
      continue;
    }
    if (cur.action === 'update') {
      if (/^@@\s*$/.test(line)) {
        flushHunk();
        hunk = { anchor: [], replacement: [] };
        anchorCtxTail = 0; // 新块重置「锚定块末尾纯上下文行数」
        continue;
      }
      if (!hunk) return fail(i, 'Update File 内容前缺少 @@ 锚点行');
      if (hunk.anchor.length + hunk.replacement.length >= MAX_ANCHOR_LINES) return fail(i, `单块行数超限（>${MAX_ANCHOR_LINES}）`);
      if (line.startsWith('+')) { hunk.replacement.push(line.slice(1)); anchorCtxTail = 0; continue; }
      if (line.startsWith('-')) {
        const minusText = line.slice(1);
        // 退化容错（模型常见冗余：上下文行与 - 行完全重复——「把这一行改成…」同时
        // 列 ctx 与 - 同一行）。此时 ctx 是冗余的：从 anchor 与 replacement 尾部各退
        // 一行，minus 行本身作为锚定行——语义精确变为「该行替换为后续 + 行」。
        if (anchorCtxTail > 0 && hunk.anchor[hunk.anchor.length - 1] === minusText) {
          hunk.anchor.pop();
          hunk.replacement.pop();
        }
        hunk.anchor.push(minusText);
        anchorCtxTail = 0;
        continue;
      }
      hunk.anchor.push(line); // 普通上下文行（两侧都要）
      hunk.replacement.push(line);
      anchorCtxTail++;
      continue;
    }
    // delete/move：内容区不允许任何内容
    if (line.trim()) return fail(i, `${cur.action === 'delete' ? 'Delete' : 'Move'} File 不接受内容行`);
  }
  flushFile();
  if (!sawBegin) return { ok: false, error: '未找到 *** Begin Patch（补丁必须以 Begin Patch 开始）' };
  if (!doc.files.length) return { ok: false, error: '补丁没有任何文件操作' };
  for (const f of doc.files) {
    if (f.action === 'move' && !f.toPath) return { ok: false, error: `Move File ${f.path} 缺少 *** To File 目标` };
    if (f.action === 'update' && !f.hunks.length) return { ok: false, error: `Update File ${f.path} 没有任何 @@ 块` };
    if (f.action === 'update' && f.hunks.length > MAX_HUNKS_PER_FILE) return { ok: false, error: `Update File ${f.path} 块数超限（>${MAX_HUNKS_PER_FILE}）` };
  }
  return { ok: true, doc };
}

// ── 匹配容错三级（aider perfect_or_whitespace 对齐）────────
function lineTrimmed(l: string): string { return l.replace(/[ \t]+$/g, ''); }
function lineReindent(l: string): string { return l.replace(/^\s*/, ''); }

function blockMatches(fileLines: string[], at: number, anchor: string[], mode: 0 | 1 | 2): boolean {
  const norm = mode === 0 ? (l: string) => l : mode === 1 ? lineTrimmed : lineReindent;
  for (let k = 0; k < anchor.length; k++) {
    const fl = fileLines[at + k];
    if (fl === undefined) return false;
    if (mode === 0 && fl !== anchor[k]) return false;
    if (mode !== 0 && norm(fl) !== norm(anchor[k]!)) return false;
  }
  return true;
}

/** did_you_mean：与目标行最相似的文件行（有序公共字符数打分） */
export function nearestLine(fileLines: string[], target: string, excludeAt?: number): { index: number; line: string } | null {
  const t = lineReindent(target.toLowerCase());
  if (!t) return null;
  const sim = (a: string): number => {
    const s = lineReindent(a.toLowerCase());
    let i = 0;
    for (const ch of s) { if (ch === t[i]) i++; if (i >= t.length) break; }
    return i;
  };
  let best = -1; let bestScore = 0;
  fileLines.forEach((l, idx) => {
    if (excludeAt !== undefined && idx >= excludeAt && idx < excludeAt + 1) return;
    const sc = sim(l);
    if (sc > bestScore) { bestScore = sc; best = idx; }
  });
  return best >= 0 ? { index: best, line: fileLines[best]! } : null;
}

export interface ApplyOutcome { ok: boolean; text: string }

/**
 * 全量校验后落盘（绝不写一半）：所有文件所有块匹配成功才写。
 * cwd 内相对路径（与 fs_read/fs_edit 同工作区语义）；move/delete 前快照原内容。
 */
export async function applyPatch(patch: string, opts: { cwd: string; dataDir: string }): Promise<ApplyOutcome> {
  const parsed = parsePatch(patch);
  if (!parsed.ok) return { ok: false, text: `apply_patch 解析失败：${parsed.error}` };
  const plan: Array<{ file: PatchFile; abs: string; toAbs?: string; before: string | null; after: string | null; details: string[] }> = [];
  const cwdRoot = resolve(opts.cwd);
  for (const f of parsed.doc.files) {
    const abs = resolve(opts.cwd, f.path);
    const rel = f.path;
    // 工作区守卫（与 fs_read 同款：拒绝 ../ 逃逸与跨盘）
    if (abs !== cwdRoot && !abs.startsWith(cwdRoot + sep)) {
      return { ok: false, text: `apply_patch 拒绝：路径超出工作区 ${rel}` };
    }
    if (f.action === 'add') {
      if (existsSync(abs)) return { ok: false, text: `apply_patch 失败：${rel} 已存在——新增文件请勿覆盖，改用 Update File` };
      plan.push({ file: f, abs, before: null, after: f.content.join('\n'), details: [`新增 ${f.content.length} 行`] });
      continue;
    }
    if (!existsSync(abs)) return { ok: false, text: `apply_patch 失败：${rel} 不存在（无法 ${f.action}）` };
    const before = readFileSync(abs, 'utf8');
    if (f.action === 'delete') {
      plan.push({ file: f, abs, before, after: null, details: ['删除文件'] });
      continue;
    }
    if (f.action === 'move') {
      const toAbs = resolve(opts.cwd, f.toPath!);
      if (existsSync(toAbs)) return { ok: false, text: `apply_patch 失败：目标 ${f.toPath} 已存在（Move 不覆盖）` };
      plan.push({ file: f, abs, before, after: null, details: [`移动 → ${f.toPath}`], toAbs });
      continue;
    }
    // update：逐块匹配（三级容错），失败聚合逐块报错
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const fileLines = before.split(/\r?\n/);
    const errors: string[] = [];
    const edits: Array<{ at: number; remove: number; insert: string }> = [];
    for (let hi = 0; hi < f.hunks.length; hi++) {
      const hunk = f.hunks[hi]!;
      if (!hunk.anchor.length) { errors.push(`第 ${hi + 1} 块：锚定块为空（至少一行上下文或 - 行）`); continue; }
      let at = -1; let mode: 0 | 1 | 2 = 0;
      for (let m = 0; m <= 2 && at < 0; m++) {
        mode = m as 0 | 1 | 2;
        for (let i = 0; i + hunk.anchor.length <= fileLines.length; i++) {
          if (blockMatches(fileLines, i, hunk.anchor, mode)) { at = i; break; }
        }
      }
      if (at < 0) {
        const near = nearestLine(fileLines, hunk.anchor[0]!);
        errors.push(`第 ${hi + 1} 块：未匹配到锚定块（起始「${hunk.anchor[0]!.slice(0, 40)}」）${near ? `——最相似行（第 ${near.index + 1} 行）：${near.line.slice(0, 60)}` : ''}`);
        continue;
      }
      // 计数匹配处（唯一性提示——多处匹配要求更精确的上下文）
      let count = 0;
      for (let i = 0; i + hunk.anchor.length <= fileLines.length; i++) {
        if (blockMatches(fileLines, i, hunk.anchor, mode)) { count++; if (count > 1) break; }
      }
      if (count > 1) {
        errors.push(`第 ${hi + 1} 块：锚定块匹配 ${count} 处——上下文需更精确（包含更多独有行）`);
        continue;
      }
      edits.push({ at, remove: hunk.anchor.length, insert: hunk.replacement.join(eol) });
    }
    if (errors.length) {
      return { ok: false, text: `apply_patch 失败（${rel}，${errors.length}/${f.hunks.length} 块）：\n${errors.map(e => `  - ${e}`).join('\n')}\n未写入任何文件（全量校验失败，文件保持原样）` };
    }
    // 按位置倒序应用（前移不影响后续偏移）
    const afterLines = [...fileLines];
    for (const e of edits.sort((a, b) => b.at - a.at)) {
      const insertLines = e.insert.length ? e.insert.split(/\r?\n/) : [];
      afterLines.splice(e.at, e.remove, ...insertLines);
    }
    plan.push({ file: f, abs, before, after: afterLines.join(eol), details: [`${edits.length} 块应用`] });
  }

  // 全量校验通过 → 落盘（每个文件先 undoShadows 快照）
  const { snapshotFile } = await import('./undoShadows.js');
  const done: string[] = [];
  for (const p of plan) {
    try {
      if (p.before !== null) snapshotFile(opts.dataDir, p.abs, p.before);
      const dir = dirname(p.abs);
      if (p.file.action === 'delete') unlinkSync(p.abs);
      else if (p.file.action === 'move') renameSync(p.abs, p.toAbs!);
      else {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(dir, { recursive: true });
        writeFileSync(p.abs, p.after!, 'utf8');
      }
      done.push(`${p.file.action === 'add' ? '新增' : p.file.action === 'delete' ? '删除' : p.file.action === 'move' ? '移动' : '更新'} ${p.file.path}${p.file.action === 'move' ? ` → ${p.file.toPath}` : ''}（${p.details.join('；')}）`);
    } catch (e: any) {
      // 部分写入失败：诚实报告已写入清单（绝不假装原子成功）
      return { ok: false, text: `apply_patch 部分失败：${p.file.path} 写入异常（${String(e?.message ?? e).slice(0, 120)}）\n已写入：${done.length ? done.join('；') : '（无）'}\n可用 /undo fs 回滚已写入文件` };
    }
  }
  return { ok: true, text: `apply_patch 完成（${done.length} 个文件，校验全通过后写入）：\n${done.map(d => `  ✓ ${d}`).join('\n')}` };
}
