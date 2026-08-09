// tests/gaps.test.ts — L6-3 差距补齐：/undo checkpoint/vim 薄层/审批预审/stream-json/@引用匹配
import { describe, it, expect } from 'vitest';
import { openDB, closeDB, saveCheckpoint, restoreCheckpoint } from '../src/store/db.js';
import { vimHandleKey } from '../src/ui/lib/vimKeys.js';
import { createAutoReview } from '../src/kernel/autoReview.js';
import { toStreamJson } from '../src/kernel/streamJson.js';
import { resolveAtRefs } from '../src/ui/lib/atRefs.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('checkpoint /undo（差距 #6）', () => {
  it('保存/恢复 + 上限 10', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-ck-'));
    const db = openDB(dir);
    for (let i = 0; i < 12; i++) saveCheckpoint(db, 's1', { n: i });
    const cnt = (db.prepare(`SELECT COUNT(*) c FROM checkpoints WHERE session_id='s1'`).get() as any).c;
    expect(cnt).toBeLessThanOrEqual(10);
    const restored = restoreCheckpoint(db, 's1') as any;
    expect(restored.n).toBeGreaterThanOrEqual(9);
    closeDB(db);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('vim 薄层（差距 #1）', () => {
  it('i 进入 insert，Esc 回 normal，x 删字符，dd 清行', () => {
    expect(vimHandleKey('i', { mode: 'normal', value: 'ab' }).mode).toBe('insert');
    const afterInsert = vimHandleKey('c', { mode: 'insert', value: 'ab', cursor: 2 });
    expect(afterInsert.value).toBe('abc');
    expect(vimHandleKey('escape', { ...afterInsert, mode: 'insert' }).mode).toBe('normal');
    expect(vimHandleKey('x', { mode: 'normal', value: 'ab', cursor: 1 }).value).toBe('a');
    const d1 = vimHandleKey('d', { mode: 'normal', value: 'hello' });
    expect(vimHandleKey('d', d1).value).toBe('');
  });
});

describe('AI 审批预审（差距 #8，默认关）', () => {
  it('关闭时一律 ask（不阻塞主流程）', async () => {
    const ar = createAutoReview(() => false, async () => 'allow');
    expect(await ar.review({ tool: 'bash', args: 'ls', cwd: '.' })).toBe('ask');
  });
  it('开启时 LLM 判定映射三态', async () => {
    const ar = createAutoReview(() => true, async (p) => p.includes('ls') ? 'allow' : 'deny');
    expect(await ar.review({ tool: 'bash', args: 'ls', cwd: '.' })).toBe('allow');
    expect(await ar.review({ tool: 'bash', args: 'rm -rf /', cwd: '.' })).toBe('deny');
  });
});

describe('stream-json（差距 #9，CI 友好）', () => {
  it('事件流序列化', () => {
    const lines = toStreamJson([
      { type: 'init', payload: { model: 'm' } },
      { type: 'message', payload: { delta: '你' } },
      { type: 'result', payload: { text: '你好' } },
    ]);
    const arr = lines.trim().split('\n').map(l => JSON.parse(l));
    expect(arr[0].type).toBe('init');
    expect(arr[1].type).toBe('message');
    expect(arr[2].type).toBe('result');
  });
});

describe('@ 文件引用（差距 #2）', () => {
  it('解析输入中的 @ 引用', () => {
    const r = resolveAtRefs('分析 @C:\\a.txt 的内容');
    expect(r.refs.length).toBe(1);
    expect(r.refs[0].path).toBe('C:\\a.txt');
    expect(r.remainder).toBe('分析 的内容');
  });
  it('无引用原样返回', () => {
    const r = resolveAtRefs('没有引用');
    expect(r.refs.length).toBe(0);
    expect(r.remainder).toBe('没有引用');
  });
});
