// tests/kernel-apply-patch.test.ts — apply_patch 结构化多文件补丁（gap P0-3）
// 覆盖：解析（语法错误带行号/杂质容忍/护栏上限）、三级匹配容错、全量校验后才落盘
// （失败绝不写一半）、多处匹配报错、did_you_mean、undoShadows 快照、CRLF 保留、Move/Delete
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePatch, applyPatch, nearestLine } from '../src/kernel/applyPatch.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-patch-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe('parsePatch 语法', () => {
  it('解析 Add/Update/Delete/Move 四动作', () => {
    const r = parsePatch(wrap([
      '*** Add File: src/a.ts',
      '+export const a = 1;',
      '*** Update File: src/b.ts',
      '@@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
      '*** Delete File: src/c.ts',
      '*** Move File: src/d.ts',
      '*** To File: src/e.ts',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.files.map(f => f.action)).toEqual(['add', 'update', 'delete', 'move']);
    expect(r.doc.files[0]!.content).toEqual(['export const a = 1;']);
    expect(r.doc.files[1]!.hunks).toHaveLength(1);
    expect(r.doc.files[1]!.hunks[0]!.anchor).toEqual([' const x = 1;', 'const y = 2;']);
    expect(r.doc.files[1]!.hunks[0]!.replacement).toEqual([' const x = 1;', 'const y = 3;']);
    expect(r.doc.files[3]!.toPath).toBe('src/e.ts');
  });

  it('Begin 之前杂质行容忍（模型常带说明文字）', () => {
    const r = parsePatch('说明文字\n*** Begin Patch\n*** Add File: x\n+1\n*** End Patch');
    expect(r.ok).toBe(true);
  });

  it('缺 Begin Patch / 空补丁 / Move 缺 To 均报错', () => {
    expect(parsePatch('*** Add File: x\n+1').ok).toBe(false);
    expect(parsePatch('*** Begin Patch\n*** End Patch').ok).toBe(false);
    expect(parsePatch(wrap('*** Move File: a')).ok).toBe(false);
  });

  it('Update 缺 @@ / Add 行非 + 前缀 / 未知指令 → 错误带行号', () => {
    const r = parsePatch(wrap('*** Update File: a\n-x\n+x'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('@@');
    const r2 = parsePatch(wrap('*** Add File: a\nplain'));
    expect(r2.ok).toBe(false);
    const r3 = parsePatch(wrap('*** Frolic File: a'));
    expect(r3.ok).toBe(false);
  });
});

describe('applyPatch 落盘语义', () => {
  it('多文件更新：全量校验通过后写入，内容正确', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n', 'utf8');
    writeFileSync(join(dir, 'b.ts'), 'export const keep = true;\n', 'utf8');
    const r = await applyPatch(wrap([
      '*** Update File: a.ts',
      '@@',
      'const x = 1;',
      '-const y = 2;',
      '+const y = 22;',
      '*** Update File: b.ts',
      '@@',
      'export const keep = true;',
      '+export const added = false;',
      '*** Add File: c.ts',
      '+export const c = 3;',
    ].join('\n')), { cwd: dir, dataDir: dir });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('const x = 1;\nconst y = 22;\nconst z = 3;\n');
    expect(readFileSync(join(dir, 'b.ts'), 'utf8')).toBe('export const keep = true;\nexport const added = false;\n');
    expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toBe('export const c = 3;');
  });

  it('退化容错：ctx 与 - 行完全相同 → 精确折叠为该行替换', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const y = 2;\nconst keep = 1;\n', 'utf8');
    const r = await applyPatch(wrap([
      '*** Update File: a.ts',
      '@@',
      'const y = 2;',
      '-const y = 2;',
      '+const y = 3;',
    ].join('\n')), { cwd: dir, dataDir: dir });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('const y = 3;\nconst keep = 1;\n');
  });

  it('任一块失败 → 不写任何文件（绝不写一半）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'alpha\n', 'utf8');
    writeFileSync(join(dir, 'b.ts'), 'bravo\n', 'utf8');
    const r = await applyPatch(wrap([
      '*** Update File: a.ts',
      '@@',
      'alpha',
      '-alpha',
      '+ALPHA',
      '*** Update File: b.ts',
      '@@',
      'bravo',
      '-不存在的行',
      '+x',
    ].join('\n')), { cwd: dir, dataDir: dir });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('未写入任何文件');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('alpha\n'); // 原样
    expect(readFileSync(join(dir, 'b.ts'), 'utf8')).toBe('bravo\n');
  });

  it('匹配容错：行尾空白差异与重缩进均命中（aider 语义）', async () => {
    // 行尾空白差异（文件行无尾空白、补丁 ctx 行有）——mode 1（lineTrimmed）
    writeFileSync(join(dir, 'a.ts'), '  const x = 1;\nconst y = 2;\n', 'utf8');
    const r1 = await applyPatch(wrap(['*** Update File: a.ts', '@@', '  const x = 1;  ', '-const y = 2;', '+const y = 22;'].join('\n')), { cwd: dir, dataDir: dir });
    expect(r1.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('  const x = 1;  \nconst y = 22;\n');
    // 重缩进差异（补丁行缩进与文件不同）——mode 2（reindent）；ctx==minus 折叠后单行锚定
    writeFileSync(join(dir, 'a.ts'), '  const z = 1;\n', 'utf8');
    const r2 = await applyPatch(wrap(['*** Update File: a.ts', '@@', '    const z = 1;', '-    const z = 1;', '+const z = 2;'].join('\n')), { cwd: dir, dataDir: dir });
    expect(r2.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('const z = 2;\n');
  });

  it('多处匹配 → 报错要求更精确上下文（含相似行 did_you_mean）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'foo();\nbar();\nfoo();\nbar();\n', 'utf8');
    const r = await applyPatch(wrap(['*** Update File: a.ts', '@@', 'foo();', '-bar();', '+baz();'].join('\n')), { cwd: dir, dataDir: dir });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('匹配 2 处');
    // did_you_mean：锚定完全缺失时给出最相似行
    const r2 = await applyPatch(wrap(['*** Update File: a.ts', '@@', 'foo();', '-fooo();', '+x();'].join('\n')), { cwd: dir, dataDir: dir });
    expect(r2.ok).toBe(false);
    expect(r2.text).toContain('最相似行');
  });

  it('Delete/Move + 快照落盘（/undo fs 可回滚）', async () => {
    writeFileSync(join(dir, 'del.ts'), 'old\n', 'utf8');
    writeFileSync(join(dir, 'mv.ts'), 'move me\n', 'utf8');
    const r = await applyPatch(wrap([
      '*** Delete File: del.ts',
      '*** Move File: mv.ts',
      '*** To File: renamed.ts',
    ].join('\n')), { cwd: dir, dataDir: dir });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'del.ts'))).toBe(false);
    expect(existsSync(join(dir, 'renamed.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'renamed.ts'), 'utf8')).toBe('move me\n');
    // undoShadows 快照（改/删前备份）
    const shadow = join(dir, 'undo-shadows');
    expect(existsSync(shadow)).toBe(true);
    const files = readdirSync(shadow);
    expect(files.length).toBeGreaterThan(0);
  });

  it('Add 覆盖已存在文件 → 拒绝（提示用 Update）', async () => {
    writeFileSync(join(dir, 'a.ts'), 'x\n', 'utf8');
    const r = await applyPatch(wrap('*** Add File: a.ts\n+y'), { cwd: dir, dataDir: dir });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('已存在');
  });

  it('路径逃逸工作区 → 拒绝', async () => {
    const r = await applyPatch(wrap('*** Add File: ../outside.ts\n+x'), { cwd: dir, dataDir: dir });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('超出工作区');
  });

  it('CRLF 文件编辑后保留 CRLF', async () => {
    writeFileSync(join(dir, 'a.ts'), 'one\r\ntwo\r\nthree\r\n', 'utf8');
    const r = await applyPatch(wrap(['*** Update File: a.ts', '@@', 'two', '-two', '+TWO'].join('\n')), { cwd: dir, dataDir: dir });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('one\r\nTWO\r\nthree\r\n');
  });
});

describe('nearestLine（纯函数）', () => {
  it('返回与目标行最相似的行', () => {
    const n = nearestLine(['const x = 1;', 'const y = 22;', 'zzz'], 'const y = 2;');
    expect(n?.index).toBe(1);
    expect(n?.line).toBe('const y = 22;');
  });
});
