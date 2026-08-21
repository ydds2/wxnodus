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
    // M-2（V4 维护轨）：探活轮询——此前固定睡 1200ms 后单次探测，冷启动慢的机器
    // （node 首载/杀软扫描）直接误判 failed；改 200ms 间隔轮询至 deadline（快机更快
    // 返回，慢机等到真活/真超时）。启动/重启两轮各占预算一半（下限 2s）。
    const probeDeadline = Math.max(2000, Math.floor(timeoutMs / 2));
    const waitAlive = async (): Promise<{ ok: boolean; out: string }> => {
      const deadline = Date.now() + probeDeadline;
      let last = { ok: false, out: '' };
      while (Date.now() < deadline) {
        const r = await run(hc, { PORT: port });
        last = { ok: r.code === 0, out: r.out };
        if (last.ok) return last;
        await new Promise(res => setTimeout(res, 200));
      }
      return last;
    };
    // 1. 启动（随机端口，healthcheck 探活同一端口）→ 探活轮询
    const srv = spawn(process.execPath, [entry], { cwd: projectDir, env: srvEnv, stdio: 'ignore' });
    const hc1 = await waitAlive();
    try { srv.kill(); } catch {}
    if (!hc1.ok) return { status: 'failed', detail: `探活失败（${probeDeadline}ms 内未就绪）：${hc1.out.slice(0, 300)}` };
    // 2. 重启读回（声明流程真实化）：杀 → 重启 → 再探活轮询 → 读回一致才算完成
    const srv2 = spawn(process.execPath, [entry], { cwd: projectDir, env: srvEnv, stdio: 'ignore' });
    const hc2 = await waitAlive();
    try { srv2.kill(); } catch {}
    if (!hc2.ok) return { status: 'failed', detail: `重启后探活失败（${probeDeadline}ms 内未就绪）：${hc2.out.slice(0, 300)}` };
    return { status: 'ok', detail: `启动→探活→重启→读回全部通过：${hc2.out.slice(0, 160)}` };
  } catch (e: any) {
    return { status: 'failed', detail: String(e?.message ?? e) };
  }
}
