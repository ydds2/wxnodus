// src/commands/mcpStatus.ts — B3（2026-09-04）：MCP 进程治理表面（单一事实源，legacy/modern 双路由共用）
//   /mcp list   —— 每行增「在线状态 + 内存」列：在线=组合根真实连接（connected 事实源），
//                 内存=进程枚举真实工作集（PID 来自 stdio transport）；未连接如实标注不探活（快路径）。
//   /mcp status —— 真实 initialize 探活（复用 /oasis health 链路：infra SDK connect + SSRF 先验），
//                 未连接条目报真因；绝不把未连通组件标在线（诚实文化）。
//   /mcp idle   —— 闲置自动下线开关（settings.mcpIdleTeardown {enabled, idleSeconds}，夹取 30s–1h；
//                 组合根 15s 清扫消费同一 settings——在途调用豁免，绝不误杀）。
import { lookup } from 'node:dns/promises';
import { lines } from './outputFormat.js';
import type { HandlerCtx } from './handlers.js';
import type { McpClient, McpConfigEntry } from '../kernel/mcp.js';
import { mcpHealthSnapshot, isProjectMcpTrusted } from '../kernel/mcp.js';
import { listProcesses, formatMemBytes, type ProcessInfo } from '../kernel/processScan.js';
import { connectMcp } from '../infrastructure/mcp/mcpClientHost.js';
import { McpTransportPolicy } from '../infrastructure/mcp/mcpTransportPolicy.js';

/** MCP 服务器语言推断（命令前缀）——「任意语言组件统一注册」的直接可视化（/oasis 共用） */
export function langOf(s: { command?: string; url?: string }): string {
  if (s.url) return 'HTTP';
  const c = (s.command ?? '').toLowerCase();
  if (c.includes('npx') || c.includes('node')) return 'Node';
  if (c.includes('uvx') || c.includes('uv ') || c.includes('python')) return 'Python';
  if (c.includes('docker')) return 'Container';
  if (c.includes('go ')) return 'Go';
  if (c.includes('java')) return 'Java';
  return 'Custom';
}

function headOf(t: McpConfigEntry): string {
  const tag = t.source === 'project' ? ' [项目]' : ' [用户]';
  const transport = t.url ? `HTTP ${t.url}` : `${t.command} ${(t.args ?? []).join(' ')}`;
  return `[${langOf(t)}] ${t.name}${tag} → ${transport}`;
}

function ago(ts: number, now: number): string {
  const s = Math.max(1, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  return `${Math.round(s / 3600)}h 前`;
}

function idleStateText(settings: Record<string, any>): string {
  const cfg = settings?.mcpIdleTeardown;
  if (cfg && cfg.enabled === true && Number.isFinite(Number(cfg.idleSeconds))) {
    return `闲置下线：开启 · 阈值 ${Math.round(Number(cfg.idleSeconds))}s（/mcp idle off 关闭；下线后 /reload-mcp 或重启恢复）`;
  }
  return '闲置下线：关闭（/mcp idle on 120 开启——闲置超时自动断开并释放内存）';
}

/** /mcp list：在线状态 + 内存列（真实连接 + 真实工作集；进程枚举失败内存如实 —） */
export async function renderMcpList(
  entries: McpConfigEntry[],
  liveClients: McpClient[],
  settings: Record<string, any>,
  scope: { dataDir: string; cwd: string },
): Promise<string> {
  const liveByName = new Map(liveClients.map(c => [c.server.name, c]));
  const healthByName = new Map(mcpHealthSnapshot(liveClients).map(h => [h.server, h]));
  const needProcs = liveClients.some(c => c.connected && c.process?.pid);
  const procs: ProcessInfo[] | null = needProcs ? await listProcesses().catch(() => null) : null;
  const now = Date.now();
  const memOf = (pid?: number) => (procs ? formatMemBytes(procs.find(p => p.pid === pid)?.workingSetBytes) : '—');
  if (!entries.length) {
    return lines(' MCP ', [
      ' 未配置 server',
      '',
      ' 用法：/mcp add <名称> <命令> [参数...]（--project 写项目 .mcp.json）',
      '       /mcp remove <名称>',
      '       /mcp test <名称>',
      ' 配置：项目 .mcp.json（mcpServers 格式）+ 用户 data/mcp.json',
      ' 项目 MCP 默认不启动；/mcp trust <名称> 显式批准（配置变化后失效）',
      ' strictMcpConfig=true 时仅信任项目声明（--strict-mcp-config 等价）',
    ]);
  }
  const rows = entries.map(t => {
    const live = liveByName.get(t.name);
    if (!live) {
      const untrusted = t.source === 'project' && !isProjectMcpTrusted(scope.dataDir, scope.cwd, t);
      return untrusted
        ? ` ${headOf(t)} · 未信任（/mcp trust ${t.name} 显式批准）`
        : ` ${headOf(t)} · 未连接（/mcp status ${t.name} 探活真因）`;
    }
    const h = healthByName.get(t.name);
    if (!live.connected) return ` ${headOf(t)} · 降级（连接失败 · 0 工具）`;
    const pidBit = live.process?.pid ? ` · pid ${live.process.pid} · 内存 ${memOf(live.process.pid)}` : '';
    const useBit = h?.lastCallMs ? ` · 最后调用 ${ago(h.lastCallMs, now)}` : '';
    const errBit = h && h.errorCount ? ` · 错误 ${h.errorCount}` : '';
    return ` ${headOf(t)} · 在线${pidBit} · ${live.tools.length} 工具${useBit}${errBit}`;
  });
  rows.push('', ` ${idleStateText(settings)}`, ' /mcp status [名称] —— 未连接条目真实 initialize 探活');
  return lines(' MCP ', rows);
}

/** 未连接条目真实探活（infra SDK auto negotiation + SSRF 先验——与 /oasis health 同链路；
 *  项目级未信任条目拒绝探活——绝不绕过 /mcp trust 批准门） */
async function probeOne(t: McpConfigEntry, scope: { dataDir: string; cwd: string }): Promise<string> {
  if (t.source === 'project' && !isProjectMcpTrusted(scope.dataDir, scope.cwd, t)) {
    return ` ✗ ${headOf(t)} · 未信任（/mcp trust ${t.name} 显式批准后自动连接）`;
  }
  const started = Date.now();
  try {
    if (t.url) {
      const policy = new McpTransportPolicy({ resolve: async (host: string) => (await lookup(host, { all: true })).map(r => r.address) });
      await policy.assertHttpTarget(new URL(t.url));
    }
    const config = t.url
      ? { transport: 'streamable-http' as const, url: t.url, headers: {} }
      : { transport: 'stdio' as const, command: t.command, args: t.args ?? [], env: {} };
    const connected = await connectMcp(config, AbortSignal.timeout(10_000));
    const ms = Date.now() - started;
    try { await connected.dispose(); } catch { /* 探针释放失败不改变结论 */ }
    return ` ✓ ${headOf(t)} · 在线（era ${connected.era} · 协议 ${connected.negotiatedVersion} · ${ms}ms · 探针已释放）`;
  } catch (cause) {
    return ` ✗ ${headOf(t)} · 离线（${String((cause as Error)?.message ?? cause).slice(0, 120)}）`;
  }
}

/** /mcp status [名称]：在线连接快照 + 未连接条目并行真实探活 */
export async function renderMcpStatus(
  entries: McpConfigEntry[],
  liveClients: McpClient[],
  settings: Record<string, any>,
  scope: { dataDir: string; cwd: string },
  nameFilter?: string,
): Promise<string> {
  const targets = nameFilter ? entries.filter(e => e.name === nameFilter) : entries;
  if (!targets.length) {
    return nameFilter
      ? `server「${nameFilter}」未配置（/mcp add <名称> <命令> 先配置）`
      : lines(' MCP 状态 ', [' 未配置 server——/mcp add <名称> <命令> 接入后即可探活']);
  }
  const liveByName = new Map(liveClients.map(c => [c.server.name, c]));
  const healthByName = new Map(mcpHealthSnapshot(liveClients).map(h => [h.server, h]));
  const needProcs = liveClients.some(c => c.connected && c.process?.pid);
  const procs: ProcessInfo[] | null = needProcs ? await listProcesses().catch(() => null) : null;
  const now = Date.now();
  const memOf = (pid?: number) => (procs ? formatMemBytes(procs.find(p => p.pid === pid)?.workingSetBytes) : '—');
  const rows = await Promise.all(targets.map(async t => {
    const live = liveByName.get(t.name);
    if (live && live.connected) {
      const h = healthByName.get(t.name);
      const pidBit = live.process?.pid ? ` · pid ${live.process.pid} · 内存 ${memOf(live.process.pid)}` : '';
      const useBit = h?.lastCallMs ? ` · 最后调用 ${ago(h.lastCallMs, now)}` : '';
      const errBit = h && h.errorCount ? ` · 错误 ${h.errorCount}` : '';
      return ` ✓ ${headOf(t)} · 在线${pidBit} · ${live.tools.length} 工具${useBit}${errBit}`;
    }
    return probeOne(t, scope);
  }));
  const online = rows.filter(r => r.startsWith(' ✓')).length;
  rows.push('', ` 在线 ${online}/${targets.length}——全部真实 initialize 协商（零假装）`, ` ${idleStateText(settings)}`);
  return lines(' MCP 状态 ', rows);
}

/** /mcp idle：读取当前开关状态 */
export function renderMcpIdleState(settings: Record<string, any>): string {
  return lines(' MCP 闲置下线 ', [
    ` ${idleStateText(settings)}`,
    ' 用法：/mcp idle on <秒数 30–3600> ｜ /mcp idle off',
    ' 语义：连接空闲（无工具调用）超过阈值自动断开并释放进程；在途调用豁免；',
    ' 下线后配置仍在——/reload-mcp 或重启即恢复连接（绝不删除配置）。',
  ]);
}

/** /mcp idle on|off：持久化 settings.mcpIdleTeardown（写穿透缓存，组合根清扫即时生效） */
export function applyMcpIdleCommand(args: string[], ctx: Pick<HandlerCtx, 'config'>): string {
  const sub = args[0];
  if (sub === 'off') {
    ctx.config.setKey('settings', 'mcpIdleTeardown', { enabled: false });
    return '闲置下线已关闭（现有连接保持；/mcp idle on 120 重新开启）';
  }
  if (sub === 'on') {
    const seconds = Math.round(Number(args[1]));
    if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3600) {
      return '用法：/mcp idle on <秒数 30–3600>（阈值下限 30s——15s 调用超时 × 2 余量，在途调用绝不下线）';
    }
    ctx.config.setKey('settings', 'mcpIdleTeardown', { enabled: true, idleSeconds: seconds });
    return `闲置下线已开启：空闲 ${seconds}s 自动断开并释放内存（在途调用豁免；/mcp idle off 关闭）`;
  }
  return '用法：/mcp idle ｜ on <秒数 30–3600> ｜ off';
}
