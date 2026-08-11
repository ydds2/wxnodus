// tests/kernel-scripts.test.ts — 可执行剧本：保存/加载/列表/删除/统计
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listScripts, loadScript, saveScript, deleteScript, isValidScriptName, scriptStats, checkScriptExpectations, type Script } from '../src/kernel/scripts.js';
import { substituteVars } from '../src/kernel/agent.js';

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

describe('回放 CI 断言（checkScriptExpectations）', () => {
  it('step.expect 命中/未命中判定', () => {
    const script: Script = {
      name: 'ci', description: '', created_at: 0,
      steps: [
        { prompt: '检查', tools: [{ name: 'bash', args: { command: 'ls' } }], expect: ['package.json'] },
        { prompt: '构建', tools: [{ name: 'bash', args: { command: 'npm run build' } }], expect: ['构建成功'] },
      ],
    };
    const r = checkScriptExpectations(script, [
      { step: 0, tool: 'bash', out: 'package.json  README.md' },
      { step: 1, tool: 'bash', out: '构建失败：xxx' },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]!.ok).toBe(true);
    expect(r[1]!.ok).toBe(false);
    expect(r[1]!.detail).toContain('未包含');
  });
  it('全局 expect 与步骤输出合并检查', () => {
    const script: Script = {
      name: 'g', description: '', created_at: 0,
      steps: [{ prompt: '', tools: [{ name: 'bash', args: { command: 'echo hi' } }] }],
      expect: ['hi'],
    };
    const r = checkScriptExpectations(script, [{ step: 0, tool: 'bash', out: 'hi there' }]);
    expect(r).toHaveLength(1);
    expect(r[0]!.ok).toBe(true);
  });
  it('无断言 → 空结果（不误判）', () => {
    const script: Script = { name: 'n', description: '', created_at: 0, steps: [] };
    expect(checkScriptExpectations(script, [])).toEqual([]);
  });
});

describe('WxScript DSL（substituteVars 模板替换）', () => {
  it('{{item}} 递归替换 prompt/args/嵌套指令', () => {
    const steps = [
      { prompt: '处理 {{item}}', tools: [{ name: 'bash', args: { command: 'echo {{item}}' } }] },
      { loop: { items: ['x'], as: 'item', do: [{ prompt: '内层 {{item}}', tools: [{ name: 'ls', args: { path: '{{item}}' } }] }] } },
    ];
    const out = substituteVars(steps as any, 'item', 'alpha');
    expect((out[0] as any).prompt).toBe('处理 alpha');
    expect((out[0] as any).tools[0].args.command).toBe('echo alpha');
    expect((out[1] as any).loop.do[0].prompt).toBe('内层 alpha');
    expect((out[1] as any).loop.do[0].tools[0].args.path).toBe('alpha');
  });
  it('task/parallel 分支内替换', () => {
    const steps = [
      { task: { goal: '审查 {{item}}' } },
      { parallel: [{ prompt: '分支 {{item}}', tools: [] }] },
    ];
    const out = substituteVars(steps as any, 'item', 'z');
    expect((out[0] as any).task.goal).toBe('审查 z');
    expect((out[1] as any).parallel[0].prompt).toBe('分支 z');
  });
});
