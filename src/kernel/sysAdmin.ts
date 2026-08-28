// src/kernel/sysAdmin.ts — Windows 系统管理三面（服务/注册表/计划任务 · 2026-08-28）
// 目标（用户裁决：完全操作 Windows 整个系统）：sys_service / sys_registry / sys_task 三工具面。
// 全部经 Windows 内置工具（sc.exe / reg.exe / schtasks.exe）execFile 参数直传（零 shell 拼接）；
// tools.ts 注册 danger:true——写操作（start/stop/config/set/delete/create/run）一律走审批链（B1）。
// 非 Windows 平台诚实拒绝；命令构造纯函数可单测；runner 注入可测（同 sysPackage 模式）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export type SysAdminRunner = (bin: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultSysAdminRunner: SysAdminRunner = async (bin, args, opts = {}) => {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: opts.timeoutMs ?? 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { code: 0, stdout: String(stdout ?? ''), stderr: '' };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (err.code === 'ENOENT') return { code: -1, stdout: '', stderr: `未找到 ${bin}（Windows 内置工具，非 win32 平台不可用）` };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message ?? '').slice(0, 400) };
  }
};

const requireWin32 = (): Error | null =>
  process.platform === 'win32' ? null : new Error('sys_* 工具仅 Windows 可用（当前平台 ' + process.platform + '）');

const ok = (output: string) => ({ ok: true as const, output: output.slice(0, 6000) });
const fail = (manager: string, r: { code: number; stdout: string; stderr: string }) => ({
  ok: false as const, output: `失败（${manager} 退出码 ${r.code}）：${(r.stderr || r.stdout || '未知错误').slice(0, 400)}` });

// ── sys_service（sc.exe）────────────────────────────────────────
export function buildServiceArgs(a: { action: string; name?: string; startup?: string }): string[] | null {
  const name = (a.name ?? '').trim();
  switch (a.action) {
    case 'list': return ['query', 'state=', 'all'];
    case 'status': return name ? ['query', name] : null;
    case 'start': return name ? ['start', name] : null;
    case 'stop': return name ? ['stop', name] : null;
    case 'restart': return name ? ['stop', name] : null; // 重启=stop+start（调用方串行两跳）
    case 'set-startup': return name && ['auto', 'demand', 'disabled'].includes(a.startup ?? '') ? ['config', name, 'start=', a.startup!] : null;
    default: return null;
  }
}

export async function sysServiceOp(a: { action: string; name?: string; startup?: string }, runner: SysAdminRunner = defaultSysAdminRunner): Promise<{ ok: boolean; output: string }> {
  const plat = requireWin32(); if (plat) return { ok: false, output: plat.message };
  const args = buildServiceArgs(a);
  if (!args) return { ok: false, output: '参数无效——action ∈ list/status/start/stop/restart/set-startup；status/start/stop/restart/set-startup 需 name；set-startup 需 startup∈auto|demand|disabled' };
  const r = await runner('sc.exe', args);
  if (r.code !== 0) return fail('sc.exe', r);
  if (a.action === 'restart') {
    const r2 = await runner('sc.exe', ['start', (a.name ?? '').trim()]);
    if (r2.code !== 0) return fail('sc.exe(start)', r2);
    return ok(r2.stdout || '服务已重启');
  }
  return ok(r.stdout || `操作完成（${a.action}）`);
}

// ── sys_registry（reg.exe）──────────────────────────────────────
const REG_ROOTS = /^HKLM\\|^HKCU\\|^HKCR\\|^HKU\\|^HKCC\\|^HKEY_(LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT|USERS|CURRENT_CONFIG)\\/i;

export function buildRegistryArgs(a: { action: string; key?: string; name?: string; value?: string; type?: string }): string[] | null {
  const key = (a.key ?? '').trim().replace(/\//g, '\\');
  if (!key || !REG_ROOTS.test(key)) return null;
  switch (a.action) {
    case 'list': return ['query', key];
    case 'get': return a.name ? ['query', key, '/v', a.name] : ['query', key, '/ve'];
    case 'set': {
      if (!a.name || a.value === undefined) return null;
      const type = ['REG_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_BINARY', 'REG_EXPAND_SZ', 'REG_MULTI_SZ'].includes(a.type ?? '') ? a.type! : 'REG_SZ';
      return ['add', key, '/v', a.name, '/t', type, '/d', String(a.value), '/f'];
    }
    case 'delete': return ['delete', key, ...(a.name ? ['/v', a.name] : ['/ve']), '/f'];
    case 'delete-tree': return ['delete', key, '/f'];
    default: return null;
  }
}

export async function sysRegistryOp(a: { action: string; key?: string; name?: string; value?: string; type?: string }, runner: SysAdminRunner = defaultSysAdminRunner): Promise<{ ok: boolean; output: string }> {
  const plat = requireWin32(); if (plat) return { ok: false, output: plat.message };
  const args = buildRegistryArgs(a);
  if (!args) return { ok: false, output: '参数无效——key 必须以注册表根（HKLM\\HKCU\\HKCR\\HKU\\HKCC）开头；set 需 name+value（type 可选 REG_SZ/DWORD/…）；action ∈ list/get/set/delete/delete-tree' };
  const r = await runner('reg.exe', args);
  if (r.code !== 0) return fail('reg.exe', r);
  return ok(r.stdout || '操作完成');
}

// ── sys_task（schtasks.exe）─────────────────────────────────────
export function buildTaskArgs(a: { action: string; name?: string; command?: string; schedule?: string }): string[] | null {
  const name = (a.name ?? '').trim();
  switch (a.action) {
    case 'list': return ['/query', '/fo', 'LIST', '/v'];
    case 'query': return name ? ['/query', '/tn', name, '/fo', 'LIST', '/v'] : null;
    case 'create': {
      if (!name || !(a.command ?? '').trim() || !(a.schedule ?? '').trim()) return null;
      return ['/create', '/tn', name, '/tr', a.command!.trim(), '/sc', a.schedule!.trim(), '/f'];
    }
    case 'delete': return name ? ['/delete', '/tn', name, '/f'] : null;
    case 'run': return name ? ['/run', '/tn', name] : null;
    default: return null;
  }
}

export async function sysTaskOp(a: { action: string; name?: string; command?: string; schedule?: string }, runner: SysAdminRunner = defaultSysAdminRunner): Promise<{ ok: boolean; output: string }> {
  const plat = requireWin32(); if (plat) return { ok: false, output: plat.message };
  const args = buildTaskArgs(a);
  if (!args) return { ok: false, output: '参数无效——action ∈ list/query/create/delete/run；query/delete/run/create 需 name；create 需 command+schedule（/sc 值：MINUTE/HOURLY/DAILY/WEEKLY/ONSTART/ONLOGON 等 schtasks 语法）' };
  const r = await runner('schtasks.exe', args);
  if (r.code !== 0) return fail('schtasks.exe', r);
  return ok(r.stdout || '操作完成');
}
