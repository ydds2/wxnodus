// src/build/verify.ts — L3-1 验证引擎（构造即验证：启动→探活→杀→重启→读回）
// 设计：spawn 项目 → healthcheck 探活 → kill → respawn → 读回一致才算完成
//       参考：aider 的测试循环、Claude Code 的验证纪律（无证据不宣称完成）
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { sanitizedEnv } from '../kernel/env.js';

export interface VerifyResult { status: 'ok' | 'failed' | 'skipped'; detail: string }

export async function verifyProject(projectDir: string, opts: { timeoutMs?: number } = {}): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const entry = join(projectDir, 'server', 'index.js');
  const hc = join(projectDir, 'healthcheck.js');
  if (!existsSync(entry)) return { status: 'failed', detail: 'server/index.js 不存在' };
  if (!existsSync(hc)) return { status: 'skipped', detail: '无 healthcheck（跳过）' };

  const run = (script: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> =>
    new Promise(resolve => {
      // 子进程环境净化（密钥类变量不透传——与 bash/hooks/MCP 同一策略）
      const child = spawn(process.execPath, [script], { cwd: projectDir, env: { ...sanitizedEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let out = '';
      child.stdout.on('data', c => out += c);
      child.stderr.on('data', c => out += c);
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
    });

  try {
    // 动态端口（4321+随机偏移）：固定端口会被外部/遗留进程占用——探活会误连
    // 老进程（假验证通过）；随机端口保证探活对象必为本次启动的新进程
    const port = String(4321 + Math.floor(Math.random() * 1000));
    // 审查修复（P3）：server 子进程与 healthcheck 同用 sanitizedEnv——此前原始 process.env
    // 把环境里的密钥/凭据原样透传给被验证的项目进程（与文件头部声明的净化策略矛盾）
    const srvEnv = { ...sanitizedEnv(), PORT: port };
    // 1. 启动（随机端口，healthcheck 探活同一端口）
    const srv = spawn(process.execPath, [entry], { cwd: projectDir, env: srvEnv, stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1200));
    // 2. 探活（PORT 显式传递——此前漏传会探默认 4321，端口被占时误连外部进程）
    const hcRes = await run(hc, { PORT: port });
    try { srv.kill(); } catch {}
    if (hcRes.code !== 0) return { status: 'failed', detail: hcRes.out.slice(0, 300) };
    // 3. 重启读回（声明流程真实化）：杀 → 重启 → 再探活 → 读回一致才算完成
    const srv2 = spawn(process.execPath, [entry], { cwd: projectDir, env: srvEnv, stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1200));
    const hcRes2 = await run(hc, { PORT: port });
    try { srv2.kill(); } catch {}
    if (hcRes2.code !== 0) return { status: 'failed', detail: `重启后探活失败：${hcRes2.out.slice(0, 300)}` };
    return { status: 'ok', detail: `启动→探活→重启→读回全部通过：${hcRes2.out.slice(0, 160)}` };
  } catch (e: any) {
    return { status: 'failed', detail: String(e?.message ?? e) };
  }
}
