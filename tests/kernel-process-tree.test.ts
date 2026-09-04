// tests/kernel-process-tree.test.ts — B2（2026-09-04 第三批）：进程树终止单一事实源 + bash 三路径全树回收
// 验收（master plan B2）：中断/超时后孙进程零残留——修复前 spawn({signal}) 只单杀 powershell
// 直接子进程，孙进程树（bash→node→worker）泄漏成孤儿（8/30 事故族）。
// 真机契约：真实 powershell + 真实 node 孙进程 + 真实 taskkill——不 mock 进程语义。
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../src/kernel/processTree.js';
import { coreTools } from '../src/kernel/tools.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** 孙进程夹具：落自身 pid + 每 150ms 追加心跳（零 stdout——不干扰空闲计时语义） */
function writeGrandchildFixture(d: string): { script: string; pidFile: string; beatFile: string } {
  const pidFile = join(d, 'grand.pid');
  const beatFile = join(d, 'beat.log');
  const script = join(d, 'grand.js');
  writeFileSync(script, [
    `const fs = require('fs');`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `setInterval(() => { try { fs.appendFileSync(${JSON.stringify(beatFile)}, 'x'); } catch {} }, 150);`,
    `setInterval(() => {}, 1 << 30); // 保活（空事件环——心跳之外的哨兵）`,
  ].join('\n'), 'utf8');
  return { script, pidFile, beatFile };
}

/** 等孙进程就位（pid 文件出现）——超时如实失败 */
async function waitGrandchild(pidFile: string, ms = 8_000): Promise<number> {
  for (let i = 0; i < ms / 100 && !existsSync(pidFile); i++) await sleep(100);
  expect(existsSync(pidFile), '孙进程未在预算内落 pid（夹具失效）').toBe(true);
  return Number(readFileSync(pidFile, 'utf8'));
}

/** 零残留断言：孙进程死 + 心跳停止增长 */
async function assertZeroResidue(pid: number, beatFile: string): Promise<void> {
  await sleep(1_500); // 给树杀落地
  expect(isAlive(pid), `孙进程 ${pid} 仍存活——树终止失效（孤儿复现）`).toBe(false);
  const s1 = existsSync(beatFile) ? statSync(beatFile).size : 0;
  await sleep(500);
  const s2 = existsSync(beatFile) ? statSync(beatFile).size : 0;
  expect(s2, '心跳仍在增长——孙进程仍在运行').toBe(s1);
}

describe('killProcessTree 单一事实源（processTree.ts）', () => {
  it('已退出的 pid → 诚实「已不在」（目标态达成，不假装报错）', async () => {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); // 立即退出
    const pid = dead.pid!;
    await new Promise<void>(r => dead.once('close', () => r()));
    const r = await killProcessTree(pid);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/已不在|已终止/);
  }, 10_000);

  it('非法 pid → fail-closed false', async () => {
    expect((await killProcessTree(0)).ok).toBe(false);
    expect((await killProcessTree(-1)).ok).toBe(false);
    expect((await killProcessTree(Number.NaN)).ok).toBe(false);
  });
});

describe('B2 验收：bash 三路径全树回收（孙进程零残留）', () => {
  it('用户中止（ctx.signal abort）→ 孙进程零残留', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-b2-abort-'));
    try {
      const { script, pidFile, beatFile } = writeGrandchildFixture(d);
      const ac = new AbortController();
      const p = coreTools().bash!.run({ command: `node "${script}"`, timeout_ms: 60_000 }, { cwd: d, dataDir: d, signal: ac.signal } as never);
      const grandPid = await waitGrandchild(pidFile);
      expect(isAlive(grandPid)).toBe(true); // 场景成立性：中止前孙进程确实在跑
      await sleep(400);
      ac.abort();
      const out = await p; // 工具层把失败转为结果文本回喂模型（设计语义——非 reject）
      expect(out).toContain('已中断（用户中止）');
      await assertZeroResidue(grandPid, beatFile);
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* EBUSY */ } }
  }, 30_000);

  it('静默空闲超时（idle 路径）→ 孙进程零残留', async () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-b2-idle-'));
    try {
      const { script, pidFile, beatFile } = writeGrandchildFixture(d);
      // 孙进程零 stdout → powershell 静默 → 1500ms 空闲超时触发 idleAc.abort → 全树杀
      const p = coreTools().bash!.run({ command: `node "${script}"`, timeout_ms: 1_500 }, { cwd: d, dataDir: d } as never);
      const grandPid = await waitGrandchild(pidFile);
      const out = await p; // 失败转结果文本（同上）
      expect(out).toContain('超时');
      await assertZeroResidue(grandPid, beatFile);
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch { /* EBUSY */ } }
  }, 30_000);
});
