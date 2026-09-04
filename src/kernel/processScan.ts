// src/kernel/processScan.ts — B1/B3（2026-09-04）：进程枚举单一事实源
// 消费方：/doctor「孤儿进程/心跳断档」体检项（8/30 事故自愈面）+ /mcp list/status 内存列。
// 设计：
//   ① Windows 经 PowerShell Get-CimInstance Win32_Process 一次拿全表（pid/ppid/name/cmdline/工作集）；
//      POSIX 经 ps 降级（rss KB × 1024）。失败如实抛错——消费方标「无法探测」，绝不伪造空表；
//   ② 分类纯函数（classifyOrphanProcesses/descendantsOf/ancestorsOf）与采集解耦——测试注入进程表，
//      真机走真实枚举；「疑似孤儿」= 匹配 wxnodus/zcode 探针特征且非自身/祖先（多开会话是合法形态，只提示不误判故障）；
//   ③ 工作集字节仅展示用（进程运行中自然波动）——绝不用作任何调度/限额判定（诚实口径）。
import { execFile } from 'node:child_process';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
  /** WorkingSetSize 字节（Windows）/ RSS×1024（POSIX）；缺失=无法读取 */
  workingSetBytes?: number;
}

/** 疑似遗留进程特征：wxnodus 实例（全局安装路径含独立单词）+ ZCode 探针临时目录（8/30 tmp-n2 孤儿） */
const ORPHAN_PATTERNS: RegExp[] = [
  /\bwxnodus\b/i,
  /tmp-n\d+/i,
];

/** PowerShell 全表采集脚本（ASCII-only；UTF8 前缀规避 PS5.1 重定向 GBK 编码坑——toolOutput.ts 同款） */
const WIN_SCRIPT = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; @{procs=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize)} | ConvertTo-Json -Compress -Depth 2';

function execFileP(cmd: string, args: string[], opts: { windowsHide?: boolean; timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** 真实进程全表（Windows PowerShell / POSIX ps；失败抛错——消费方诚实标注） */
export async function listProcesses(opts: { timeoutMs?: number } = {}): Promise<ProcessInfo[]> {
  const timeout = opts.timeoutMs ?? 20_000;
  if (process.platform === 'win32') {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT], { windowsHide: true, timeout });
    return parseWin32ProcessJson(stdout);
  }
  const { stdout } = await execFileP('ps', ['-A', '-o', 'pid=,ppid=,rss=,args='], { timeout });
  return parsePosixPsOutput(stdout);
}

/** Windows JSON 解析（{procs:[…]} 或裸数组均接受；坏输入/坏条目诚实跳过） */
export function parseWin32ProcessJson(text: string): ProcessInfo[] {
  try {
    const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === 'object' && Array.isArray((raw as { procs?: unknown }).procs) ? (raw as { procs: unknown[] }).procs : []);
    const out: ProcessInfo[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const pid = Number(rec.ProcessId);
      if (!Number.isFinite(pid)) continue;
      const ppid = Number(rec.ParentProcessId);
      const rawWss = rec.WorkingSetSize;
      const wss = Number(rawWss);
      out.push({
        pid,
        ppid: Number.isFinite(ppid) ? ppid : 0,
        name: String(rec.Name ?? ''),
        cmdline: String(rec.CommandLine ?? ''),
        workingSetBytes: typeof rawWss === 'number' && Number.isFinite(wss) && wss >= 0 ? wss : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** POSIX ps 解析（pid ppid rss_kb args…） */
export function parsePosixPsOutput(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: '',
      cmdline: m[4] ?? '',
      workingSetBytes: Number(m[3]) * 1024,
    });
  }
  return out;
}

/** 子孙进程（ppid 链 BFS——/mcp 内存聚合与 B2 进程树回收共用） */
export function descendantsOf(procs: ProcessInfo[], rootPid: number): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const p of procs) {
      if (p.ppid === pid) { out.push(p); queue.push(p.pid); }
    }
  }
  return out;
}

/** 祖先链（含自身）——孤儿判定排除当前进程血统（pid 0 = System Idle，永不入围） */
export function ancestorsOf(procs: ProcessInfo[], pid: number): Set<number> {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const out = new Set<number>();
  let cur: number | undefined = pid;
  while (cur !== undefined && cur > 0 && !out.has(cur)) {
    out.add(cur);
    cur = byPid.get(cur)?.ppid;
  }
  return out;
}

/** 疑似遗留进程分类：特征匹配 ∧ 非自身/祖先 ∧ pid>4（system idle 等永不入围） */
export function classifyOrphanProcesses(procs: ProcessInfo[], selfPid: number): ProcessInfo[] {
  const exclude = ancestorsOf(procs, selfPid);
  return procs.filter(p => p.pid > 4 && !exclude.has(p.pid) && ORPHAN_PATTERNS.some(re => re.test(p.cmdline)));
}

/** 工作集字节 → 人类可读（仅展示；缺失/未知 → —） */
export function formatMemBytes(bytes?: number): string {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '—';
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(b / 1024))}KB`;
}
