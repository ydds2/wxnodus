// tests/kernel-args.test.ts — 自研 CLI 参数解析（--strict-mcp-config 等）
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('--strict-mcp-config 布尔标志解析', () => {
    expect(parseArgs(['-p', '你好', '--strict-mcp-config']).strictMcpConfig).toBe(true);
    expect(parseArgs(['-p', '你好']).strictMcpConfig).toBe(false);
  });
  it('既有标志不回归', () => {
    const o = parseArgs(['-p', '需求', '--json', '-C', 'dir', '-s', 's1']);
    expect(o).toMatchObject({ prompt: '需求', json: true, cwd: 'dir', session: 's1' });
    expect(parseArgs(['--wire']).wire).toBe(true);
  });
  it('--flag=value 与位置参数', () => {
    const o = parseArgs(['--prompt=写测试', 'extra']);
    expect(o.prompt).toBe('写测试');
    expect(o.positional).toEqual(['extra']);
  });
});
