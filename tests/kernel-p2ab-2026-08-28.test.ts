// tests/kernel-p2ab-2026-08-28.test.ts — Phase 2 自研批（kimi 体系参考目录选型项）
// P2-A：hooks 声明式 matcher（event:matcher 键形 + 通配 + 条目筛选——kimi engine.py:33,97 语义）
// P2-B：MCP server 鉴权头（headers + env: 引用 fail-closed——kimi mcp_oauth 本地凭证思想）
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseHookKey, hookKeyMatches, hookEntriesFromConfig, selectHookEntries, hooksFromConfig,
} from '../src/kernel/hooks.js';
import { resolveMcpHeaders, loadProjectMcpConfig, saveProjectMcpConfig } from '../src/kernel/mcp.js';

// ── P2-A ─────────────────────────────────────────────────────────
describe('P2-A：parseHookKey（事件[:匹配器] 键解析）', () => {
  it('裸键 → 无 matcher；带冒号键 → 事件+匹配器；未收录事件 → null', () => {
    expect(parseHookKey('preToolUse')).toEqual({ event: 'preToolUse' });
    expect(parseHookKey('preToolUse:bash')).toEqual({ event: 'preToolUse', matcher: 'bash' });
    expect(parseHookKey('preToolUse:fs_*')).toEqual({ event: 'preToolUse', matcher: 'fs_*' });
    expect(parseHookKey('notification:jobs')).toEqual({ event: 'notification', matcher: 'jobs' });
    expect(parseHookKey('bogus:x')).toBeNull();
    expect(parseHookKey('')).toBeNull();
  });
});

describe('P2-A：hookKeyMatches（通配/前缀）', () => {
  it('无通配 → 前缀匹配；* / ? → 锚定通配；空模式 → 全命中', () => {
    // 程序化构造模式（'fs_'+'*'）——字面量免疫隐形字符投毒（T11 教训）
    const fsStar = 'fs_' + '*';
    const q = '?' ;
    expect(hookKeyMatches('bash', 'bash')).toBe(true);
    expect(hookKeyMatches('bash', 'bash -c ls')).toBe(true); // 前缀
    expect(hookKeyMatches('bash', 'bashxx')).toBe(true); // 前缀语义（kimi matcher 同为子串/前缀族）
    expect(hookKeyMatches('fs', 'fs_write')).toBe(true);
    expect(hookKeyMatches('fs', 'bash')).toBe(false);
    expect(hookKeyMatches(fsStar, 'fs_write')).toBe(true);
    expect(hookKeyMatches(fsStar, 'fsread')).toBe(false); // 锚定：fs_ 前缀必须字面
    expect(hookKeyMatches('mcp__' + '*', 'mcp__github__pr')).toBe(true);
    expect(hookKeyMatches('tool' + q, 'tool1')).toBe(true);
    expect(hookKeyMatches('tool' + q, 'tool12')).toBe(false);
    expect(hookKeyMatches('', 'anything')).toBe(true);
  });
});

describe('P2-A：hookEntriesFromConfig / selectHookEntries（条目筛选）', () => {
  const entries = hookEntriesFromConfig({
    hooks: {
      'preToolUse': 'echo all',
      'preToolUse:bash': 'echo bash',
      'preToolUse:fs_*': 'echo fs',
      'notification:jobs': 'echo job',
      'bogus': 'echo x', // 未收录事件忽略
      'stop': '', // 空命令忽略
    },
  });
  it('解析：裸键+带 matcher 键共存；非法/空项剔除', () => {
    expect(entries).toHaveLength(4);
    expect(entries.map(e => e.matcher ?? '')).toEqual(['', 'bash', 'fs_*', 'jobs']);
  });
  it('筛选：事件+值命中（多条全选）；无值事件仅裸键', () => {
    expect(selectHookEntries(entries, 'preToolUse', 'bash')).toHaveLength(2); // 裸键 + bash 键
    expect(selectHookEntries(entries, 'preToolUse', 'fs_write')).toHaveLength(2); // 裸键 + fs_*
    expect(selectHookEntries(entries, 'preToolUse', 'ls')).toHaveLength(1); // 仅裸键
    expect(selectHookEntries(entries, 'notification', 'jobs')).toHaveLength(1);
    expect(selectHookEntries(entries, 'notification', 'cron')).toHaveLength(0);
    expect(selectHookEntries(entries, 'stop')).toHaveLength(0);
  });
  it('hooksFromConfig 兼容视图：仅裸键进映射（既有消费者零漂移）', () => {
    expect(hooksFromConfig({ hooks: { 'preToolUse': 'echo all', 'preToolUse:bash': 'echo b' } })).toEqual({ preToolUse: 'echo all' });
  });
});

// ── P2-B ─────────────────────────────────────────────────────────
describe('P2-B：resolveMcpHeaders（env: 引用 fail-closed）', () => {
  it('env:NAME 从环境解析；字面值直传；缺引用 → 抛错不发空鉴权头', () => {
    expect(resolveMcpHeaders({ name: 'srv', headers: { Authorization: 'env:MY_TOKEN', 'X-Static': 'abc' } }, { MY_TOKEN: 'tok1' } as NodeJS.ProcessEnv))
      .toEqual({ Authorization: 'tok1', 'X-Static': 'abc' });
    expect(() => resolveMcpHeaders({ name: 'srv', headers: { 'X-Missing': 'env:NOPE_XYZ' } }, {} as NodeJS.ProcessEnv))
      .toThrow(/NOPE_XYZ/);
    expect(resolveMcpHeaders({ name: 'srv' })).toEqual({});
  });
});

describe('P2-B：MCP 配置校验（headers 仅 HTTP + 序列化回写）', () => {
  it('HTTP server 合法 headers 入配置；stdio 带 headers → 配置错误；HTTP 带 env 仍拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-p2b-'));
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
        mcpServers: { s: { url: 'https://example.com/mcp', headers: { Authorization: 'env:T' } } },
      }), 'utf8');
      const [http] = loadProjectMcpConfig(dir);
      expect(http?.headers).toEqual({ Authorization: 'env:T' });

      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
        mcpServers: { s: { command: 'node', args: ['x'], headers: { A: 'b' } } },
      }), 'utf8');
      expect(() => loadProjectMcpConfig(dir)).toThrow(/headers/);

      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
        mcpServers: { s: { url: 'https://e.com', env: { A: 'b' } } },
      }), 'utf8');
      expect(() => loadProjectMcpConfig(dir)).toThrow(/args 或 env/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('saveProjectMcpConfig 回写 headers（/mcp 改写不丢鉴权头配置）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wxn-p2b2-'));
    try {
      saveProjectMcpConfig(dir, [{ name: 's', command: '', url: 'https://e.com/mcp', headers: { Authorization: 'env:T' } }]);
      const [back] = loadProjectMcpConfig(dir);
      expect(back?.headers).toEqual({ Authorization: 'env:T' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
