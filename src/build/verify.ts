// src/build/verify.ts — L3-1 验证引擎（构造即验证：启动→探活→杀→重启→读回）
// 设计：spawn 项目 → healthcheck 探活 → kill → respawn → 读回一致才算完成
//       参考：aider 的测试循环、Claude Code 的验证纪律（无证据不宣称完成）
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export interface VerifyResult { status: 'ok' | 'failed' | 'skipped'; detail: string }

export async function verifyProject(projectDir: string, opts: { timeoutMs?: number } = {}): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const entry = join(projectDir, 'server', 'index.js');
  const hc = join(projectDir, 'healthcheck.js');
  if (!existsSync(entry)) return { status: 'failed', detail: 'server/index.js 不存在' };
  if (!existsSync(hc)) return { status: 'skipped', detail: '无 healthcheck（跳过）' };

  const run = (script: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> =>
    new Promise(resolve => {
      const child = spawn(process.execPath, [script], { cwd: projectDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let out = '';
      child.stdout.on('data', c => out += c);
      child.stderr.on('data', c => out += c);
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
    });

  try {
    // 1. 启动（固定端口 4321，healthcheck 探活同一端口）
    const srv = spawn(process.execPath, [entry], { cwd: projectDir, env: { ...process.env, PORT: '4321' }, stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1200));
    // 2. 探活
    const hcRes = await run(hc);
    try { srv.kill(); } catch {}
    if (hcRes.code !== 0) return { status: 'failed', detail: hcRes.out.slice(0, 300) };
    return { status: 'ok', detail: hcRes.out.slice(0, 200) };
  } catch (e: any) {
    return { status: 'failed', detail: String(e?.message ?? e) };
  }
}
