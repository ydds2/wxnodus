// tests/gaps.test.ts — L6-3 差距补齐：/undo checkpoint/审批预审/stream-json/@引用匹配
// （vim 薄层已作为未接线死代码移除，见 audit §13.39——差距 #1 以「无宣称不保留」方式关闭）
import { describe, it, expect } from 'vitest';
import { openDB, closeDB, saveCheckpoint, restoreCheckpoint } from '../src/store/db.js';
import { createAutoReview } from '../src/kernel/autoReview.js';
import { resolveAtRefs } from '../src/wxnodus-ui/lib/atRefs.js';
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
