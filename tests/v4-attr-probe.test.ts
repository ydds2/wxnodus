// tests/v4-attr-probe.test.ts — V4 P1-7：属性探测税废除（attrib + LRU + 读类豁免）
// ① attrib 替代 powershell：+H/+S 文件命中、普通文件 plain（win32 真实 attrib）
// ② path+mtime LRU：同文件二次调用零 spawn（attrProbeStats.spawnCount 断言）
// ③ 读类工具豁免：classifyPipelineArgs 传只读 toolId 时跳过属性探测
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyWindowsPath, classifyPipelineArgs, attrProbeStats } from '../src/infrastructure/fs/windowsPathClassifier.js';

describe('V4 P1-7 属性探测（attrib + LRU）', { skip: process.platform !== 'win32' }, () => {
  let dir: string;
  // fixture 放仓库 .tmp（非 AppData——tmp 目录会被第 1 层如实判 user-appdata，非本卡对象）
  beforeAll(() => { mkdirSync(join(process.cwd(), '.tmp'), { recursive: true }); dir = mkdtempSync(join(process.cwd(), '.tmp', 'wx-attr-')); });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('attrib 真实探测：+H 文件 → hidden-or-system-attribute；普通文件 → workspace/plain', () => {
    const hidden = join(dir, 'h.txt');
    const plain = join(dir, 'p.txt');
    writeFileSync(hidden, 'x'); writeFileSync(plain, 'x');
    execFileSync('attrib', ['+H', hidden]);
    const rH = classifyWindowsPath(hidden, { workspaceRoot: dir });
    expect(rH.class).toBe('hidden-or-system-attribute');
    const rP = classifyWindowsPath(plain, { workspaceRoot: dir });
    expect(rP.class).toBe('workspace');
  });

  it('LRU 零 spawn 基准：同文件（mtime 不变）二次调用 spawnCount 不增', () => {
    const f = join(dir, 'cached.txt');
    writeFileSync(f, 'x');
    const before = attrProbeStats.spawnCount;
    const r1 = classifyWindowsPath(f, { workspaceRoot: dir });
    const mid = attrProbeStats.spawnCount;
    expect(mid).toBe(before + 1);      // 首次真实探测 1 次
    const r2 = classifyWindowsPath(f, { workspaceRoot: dir });
    expect(attrProbeStats.spawnCount).toBe(mid); // 二次命中缓存零 spawn
    expect(r1.class).toBe(r2.class);
    // mtime 变化 → 键失效 → 重新探测（缓存正确性）
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    classifyWindowsPath(f, { workspaceRoot: dir });
    expect(attrProbeStats.spawnCount).toBe(mid + 1);
  });

  it('读类工具豁免：fs_read 的 path 探测零属性 spawn（写类仍探测）', () => {
    const f = join(dir, 'ro.txt');
    writeFileSync(f, 'x');
    const before = attrProbeStats.spawnCount;
    // 只读工具：系统目录/reparse 判定照走，属性层跳过
    classifyPipelineArgs({ path: f }, dir, { toolId: 'agent:fs_read' });
    expect(attrProbeStats.spawnCount).toBe(before); // 零属性 spawn
    // 写类工具：属性层启用
    classifyPipelineArgs({ path: f }, dir, { toolId: 'agent:fs_write' });
    expect(attrProbeStats.spawnCount).toBe(before + 1);
  });
});
