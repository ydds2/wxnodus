// tests/kernel-tools.test.ts — cron_create 工具（Claude Code CronCreate 对齐）
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { coreTools } from '../src/kernel/tools.js';
import { openDB, closeDB } from '../src/store/db.js';

describe('cron_create 工具', () => {
  it('真实写入 cron_jobs 表并返回任务 ID；参数校验拒绝非法输入', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-cron-'));
    const db = openDB(d);
    try {
      const tools = coreTools();
      const t = tools.cron_create!;
      // 参数校验
      expect(await t.run({ intervalMinutes: 0, action: 'x' }, { db } as any)).toContain('参数错误');
      expect(await t.run({ intervalMinutes: 5, action: '' }, { db } as any)).toContain('参数错误');
      // 真实创建
      const out = await t.run({ intervalMinutes: 30, action: '检查依赖更新并报告' }, { db } as any);
      expect(out).toMatch(/定时任务已创建 #\d+/);
      const rows = db.prepare(`SELECT schedule, action, enabled FROM cron_jobs`).all() as Array<{ schedule: string; action: string; enabled: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ schedule: 'every 30m', action: '检查依赖更新并报告', enabled: 1 });
      // 无 db → 明确不可用提示
      expect(await t.run({ intervalMinutes: 5, action: 'x' }, {} as any)).toContain('不可用');
    } finally {
      closeDB(db);
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── P0 建议落地：find_files / memory_search 工具 ──
describe('find_files 文件搜索', () => {
  it('glob 匹配 + 跳过黑名单目录', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-ff-'));
    try {
      mkdirSync(join(d, 'src'), { recursive: true });
      mkdirSync(join(d, 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(d, 'dist'), { recursive: true });
      writeFileSync(join(d, 'src', 'a.test.ts'), 'x');
      writeFileSync(join(d, 'src', 'b.ts'), 'x');
      writeFileSync(join(d, 'config.json'), '{}');
      writeFileSync(join(d, 'node_modules', 'pkg', 'x.test.ts'), 'x');
      writeFileSync(join(d, 'dist', 'y.test.ts'), 'x');
      const t = coreTools().find_files!;
      const out1 = await t.run({ pattern: '*.test.ts' }, { cwd: d } as any);
      expect(out1).toContain('a.test.ts');
      expect(out1).not.toContain('x.test.ts'); // node_modules 跳过
      expect(out1).not.toContain('y.test.ts'); // dist 跳过
      const out2 = await t.run({ pattern: 'config.json' }, { cwd: d } as any);
      expect(out2).toContain('config.json');
      const out3 = await t.run({ pattern: 'nope*' }, { cwd: d } as any);
      expect(out3).toContain('未找到');
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
});

describe('memory_search 黑洞检索', () => {
  it('modern 显式记忆记录检索（真实 DB，session scope）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { openMemoryRepository } = await import('../src/infrastructure/sqlite/memoryRepository.js');
    const { createMemoryService } = await import('../src/application/memoryService.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-ms-'));
    const db = openDB(d);
    try {
      const svc = createMemoryService(openMemoryRepository(db, { now: () => Date.now(), idFactory: p => `${p}-${Date.now()}` }), { sessionId: 's1' });
      const append = (role: 'user' | 'assistant', content: string) => svc.append({
        role, content, salience: 0.5, retention: { class: 'session', retainUntil: null },
        provenance: { sourceType: 'conversation', sourceId: 's1', sourceUri: undefined, capturedAt: new Date().toISOString(), actorId: 's1', correlationId: 't', policySnapshotId: 't', sourceTrust: 1 },
      });
      append('user', '我们讨论了黑洞引擎的 FTS5 bigram 分词方案');
      append('assistant', '结论：bigram 滑窗对中文检索有效');
      const t = coreTools().memory_search!;
      const out = await t.run({ query: 'bigram 分词' }, { db, sessionId: 's1' } as any);
      expect(out).toContain('历史记忆命中');
      expect(out).toContain('bigram');
      const out2 = await t.run({ query: '不存在的关键词xyz' }, { db, sessionId: 's1' } as any);
      expect(out2).toContain('未检索到');
    } finally { closeDB(db); try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it('超长记忆条目截断标注（共 N 字——模型知道有剩余）', async () => {
    const { coreTools } = await import('../src/kernel/tools.js');
    const { openDB, closeDB } = await import('../src/store/db.js');
    const { openMemoryRepository } = await import('../src/infrastructure/sqlite/memoryRepository.js');
    const { createMemoryService } = await import('../src/application/memoryService.js');
    const d = mkdtempSync(join(tmpdir(), 'wx-ms2-'));
    const db = openDB(d);
    try {
      const svc = createMemoryService(openMemoryRepository(db, { now: () => Date.now(), idFactory: p => `${p}-${Date.now()}` }), { sessionId: 's1' });
      const tag = `超长条目${Date.now()}`;
      svc.append({
        role: 'assistant', content: `${tag}：${'细节'.repeat(200)}`, salience: 0.5,
        retention: { class: 'session', retainUntil: null },
        provenance: { sourceType: 'conversation', sourceId: 's1', sourceUri: undefined, capturedAt: new Date().toISOString(), actorId: 's1', correlationId: 't', policySnapshotId: 't', sourceTrust: 1 },
      });
      const t = coreTools().memory_search!;
      const out = await t.run({ query: tag }, { db, sessionId: 's1' } as any);
      expect(out).toContain('已截断');
      expect(out).toContain('共 ' + (`${tag}：${'细节'.repeat(200)}`).length + ' 字');
    } finally { closeDB(db); try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
});

// ── P0-2 巩固：memory_write 写入黑洞（不再写孤儿 md 文件）──
describe('memory_write 黑洞记忆闭环', () => {
  it('写入后 modern 权威层可检索（AI 记忆闭环不断裂）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-mw-'));
    const db = openDB(d);
    try {
      const { openMemoryRepository } = await import('../src/infrastructure/sqlite/memoryRepository.js');
      const { createMemoryService } = await import('../src/application/memoryService.js');
      const tools = coreTools();
      const t = tools.memory_write!;
      const tag = `闭环验证${Date.now()}`;
      const out = await t.run({ content: `${tag}：用户偏好 TypeScript 严格模式` }, { db, dataDir: d, sessionId: 's1' } as any);
      expect(out).toContain('已写入长期记忆');

      // 关键断言：写入内容能被 modern 权威层检索命中（此前写 md 文件永远召不回）
      const svc = createMemoryService(openMemoryRepository(db, { now: () => Date.now(), idFactory: p => `${p}-${Date.now()}` }), { sessionId: 's1' });
      const hits = svc.search({ text: tag, limit: 5 });
      expect(hits.ok).toBe(true);
      if (hits.ok) expect(hits.value.some(h => h.record.content.includes('TypeScript 严格模式'))).toBe(true);

      // 空内容拒绝
      expect(await t.run({ content: '   ' }, { db } as any)).toContain('记忆内容为空');
    } finally {
      closeDB(db);
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── 巩固：scaffold_build 采用 AI 传入结构化 spec（不丢弃）──
describe('scaffold_build 规格优先级', () => {
  it('AI 传入的 scaffold/acceptance 生效；非法模具 fail-closed（规则脑已移除）', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-sb-'));
    const db = openDB(d);
    try {
      const tools = coreTools();
      const t = tools.scaffold_build!;
      // AI 传入完整 spec → dry-run 输出应含自定义验收（此前被丢弃）
      const out = await t.run({
        spec: JSON.stringify({ title: '待办系统', summary: '做一个待办系统', scaffold: 'todo', acceptance: ['自定义验收A', '自定义验收B', '自定义验收C'] }),
        dry_run: true,
      }, { db, dataDir: d } as any);
      expect(out).toContain('自定义验收A');
      expect(out).toContain('模块：');

      // 非法模具（calculator 不在白名单）→ fail-closed 明确拒绝，绝不回退
      const out2 = await t.run({
        spec: JSON.stringify({ title: '计算器', summary: '做一个计算器', scaffold: 'calculator', acceptance: ['a', 'b', 'c'] }),
        dry_run: true,
      }, { db, dataDir: d } as any);
      expect(out2).toContain('scaffold_build 拒绝');
      expect(out2).toContain('scaffold 非法');
    } finally {
      closeDB(db);
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── 全方面：notify 通知工具（Codex 对齐）──
describe('notify 通知工具', () => {
  it('经事件总线发 system.notice；无 bus 时明确不可用', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-nt-'))
    const db = openDB(d)
    try {
      const tools = coreTools()
      const t = tools.notify!
      const emitted: string[] = []
      const bus = { emit: (type: string, e: any) => emitted.push(`${type}:${e?.text ?? ''}`) }
      expect(await t.run({ content: '构建完成' }, { db, bus } as any)).toBe('通知已发送')
      expect(emitted[0]).toContain('system.notice')
      expect(emitted[0]).toContain('构建完成')
      // 空内容拒绝；无 bus 明确提示
      expect(await t.run({ content: '  ' }, { db, bus } as any)).toContain('content 不能为空')
      expect(await t.run({ content: 'x' }, { db } as any)).toContain('通知通道不可用')
    } finally {
      closeDB(db)
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  })
})

describe('fs_edit 多处出现行号换算（O(n+k·log n) 防大文件卡顿）', () => {
  it('lineNumbersOf：索引 → 1-based 行号（含首行/末行边界）', async () => {
    const { lineNumbersOf } = await import('../src/kernel/tools.js');
    const content = 'a\nbb\nccc\ndddd';
    // pos: a=0, \n=1, b=2,3, \n=4, c=5,6,7, \n=8, d=9..
    expect(lineNumbersOf(content, [0, 2, 5, 9])).toEqual([1, 2, 3, 4]);
    expect(lineNumbersOf(content, [content.length - 1])).toEqual([4]); // 末字符仍在末行
    expect(lineNumbersOf('', [])).toEqual([]);
  });
});

// V4 P0-2：view_image 工作区边界——绝不允许越界读取本机图片外发视觉端点。
describe('view_image 工作区边界（P0-2）', () => {
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

  it('工作区内图片正常载入；工作区外相对/绝对路径均拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-viewimg-'));
    const parent = dirname(root);
    try {
      writeFileSync(join(root, 'in.png'), PNG_MAGIC);
      writeFileSync(join(parent, 'outside-p02.png'), PNG_MAGIC);
      const tools = coreTools();
      const vi = tools.view_image!;
      const ctx = { cwd: root } as any;

      // 工作区内：成功
      const ok = await vi.run({ path: 'in.png' }, ctx);
      expect(String(ok)).toContain('图片已载入');

      // 相对路径逃逸（../outside-p02.png）：拒绝并明示越界
      const rel = await vi.run({ path: '../outside-p02.png' }, ctx);
      expect(String(rel)).toMatch(/越界|WORKSPACE_|boundary|escape|outside/i);

      // 工作区外绝对路径：拒绝
      const abs = await vi.run({ path: join(parent, 'outside-p02.png') }, ctx);
      expect(String(abs)).toMatch(/越界|WORKSPACE_|boundary|escape|outside/i);

      // extractImages 同源：越界不附加（null），工作区内附加 image_url
      expect(await vi.extractImages!({ path: '../outside-p02.png' } as any, ctx)).toBeNull();
      const parts = await vi.extractImages!({ path: 'in.png' } as any, ctx);
      expect(Array.isArray(parts)).toBe(true);
      expect((parts as any[])[0]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY */ }
      try { rmSync(join(parent, 'outside-p02.png'), { force: true }); } catch { /* 同上 */ }
    }
  });
});

// V4 P0-5：ls/grep 工作区边界——绝不允许越权列目录/搜索工作区外文件。
describe('ls/grep 工作区边界（P0-5）', () => {
  it('工作区内正常；../ 与工作区外绝对路径均拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-lsgrep-'));
    const parent = dirname(root);
    try {
      writeFileSync(join(root, 'a.txt'), 'needle-here');
      const tools = coreTools();
      const ctx = { cwd: root } as any;

      // 工作区内正常
      expect(await tools.ls!.run({ path: '.' }, ctx)).toContain('a.txt');
      expect(await tools.grep!.run({ pattern: 'needle', path: '.' }, ctx)).toContain('a.txt');

      // 相对逃逸：拒绝并明示越界
      expect(await tools.ls!.run({ path: '..' }, ctx)).toMatch(/越界/);
      // 工作区外绝对路径（temp 根）：拒绝
      expect(await tools.ls!.run({ path: parent }, ctx)).toMatch(/越界/);
      expect(await tools.grep!.run({ pattern: 'x', path: parent }, ctx)).toMatch(/越界/);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY */ }
    }
  });
});

// V4 P0-8：fs_edit 行尾归一 + 三级容错 + 写回行尾保真（Windows 编辑最高频失败点根治）。
describe('fs_edit 容错匹配与行尾保真（P0-8）', () => {
  it('CRLF 文件 + LF oldText：匹配成功且写回保持 CRLF', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-fsedit-'));
    try {
      const file = join(root, 'crlf.ts');
      writeFileSync(file, 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n', 'utf8');
      const tools = coreTools();
      const r = await tools.fs_edit!.run({ path: 'crlf.ts', oldText: 'const b = 2;\n', newText: 'const b = 22;\n' }, { cwd: root } as any);
      expect(String(r)).toContain('已替换');
      const after = readFileSync(file, 'utf8');
      expect(after).toBe('const a = 1;\r\nconst b = 22;\r\nconst c = 3;\r\n'); // 行尾保真（不整体翻 LF）
    } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY */ } }
  });
  it('尾空白漂移（trimEnd 降级）与缩进漂移（reindent 降级）均匹配成功', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-fsedit2-'));
    try {
      const file = join(root, 'drift.ts');
      writeFileSync(file, 'function main() {\n  call();   \n}\n', 'utf8'); // 行尾多空格
      const tools = coreTools();
      const r1 = await tools.fs_edit!.run({ path: 'drift.ts', oldText: '  call();\n', newText: '  call2();\n' }, { cwd: root } as any);
      expect(String(r1)).toContain('已替换');
      expect(readFileSync(file, 'utf8')).toBe('function main() {\n  call2();\n}\n');
      // 缩进漂移：文件 2 空格、模型给 4 空格
      writeFileSync(file, 'if (x) {\n  doWork();\n}\n', 'utf8');
      const r2 = await tools.fs_edit!.run({ path: 'drift.ts', oldText: '    doWork();\n', newText: '    doWork2();\n' }, { cwd: root } as any);
      expect(String(r2)).toContain('已替换');
      expect(readFileSync(file, 'utf8')).toBe('if (x) {\n  doWork2();\n}\n');
    } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY */ } }
  });
  it('精确唯一性语义不回归：多处出现仍拒绝；真正不存在给出未找到', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-fsedit3-'));
    try {
      const file = join(root, 'multi.ts');
      writeFileSync(file, 'x = 1;\nx = 1;\n', 'utf8');
      const tools = coreTools();
      const dup = await tools.fs_edit!.run({ path: 'multi.ts', oldText: 'x = 1;', newText: 'x = 2;' }, { cwd: root } as any);
      expect(String(dup)).toMatch(/出现 2 处/);
      const none = await tools.fs_edit!.run({ path: 'multi.ts', oldText: 'totally-absent-text', newText: 'y' }, { cwd: root } as any);
      expect(String(none)).toMatch(/未找到/);
    } finally { try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY */ } }
  });
});
