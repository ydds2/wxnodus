// tests/kernel-scripts.test.ts — 可执行剧本：保存/加载/列表/删除/统计
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listScripts, loadScript, saveScript, deleteScript, isValidScriptName, scriptStats, type Script } from '../src/kernel/scripts.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-scr-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const sample = (name = 'deploy'): Script => ({
  name,
  description: '发布流程',
  created_at: 1700000000000,
  steps: [
    { prompt: '帮我发布', tools: [{ name: 'bash', args: { command: 'npm run build' } }, { name: 'fs_read', args: { path: 'dist/index.js' } }] },
    { prompt: '检查版本', tools: [{ name: 'bash', args: { command: 'node --version' } }] },
  ],
});

describe('剧本存储', () => {
  it('保存 → 加载 → 列表 → 统计全链路', () => {
    const d = tmp();
    expect(saveScript(d, sample())).toBe(true);
    const loaded = loadScript(d, 'deploy');
    expect(loaded).not.toBeNull();
    expect(loaded!.steps).toHaveLength(2);
    expect(loaded!.steps[0]!.tools[0]!.name).toBe('bash');
    const list = listScripts(d);
    expect(list).toHaveLength(1);
    const st = scriptStats(loaded!);
    expect(st.steps).toBe(2);
    expect(st.tools).toBe(3);
  });
  it('非法名拒绝（防路径穿越）', () => {
    const d = tmp();
    expect(isValidScriptName('../evil')).toBe(false);
    expect(isValidScriptName('a/b')).toBe(false);
    expect(saveScript(d, { ...sample('../evil'), name: '../evil' })).toBe(false);
    expect(loadScript(d, '../evil')).toBeNull();
  });
  it('删除存在/不存在', () => {
    const d = tmp();
    saveScript(d, sample());
    expect(deleteScript(d, 'deploy')).toBe(true);
    expect(existsSync(join(d, 'scripts', 'deploy.json'))).toBe(false);
    expect(deleteScript(d, 'deploy')).toBe(false);
  });
  it('损坏文件跳过（列表容错）', () => {
    const d = tmp();
    saveScript(d, sample());
    writeFileSync(join(d, 'scripts', 'bad.json'), '{broken', 'utf8');
    expect(listScripts(d)).toHaveLength(1);
  });
});
