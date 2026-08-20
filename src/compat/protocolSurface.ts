// src/compat/protocolSurface.ts — 协议面冻结：Gateway RPC / Wire / HTTP / MCP / Skill / Plugin
// 所有 descriptor 为 V3 运行时当前真实行为的事实记录；false-success / fail-open 行为必须带 reasonCode 且不得 preserve。
import { entry } from './descriptors.js';
import type { CompatibilityEntry } from './schema.js';

export function protocolSurface(): CompatibilityEntry[] {
  const out: CompatibilityEntry[] = [];

  // Gateway RPC 方法面（wxGateway._dispatch 公开方法——UI/TUI 与内核的契约）
  const gatewayMethods = [
    'prompt.submit', 'command.dispatch', 'config.get', 'config.set', 'sessions', 'session.activate',
    'session.fork', 'session.undo', 'session.save', 'session.active_list', 'memory.search', 'memory.recall',
    'memory.digest', 'shell.exec', 'delegation.pause', 'delegation.status', 'terminal.spawn',
    'terminal.write', 'terminal.kill', 'terminal.resize', 'rollback.list', 'rollback.diff',
    'rollback.restore', 'tools.configure', 'reload.env', 'paste.collapse', 'setup.status',
    'sudo.respond', 'secret.respond',
  ];
  for (const method of gatewayMethods) {
    out.push(entry('gateway', method, { transport: 'in-process GatewayClient' }));
  }

  // Wire 协议（-p --wire JSONL 事件流）
  out.push(entry('wire', 'frame.stdin', { method: 'string', params: 'object' }));
  out.push(entry('wire', 'event.response', { type: 'wire.response', method: 'string' }));
  out.push(entry('wire', 'event.agent-result', { type: 'agent.result' }));
  // 当前 wire agent 失败仍 exit 0——false success 行为，标记待修复，不 preserve
  out.push(entry('wire', 'exit-code-on-agent-failure', { behavior: 'exit 0' }, 'deprecate', {
    reasonCode: 'false_success',
    replacement: '非零退出码传播（Wave 1 Gateway error 语义）',
  }));

  // HTTP 网关（--serve）
  for (const endpoint of ['/health', '/events', '/rpc']) {
    out.push(entry('gateway', `http:${endpoint}`, { bind: '127.0.0.1' }));
  }
  out.push(entry('gateway', 'http:cors', { policy: 'Access-Control-Allow-Origin: *' }, 'deprecate', {
    reasonCode: 'unsafe_http_default',
    replacement: '默认拒绝跨源 + 显式 origin 白名单',
  }));
  out.push(entry('gateway', 'http:auth', { policy: 'none' }, 'deprecate', {
    reasonCode: 'fail_open_security',
    replacement: '本地 token / origin 校验（Wave 1）',
  }));

  // MCP client 面（.mcp.json / data/mcp.json）
  out.push(entry('extension', 'mcp:stdio-protocol', { protocolVersion: '2024-11-05', transport: 'stdio' }));
  out.push(entry('extension', 'mcp:http-protocol', { protocolVersion: '2025-06-18', transport: 'streamable-http' }));
  out.push(entry('extension', 'mcp:tool-namespace', { pattern: 'mcp__<server>__<tool>' }));
  out.push(entry('extension', 'mcp:config-priority', { rule: 'project-over-user', strict: 'strictProjectOnly option' }));
  out.push(entry('extension', 'mcp:config-roundtrip', { behavior: 'object format keeps command/args/env only' }, 'deprecate', {
    reasonCode: 'unknown_flag_ignored',
    replacement: '全字段往返（url/startupTimeoutMs/toolDanger）',
  }));

  // Skill 面（SKILL.md frontmatter）
  for (const field of ['name', 'description', 'version', 'ai_generated', 'flow', 'effort']) {
    out.push(entry('extension', `skill:frontmatter:${field}`, { scalar: true, crlf: true }));
  }
  out.push(entry('extension', 'skill:discovery', { roots: ['project', 'user'], priority: 'same-name-first-wins' }));

  // Plugin 面（plugin.json + index.js）
  out.push(entry('extension', 'plugin:manifest', { file: 'plugin.json', fields: ['name', 'enabled', 'tools', 'commands', 'nlTriggers'] }));
  out.push(entry('extension', 'plugin:load', { runtime: 'in-process dynamic import' }, 'deprecate', {
    reasonCode: 'fail_open_security',
    replacement: '隔离运行时 + 权限清单（Wave 2）',
  }));

  return out;
}
