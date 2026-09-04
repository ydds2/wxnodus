// src/kernel/doctor.ts — V4 P4-3：wxnodus doctor 全链路自诊断引擎
// 设计（codex doctor 机制对齐——端点保护/网络代理/更新连通性；实现按本仓架构重写）：
//   ① 检查项结构化（item/status/detail 四态）——TUI 面板与 CLI 子命令消费同一引擎；
//   ② exit code 可判：0=无 fail（warn/info 不影响）；1=存在 fail（系统不可用级问题）；
//   ③ 「未配置」是初始状态不是故障——密钥/模型/档案未配置记 info，不污染 exit code；
//   ④ 网络项（端点探活/更新通道）默认并行 4s 预算，可 network:false 跳过（离线/`doctor local`）；
//     更新通道不可达记 warn 不 fail（气隙部署是合法形态——诚实标注而非误报故障）。
import { existsSync, statfsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { resolveApiKey } from './providers.js';
import { profileHealth } from './profiles.js';
import { verifyAudit, type AuditDb } from './audit.js';
import { resolveDefaultBaseURL } from './defaults.js';
import { listProcesses, classifyOrphanProcesses, type ProcessInfo } from './processScan.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface DoctorCheck { item: string; status: DoctorStatus; detail: string }
export interface DoctorReport {
  checks: DoctorCheck[];
  counts: { ok: number; warn: number; fail: number; info: number };
  /** 0=无 fail；1=存在 fail（warn/info 不计入） */
  exitCode: 0 | 1;
}

/** 最小 DB 端口（真实 Db 自然满足；integrity/audit/计数三类查询） */
export type DoctorDb = AuditDb & {
  prepare(sql: string): {
    get(...a: unknown[]): any;
    all(...a: unknown[]): any[];
  };
};

export interface DoctorInput {
  dataDir: string;
  db: DoctorDb;
  settings: Record<string, any>;
  cwd: string;
  /** 安装产物模块路径（更新渠道探测；缺省用 cwd） */
  modulePath?: string;
  /** 网络项开关（默认 true）；离线/`doctor local` 传 false */
  network?: boolean;
  fetchImpl?: typeof fetch;
  netTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** B1：进程枚举注入（测试隔离；缺省真实 PowerShell/ps 全表） */
  processScan?: () => Promise<ProcessInfo[]>;
  /** B1：心跳日志目录（缺省 dataDir/logs） */
  heartbeatDir?: string;
  /** B1：心跳日志夹具（测试隔离；缺省读 heartbeatDir） */
  heartbeatLogs?: HeartbeatFileInfo[];
  /** B1：心跳断档阈值 ms（缺省 15s=7 拍） */
  heartbeatGapMs?: number;
}

// ── B1（2026-09-04）：心跳日志解析（纯函数，可单测） ──────────────────

/** 心跳日志：每个 pid 保留最后一次心跳时间（同文件多会话交错——逐 pid 取最新才不误判） */
export interface HeartbeatFileInfo { file: string; lastByPid: Map<number, number> }

/** 心跳行：`<ISO> alive pid=<pid>`（旧格式无 pid 的行无法关联进程——诚实跳过） */
export function parseHeartbeatLine(line: string): { pid: number; at: number } | null {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+alive(?:\s+pid=(\d+))?/i);
  if (!m) return null;
  const pid = Number(m[2]);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const at = Date.parse(m[1]!);
  if (!Number.isFinite(at)) return null;
  return { pid, at };
}

export function parseHeartbeatLog(text: string, file: string): HeartbeatFileInfo {
  const lastByPid = new Map<number, number>();
  for (const line of text.split('\n')) {
    const hit = parseHeartbeatLine(line.trim());
    if (!hit) continue;
    if (hit.at > (lastByPid.get(hit.pid) ?? 0)) lastByPid.set(hit.pid, hit.at);
  }
  return { file, lastByPid };
}

/** 读取日志目录全部 heartbeat-*.log（目录缺失/不可读 → 空表——心跳体检如实标 info） */
export function readHeartbeatLogs(dir: string): HeartbeatFileInfo[] {
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith('heartbeat-') && f.endsWith('.log'))
      .map(f => parseHeartbeatLog(readFileSync(join(dir, f), 'utf8'), f));
  } catch {
    return [];
  }
}

export interface HeartbeatGapHit { pid: number; file: string; gapMs: number }

/** 心跳断档判定：进程仍存活但最后心跳超过阈值（跨文件取每 pid 最新一拍——冻结窗口定位核心） */
export function analyzeHeartbeatGaps(
  logs: HeartbeatFileInfo[],
  procs: ProcessInfo[],
  now: number,
  gapMs: number,
  selfPid: number,
): { frozen: HeartbeatGapHit[]; checked: number } {
  const alive = new Set(procs.map(p => p.pid));
  const latest = new Map<number, { at: number; file: string }>();
  for (const log of logs) {
    for (const [pid, at] of log.lastByPid) {
      const cur = latest.get(pid);
      if (!cur || at > cur.at) latest.set(pid, { at, file: log.file });
    }
  }
  const frozen: HeartbeatGapHit[] = [];
  for (const [pid, { at, file }] of latest) {
    if (pid === selfPid || !alive.has(pid)) continue;
    const gap = now - at;
    if (gap > gapMs) frozen.push({ pid, file, gapMs: gap });
  }
  frozen.sort((a, b) => b.gapMs - a.gapMs);
  return { frozen, checked: latest.size };
}

// ── 纯函数（可单测） ──────────────────────────────────────────────

/** 磁盘余量分级：<100MB fail（随时写满）/ <1GB warn / 其余 ok */
export function diskStatus(freeBytes: number): DoctorStatus {
  if (freeBytes < 100 * 1024 * 1024) return 'fail';
  if (freeBytes < 1024 * 1024 * 1024) return 'warn';
  return 'ok';
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)}MB`;
  return `${(n / 1024).toFixed(0)}KB`;
}

/** 终端能力档位（环境启发式；权威能力集在渲染器 capabilities——此处报告环境档） */
export function detectTerminalTier(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (env.WT_SESSION) return 'modern（Windows Terminal）';
  if (env.ConEmuANSI || env.ConEmuPID) return 'modern（ConEmu）';
  if (env.TERM_PROGRAM) return `modern（${env.TERM_PROGRAM}）`;
  if (env.TERM === 'xterm-256color' || env.TERM === 'xterm') return `modern（${env.TERM}）`;
  if (platform === 'win32') return 'cmd（经典 conhost——批量行渲染档）';
  return 'no-vt（未知终端——降级档）';
}

/** 代理链路描述（只报告不判故障——代理配置是合法形态） */
export function describeProxy(env: NodeJS.ProcessEnv): string {
  const parts: string[] = [];
  if (env.HTTPS_PROXY || env.https_proxy) parts.push(`HTTPS=${env.HTTPS_PROXY ?? env.https_proxy}`);
  if (env.HTTP_PROXY || env.http_proxy) parts.push(`HTTP=${env.HTTP_PROXY ?? env.http_proxy}`);
  if (env.ALL_PROXY || env.all_proxy) parts.push(`ALL=${env.ALL_PROXY ?? env.all_proxy}`);
  if (env.NO_PROXY || env.no_proxy) parts.push(`NO_PROXY=${env.NO_PROXY ?? env.no_proxy}`);
  return parts.length ? parts.join(' · ') : '未配置（直连）';
}

/** 更新通道探测端点（渠道→权威端点映射；不可 HTTP 探测的渠道返回 null） */
export function updateChannelEndpoint(channel: string, opts: { gitRemote?: string | null; zipSource?: string | null }): string | null {
  switch (channel) {
    case 'npm-global': return 'https://registry.npmjs.org/-/ping';
    case 'zip': return opts.zipSource && /^https?:\/\//.test(opts.zipSource) ? opts.zipSource : null;
    case 'git': return opts.gitRemote && /^https:\/\//.test(opts.gitRemote) ? opts.gitRemote : null;
    default: return 'https://api.github.com'; // winget/scoop/unknown 以 GitHub Release 通道为准
  }
}

// ── 引擎 ──────────────────────────────────────────────────────────

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const checks: DoctorCheck[] = [];

  // ① 配置中心
  checks.push({ item: '配置中心', status: existsSync(join(input.dataDir, 'settings.json')) ? 'ok' : 'warn', detail: existsSync(join(input.dataDir, 'settings.json')) ? '已初始化' : '未初始化（首次配置后生成）' });

  // ② 数据库完整性（integrity_check）
  try {
    const r = input.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
    checks.push({ item: '数据库完整性', status: r?.integrity_check === 'ok' ? 'ok' : 'fail', detail: r?.integrity_check === 'ok' ? 'integrity_check 通过' : `异常（${r?.integrity_check ?? '未知'}）` });
  } catch (e: any) {
    checks.push({ item: '数据库完整性', status: 'fail', detail: `无法执行（${String(e?.message ?? e).slice(0, 80)}）` });
  }

  // ③ 审计哈希链（verifyAudit——可校验篡改属性在线验证）
  try {
    const v = verifyAudit(input.db);
    checks.push(v.ok
      ? { item: '审计链', status: 'ok', detail: `${v.count} 条哈希链完整` }
      : { item: '审计链', status: 'fail', detail: `在 id=${v.brokenAtId} 处断裂（篡改或损坏）` });
  } catch (e: any) {
    checks.push({ item: '审计链', status: 'fail', detail: `无法校验（${String(e?.message ?? e).slice(0, 80)}）` });
  }

  // ④ 黑洞记忆 + ⑤ 全文索引
  try {
    const total = (input.db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
    const archived = (input.db.prepare('SELECT COUNT(*) c FROM messages WHERE archived=1').get() as { c: number }).c;
    checks.push({ item: '黑洞记忆', status: 'ok', detail: `${total} 条（${archived} 条已归档仍可检索）` });
  } catch { checks.push({ item: '黑洞记忆', status: 'fail', detail: '表不可读' }); }
  try {
    const fts = (input.db.prepare('SELECT COUNT(*) c FROM messages_fts').get() as { c: number }).c;
    checks.push({ item: '全文索引', status: 'ok', detail: `${fts} 条可检索` });
  } catch { checks.push({ item: '全文索引', status: 'warn', detail: '未初始化' }); }

  // ⑥ 原生依赖 ABI（better-sqlite3 由 DB 打开证明；sqlite-vec/robotjs 探测加载）
  const nodeVer = process.versions.node;
  const abi = process.versions.modules;
  const nativeParts: string[] = [`better-sqlite3 可用 · node ${nodeVer}/ABI ${abi}`];
  let nativeStatus: DoctorStatus = 'ok';
  try {
    input.db.prepare('SELECT count(*) c FROM archival_vec').get();
    nativeParts.push('sqlite-vec 已加载');
  } catch {
    nativeParts.push('sqlite-vec 未加载（向量检索降级纯 FTS5）');
    nativeStatus = 'warn';
  }
  try {
    const require_ = createRequire(import.meta.url);
    require_('robotjs');
    nativeParts.push('robotjs 可用');
  } catch {
    nativeParts.push('robotjs 不可用（computer 坐标控制受限，UIA 不受影响）');
    if (nativeStatus === 'ok') nativeStatus = 'warn';
  }
  checks.push({ item: '原生依赖', status: nativeStatus, detail: nativeParts.join(' · ') });

  // ⑥¼ A3 / P1-4（2026-08-27）：三层策略面——全局/用户/项目加载状态与诊断（损坏如实报 fail）
  try {
    const { loadMergedPolicyRules } = await import('../infrastructure/policy/policyLayers.js');
    const policy = loadMergedPolicyRules({ dataDir: input.dataDir, workspaceRoot: input.cwd });
    const layerBits = policy.layers.map(l => `${l.name}:${l.missing ? '无' : l.loadError ? '损坏' : `${l.rules.length} 条`}`).join(' / ');
    checks.push({ item: '策略层', status: policy.diagnostics.length ? 'fail' : 'ok', detail: layerBits + (policy.diagnostics.length ? `；警告：${policy.diagnostics.join('；')}` : '') });
  } catch { /* 策略探测失败不污染体检 */ }

  // ⑥½ A2（2026-08-27）：网络代理面——env 或系统代理生效时如实展示（私网段默认直连红线一并说明）
  try {
    const { createOutboundFetch, loadSystemProxy } = await import('../infrastructure/http/outboundFetch.js');
    await loadSystemProxy();
    const outbound = createOutboundFetch();
    if (outbound.proxyDescription) {
      checks.push({ item: '网络代理', status: 'ok', detail: outbound.proxyDescription });
    } else {
      checks.push({ item: '网络代理', status: 'info', detail: '未配置（HTTP(S)_PROXY 环境变量 / WinINET 系统代理）——直连' });
    }
  } catch { /* 代理探测失败不污染体检 */ }

  // ⑦ 磁盘余量（dataDir 所在卷）
  try {
    const st = statfsSync(input.dataDir);
    const free = Number(st.bsize) * Number(st.bavail);
    checks.push({ item: '磁盘余量', status: diskStatus(free), detail: `${formatBytes(free)} 可用` });
  } catch { checks.push({ item: '磁盘余量', status: 'info', detail: '无法探测' }); }

  // ⑧ 模型密钥 + ⑨ 当前模型 + ⑩ 接入档案（未配置=初始状态记 info，不污染 exit code）
  const keyRes = resolveApiKey(input.settings, env);
  if (keyRes.key) {
    checks.push({ item: '模型密钥', status: 'ok', detail: `已配置且可解密（provider=${keyRes.provider}）` });
  } else if (keyRes.error === 'provider-mismatch') {
    checks.push({ item: '模型密钥', status: 'fail', detail: `provider 不符：${keyRes.hint}` });
  } else if (keyRes.source === 'enc') {
    checks.push({ item: '模型密钥', status: 'fail', detail: '已配置但无法解密（需 /model set-key 重配）' });
  } else {
    checks.push({ item: '模型密钥', status: 'info', detail: '未配置（/model set-key <密钥>）' });
  }
  const model = input.settings?.model;
  checks.push({ item: '当前模型', status: model ? 'ok' : 'info', detail: model ? String(model) : '未选择（/model）' });
  try {
    const providers = input.settings?.providers as Array<Record<string, any>> | undefined;
    const active = input.settings?.activeProvider as string | undefined;
    const issues = profileHealth(providers, active);
    if (Array.isArray(providers) && providers.length) {
      checks.push({ item: '接入档案', status: issues.length ? 'warn' : 'ok', detail: issues.length ? `异常：${issues[0]!.detail}` : `${providers.length} 个档案正常` });
    } else {
      checks.push({ item: '接入档案', status: 'info', detail: '未配置（/profile add）' });
    }
  } catch { checks.push({ item: '接入档案', status: 'info', detail: '读取失败（不阻断体检）' }); }

  // ⑪ 终端能力档位 + ⑫ 代理链路（环境报告，均 info）
  checks.push({ item: '终端档位', status: 'info', detail: detectTerminalTier(env, platform) });
  checks.push({ item: '代理链路', status: 'info', detail: describeProxy(env) });

  // ⑫¼ B1（2026-09-04）：卡死自愈体检——孤儿进程 + 心跳断档（8/30 tmp-n2 孤儿事故教训）。
  // 采集失败如实标 info（绝不伪造空表）；疑似孤儿只提示（warn）不判故障（多开会话是合法形态）。
  const procs = await (input.processScan ?? (() => listProcesses()))().catch(() => null);
  if (procs === null) {
    checks.push({ item: '孤儿进程', status: 'info', detail: '无法探测（进程枚举不可用）' });
  } else {
    const orphans = classifyOrphanProcesses(procs, process.pid);
    checks.push(orphans.length
      ? { item: '孤儿进程', status: 'warn', detail: `发现 ${orphans.length} 个疑似遗留：${orphans.slice(0, 4).map(p => `${p.pid}(${p.name})`).join('、')}${orphans.length > 4 ? ' 等' : ''}——多开会话或卡死残留（/jobs、任务管理器复核；B2 进程树回收兜底）` }
      : { item: '孤儿进程', status: 'ok', detail: '未发现（本会话进程树干净）' });
  }
  const hbLogs = input.heartbeatLogs ?? readHeartbeatLogs(input.heartbeatDir ?? join(input.dataDir, 'logs'));
  const gap = analyzeHeartbeatGaps(hbLogs, procs ?? [], Date.now(), input.heartbeatGapMs ?? 15_000, process.pid);
  if (!hbLogs.length) {
    checks.push({ item: '心跳探针', status: 'info', detail: '无心跳日志（心跳默认开启 2s 一写，首次运行即生成；WXNODUS_NO_HEARTBEAT=1 关闭则属预期）' });
  } else if (procs === null) {
    checks.push({ item: '心跳探针', status: 'info', detail: `心跳日志 ${gap.checked} 条进程记录——断档判定跳过（进程枚举不可用）` });
  } else if (gap.frozen.length) {
    checks.push({ item: '心跳探针', status: 'warn', detail: `${gap.frozen.length} 个进程心跳断档：${gap.frozen.map(f => `pid ${f.pid}（${Math.round(f.gapMs / 1000)}s）`).join('、')}——疑似卡死（任务管理器复核）` });
  } else {
    checks.push({ item: '心跳探针', status: 'ok', detail: `心跳正常（${gap.checked} 个进程无断档）` });
  }

  // ⑬⑭ 网络项（并行 4s 预算；network=false 时诚实跳过）
  if (input.network === false) {
    checks.push({ item: '端点连通', status: 'info', detail: '已跳过（local 模式）' });
    checks.push({ item: '更新通道', status: 'info', detail: '已跳过（local 模式）' });
  } else {
    const fetchImpl = input.fetchImpl ?? fetch;
    const timeoutMs = input.netTimeoutMs ?? 4000;
    const keyConfigured = Boolean(keyRes.key);
    const [endpoint, channel] = await Promise.all([
      probeEndpoint(fetchImpl, timeoutMs, input.settings, env),
      probeUpdateChannel(fetchImpl, timeoutMs, input),
    ]);
    // 端点不可达：已配密钥=对话不可用（fail）；未配密钥=尚不可判（warn——可能离线/代理）
    const endpointStatus: DoctorStatus = endpoint.ok ? 'ok' : (keyConfigured ? 'fail' : 'warn');
    checks.push({ item: '端点连通', status: endpointStatus, detail: endpoint.ok ? `可达（${endpoint.message}）` : `不可达（${endpoint.message}）` });
    // 更新通道不可达记 warn（气隙部署合法形态——绝不误报 fail）
    checks.push({ item: '更新通道', status: channel.ok ? 'ok' : 'warn', detail: channel.detail });
  }

  const counts = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status]++;
  return { checks, counts, exitCode: counts.fail > 0 ? 1 : 0 };
}

/** 端点探活：当前 provider baseURL（<500 视为活着——401/403 也证明端点在线） */
async function probeEndpoint(fetchImpl: typeof fetch, timeoutMs: number, settings: Record<string, any>, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }> {
  const baseURL = resolveDefaultBaseURL(settings, env);
  try {
    const res = await fetchImpl(baseURL, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    return { ok: res.status < 500, message: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e).slice(0, 100) };
  }
}

/** 更新通道：渠道探测（buildUpdateReport 机制复用）+ 权威端点探活 */
async function probeUpdateChannel(fetchImpl: typeof fetch, timeoutMs: number, input: DoctorInput): Promise<{ ok: boolean; detail: string }> {
  try {
    const { buildUpdateReport, channelLabel } = await import('../commands/updateCheck.js');
    const report = buildUpdateReport({ modulePath: input.modulePath ?? input.cwd, cwd: input.cwd });
    const endpoint = updateChannelEndpoint(report.channel, {
      gitRemote: report.git?.remote ?? null,
      zipSource: report.installMeta?.source ?? null,
    });
    const label = `${channelLabel(report.channel)} · 当前 ${report.version}`;
    if (!endpoint) return { ok: true, detail: `${label}（非 HTTP 渠道，不做在线探测）` };
    try {
      const res = await fetchImpl(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      return { ok: res.status < 500, detail: res.status < 500 ? `${label} · 通道可达（HTTP ${res.status}）` : `${label} · 通道响应 ${res.status}` };
    } catch (e: any) {
      return { ok: false, detail: `${label} · 通道不可达（${String(e?.message ?? e).slice(0, 60)}——离线部署属正常）` };
    }
  } catch (e: any) {
    return { ok: false, detail: `渠道探测失败（${String(e?.message ?? e).slice(0, 60)}）` };
  }
}

// ── 渲染 ──────────────────────────────────────────────────────────

const MARK: Record<DoctorStatus, string> = { ok: '✓', warn: '⚠', fail: '✗', info: '·' };

/** 纯文本报告（CLI 子命令与测试消费——无 ANSI，tty 上色由调用方决定） */
export function renderDoctorText(report: DoctorReport): string {
  const lines = report.checks.map(c => ` ${MARK[c.status]} ${c.item}：${c.detail}`);
  const { ok, warn, fail, info } = report.counts;
  lines.push('', `汇总：${ok} 正常 · ${warn} 提示 · ${fail} 故障 · ${info} 信息 —— exit ${report.exitCode}${fail ? '（存在故障项）' : ''}`);
  return `${lines.join('\n')}\n`;
}
