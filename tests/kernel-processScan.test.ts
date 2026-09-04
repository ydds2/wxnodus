// tests/kernel-processScan.test.ts — B1/B3（2026-09-04）：进程枚举与孤儿分类纯函数契约
// 真机采集（listProcesses → PowerShell/ps）由 CLI 进程级用例与实机证据覆盖；此处锁定解析/分类语义。
import { describe, it, expect } from 'vitest';
import {
  parseWin32ProcessJson, parsePosixPsOutput, descendantsOf, ancestorsOf,
  classifyOrphanProcesses, formatMemBytes, type ProcessInfo,
} from '../src/kernel/processScan.js';

const P = (pid: number, ppid: number, cmdline = '', name = 'node.exe'): ProcessInfo => ({ pid, ppid, name, cmdline });

describe('parseWin32ProcessJson', () => {
  it('{procs:[…]} 包裹形态解析（PS5.1 空数组安全契约）', () => {
    const out = parseWin32ProcessJson(JSON.stringify({
      procs: [
        { ProcessId: 1, ParentProcessId: 0, Name: 'node.exe', CommandLine: 'x', WorkingSetSize: 2048 },
        { ProcessId: 2, ParentProcessId: 1, Name: 'cmd.exe', CommandLine: null, WorkingSetSize: null },
      ],
    }));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ pid: 1, ppid: 0, name: 'node.exe', cmdline: 'x', workingSetBytes: 2048 });
    expect(out[1]!.workingSetBytes).toBeUndefined();
  });
  it('裸数组/坏条目/坏 JSON 容忍', () => {
    expect(parseWin32ProcessJson(JSON.stringify([{ ProcessId: 7, ParentProcessId: 1, Name: 'a.exe' }]))[0]!.pid).toBe(7);
    expect(parseWin32ProcessJson(JSON.stringify({ procs: [{ junk: 1 }, 'str', { ProcessId: 'x' }] }))).toEqual([]);
    expect(parseWin32ProcessJson('not json{{')).toEqual([]);
  });
});

describe('parsePosixPsOutput', () => {
  it('pid ppid rss_kb args 解析（rss ×1024 → 字节）', () => {
    const out = parsePosixPsOutput('  123   45  10240  node cli.js\nbad line\n  9  1  0  [kthreadd]');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ pid: 123, ppid: 45, name: '', cmdline: 'node cli.js', workingSetBytes: 10240 * 1024 });
  });
});

describe('进程树辅助', () => {
  it('descendantsOf：ppid 链 BFS 全子孙', () => {
    const procs = [P(1, 0), P(2, 1), P(3, 1), P(4, 2), P(5, 9)];
    expect(descendantsOf(procs, 1).map(p => p.pid).sort()).toEqual([2, 3, 4]);
    expect(descendantsOf(procs, 9).map(p => p.pid)).toEqual([5]);
    expect(descendantsOf(procs, 99)).toEqual([]);
  });
  it('ancestorsOf：向上血统含自身', () => {
    const procs = [P(1, 0), P(2, 1), P(3, 2)];
    expect([...ancestorsOf(procs, 3)].sort()).toEqual([1, 2, 3]);
  });
});

describe('classifyOrphanProcesses：8/30 事故特征', () => {
  it('匹配 wxnodus 实例与 tmp-n 探针；排除自身/祖先/低 pid', () => {
    const procs = [
      P(0, 0, '', 'Idle'),
      P(100, 1, 'node tmp-n2-probe-abc'),            // ZCode 探针孤儿
      P(200, 1, 'node ...\\node_modules\\wxnodus\\dist\\cli\\index.js'), // 另一 wxnodus 实例
      P(300, 1, 'node ...\\wxnodus4.0\\node_modules\\vitest\\x.js'),      // 仓库路径不含独立词——不误报
      P(400, 1, 'node ordinary.js'),                 // 无关进程
    ];
    const orphans = classifyOrphanProcesses(procs, 999).map(p => p.pid).sort();
    expect(orphans).toEqual([100, 200]);
    // 自身与祖先豁免（999 → 200 血统时 200 不入围）
    const procs2 = [P(999, 200), P(200, 1, 'node wxnodus\\cli\\index.js')];
    expect(classifyOrphanProcesses(procs2, 999)).toEqual([]);
  });
});

describe('formatMemBytes', () => {
  it('展示口径：MB/KB/缺失', () => {
    expect(formatMemBytes(45 * 1024 * 1024)).toBe('45.0MB');
    expect(formatMemBytes(512 * 1024)).toBe('512KB');
    expect(formatMemBytes(undefined)).toBe('—');
    expect(formatMemBytes(0)).toBe('—');
  });
});
