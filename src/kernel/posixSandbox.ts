// src/kernel/posixSandbox.ts — macOS/Linux OS 沙盒（gap ⑥ 三平台化，2026-08-18）
// 机制参考（不抄代码）：codex 的 bwrap+Landlock / gemini 的 bwrap（Linux）；codex/gemini 的
// Seatbelt sandbox-exec（macOS）。与 winSandbox.ts 同族：
//   - 诚实契约：能力探测（bwrap --version / sandbox-exec 内联 profile 试跑）失败 → 明确
//     降级提示，绝不假装沙盒；探测进程级缓存。
//   - L0-L3 映射（与 Windows 语义对齐）：L0 只读+断网｜L1 可写+断网｜L2 可写+网（限速
//     需 root tc/无 Seatbelt 原语——本平台诚实降级为不限制，探测与命令输出如实标注）｜
//     L3 遏制（--die-with-parent 防孤儿，对齐 Job KILL_ON_CLOSE）。
//   - 输出经流式落盘 outPath/errPath（与 winSandbox 同构——bash 侧 offload 接管复用）。
// 实测校准红线：本模块 Linux/macOS 实机验证未完成（本机为 Windows）——探测定向测试只
// 覆盖「构建器纯函数 + 非本平台诚实不适用」；⑥ 评分在实机校准前不升 10（见审计口径）。
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PosixProfile = 'L0' | 'L1' | 'L2' | 'L3';

/** bwrap 参数构建（纯函数可单测）——profile → args（不含命令本身） */
export function bwrapArgs(profile: PosixProfile, workspace: string, dataDir: string): string[] {
  const base = ['--die-with-parent', '--unshare-ipc', '--unshare-pid', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  const bindWs = profile === 'L0' ? '--ro-bind' : '--bind';
  const net = profile === 'L0' || profile === 'L1' ? ['--unshare-net'] : [];
  return [...base, ...net, bindWs, workspace, workspace, '--ro-bind', dataDir, dataDir, '--chdir', workspace, '--'];
}

/** Seatbelt profile 文本（纯函数可单测）——macOS sandbox-exec -f */
export function seatbeltProfile(profile: PosixProfile): string {
  const header = '(version 1)\n';
  switch (profile) {
    case 'L0': return header + '(deny default)\n(allow process*)\n(allow file-read*)\n(deny file-write*)\n(deny network*)\n(allow sysctl-read)\n(allow mach-lookup)';
    case 'L1': return header + '(deny default)\n(allow process*)\n(allow file-read*)\n(allow file-write*)\n(deny network*)\n(allow sysctl-read)\n(allow mach-lookup)';
    case 'L2': return header + '(deny default)\n(allow process*)\n(allow file-read*)\n(allow file-write*)\n(allow network*)\n(allow sysctl-read)\n(allow mach-lookup)';
    case 'L3': return header + '(deny default)\n(allow process*)\n(allow file-read*)\n(allow file-write*)\n(allow network*)\n(allow sysctl-read)\n(allow mach-lookup)';
  }
}

export const POSIX_L2_RATE_LIMIT_NOTE = 'L2 限速在 Linux 需 root（tc）/ macOS Seatbelt 无该原语——本平台 L2 诚实降级为「可写+联网」，仅保留 L0/L1 断网语义';

/** 探测（缓存；force 重探）——本平台可用性 + 诚实原因 */
let probeCache: { ok: boolean; detail: string } | null = null;

export async function probePosixSandbox(force = false): Promise<{ ok: boolean; detail: string }> {
  if (!force && probeCache) return probeCache;
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    probeCache = { ok: false, detail: '非 Linux/macOS 平台——POSIX 沙盒不适用（Windows 走 winSandbox 的 Low IL/Job 路径）' };
    return probeCache;
  }
  const isLinux = process.platform === 'linux';
  const cmd = isLinux ? 'bwrap' : 'sandbox-exec';
  const args = isLinux ? ['--version'] : ['-p', '(version 1)(allow default)', '/usr/bin/true'];
  const result = await new Promise<{ ok: boolean; detail: string }>((resolveP) => {
    let done = false;
    const finish = (r: { ok: boolean; detail: string }) => { if (!done) { done = true; resolveP(r); } };
    try {
      const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } finish({ ok: false, detail: `探测超时（15s）——${cmd} 不存在或不可用` }); }, 15_000);
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', (e: any) => {
        clearTimeout(timer);
        finish({ ok: false, detail: e?.code === 'ENOENT'
          ? `未找到 ${cmd}——Linux 安装 bubblewrap（apt install bubblewrap）；macOS 自带 sandbox-exec（macOS 10.5+）`
          : `${cmd} 启动失败：${String(e?.message ?? e)}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0
          ? { ok: true, detail: isLinux ? 'bubblewrap 命名空间隔离可用（L0 只读+断网 / L1 断网 / L3 遏制；L2 限速需 root 降级）' : 'Seatbelt sandbox-exec 可用（L0 只读+断网 / L1 断网；L2 无限速原语降级）' }
          : { ok: false, detail: `${cmd} 探测失败（exit ${code}${out.trim() ? '：' + out.trim().slice(0, 120) : ''}）` });
      });
    } catch (e: any) {
      finish({ ok: false, detail: String(e?.message ?? e) });
    }
  });
  if (!force) probeCache = result;
  return result;
}

export interface PosixLaunchOutcome {
  result: { code: number | null; outPath: string; errPath: string; outTotal: number; errTotal: number } | null;
  reason?: 'not-posix' | 'off' | 'probe-failed' | 'launch-failed';
  note?: string;
}

/** 经 bwrap/Seatbelt 执行命令（与 winSandbox.trySandboxLaunch 同构——bash 侧共用接管逻辑） */
export async function tryPosixSandboxLaunch(opts: {
  profile: PosixProfile;
  dataDir: string;
  cmd: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PosixLaunchOutcome> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return { result: null, reason: 'not-posix' };
  const probe = await probePosixSandbox();
  if (!probe.ok) return { result: null, reason: 'probe-failed', note: `OS 沙盒不可用（${probe.detail}）——本次命令已按普通方式执行（未沙盒）` };
  const tmp = join(opts.dataDir, 'sandbox', 'run');
  mkdirSync(tmp, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const outPath = join(tmp, `${id}.out`);
  const errPath = join(tmp, `${id}.err`);
  try {
    const isLinux = process.platform === 'linux';
    const fullArgs = isLinux
      ? [...bwrapArgs(opts.profile, opts.cwd, opts.dataDir), opts.cmd, ...opts.args]
      : (() => {
        const profilePath = join(opts.dataDir, 'sandbox', `seatbelt-${opts.profile}.sb`);
        try { writeFileSync(profilePath, seatbeltProfile(opts.profile), 'utf8'); } catch { /* 落盘失败 → 探测路径已验，此处仍继续（失败在 spawn 报错） */ }
        return ['-f', profilePath, opts.cmd, ...opts.args];
      })();
    const launcher = isLinux ? 'bwrap' : 'sandbox-exec';
    const outcome = await new Promise<PosixLaunchOutcome>((resolveP) => {
      let done = false;
      const cleanup = () => { try { rmSync(outPath, { force: true }); rmSync(errPath, { force: true }); } catch { /* 忽略 */ } };
      const finish = (r: PosixLaunchOutcome) => { if (!done) { done = true; if (r.result === null) cleanup(); resolveP(r); } };
      let child: ChildProcess;
      try {
        child = spawn(launcher, fullArgs, { cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal });
      } catch (e: any) {
        finish({ result: null, reason: 'launch-failed', note: `沙盒启动失败：${String(e?.message ?? e)}` });
        return;
      }
      const outSink = createWriteStream(outPath, { flags: 'w' });
      const errSink = createWriteStream(errPath, { flags: 'w' });
      child.stdout?.pipe(outSink);
      child.stderr?.pipe(errSink);
      if (opts.stdin !== undefined) { child.stdin?.write(opts.stdin); }
      child.stdin?.end();
      const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, opts.timeoutMs) : null;
      child.on('error', (e) => { if (timer) clearTimeout(timer); finish({ result: null, reason: 'launch-failed', note: `沙盒启动失败：${e.message}` }); });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (opts.signal?.aborted) { finish({ result: null, reason: 'launch-failed', note: '已中断（用户中止）' }); return; }
        let outTotal = 0; let errTotal = 0;
        try { outTotal = statSync(outPath).size; } catch { /* 忽略 */ }
        try { errTotal = statSync(errPath).size; } catch { /* 忽略 */ }
        // 输出文件移交调用方（bash 侧接管 offload/清理）
        finish({ result: { code, outPath, errPath, outTotal, errTotal } });
      });
    });
    return outcome;
  } finally {
    // 无全局清理——成功分支文件由调用方接管；失败分支已在 finish 内清理
  }
}

export function clearPosixProbeCache(): void { probeCache = null; }
