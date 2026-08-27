// tests/tui-key-arg.test.ts — 工具关键参数提取（kimi code 风格化，2026-08-28）
import { describe, expect, it } from 'vitest';
import { extractKeyArgument } from '../src/presentation/tui/keyArg.js';

describe('extractKeyArgument（kimi extract_key_argument 语义的表驱动实现）', () => {
  it('表内工具取语义关键字段（Read→path、Bash→command、Grep→pattern）', () => {
    expect(extractKeyArgument({ path: 'a.txt', limit: 10 }, 'fs_read')).toBe('a.txt');
    expect(extractKeyArgument({ command: 'npm test', timeout_ms: 60000 }, 'bash')).toBe('npm test');
    expect(extractKeyArgument({ pattern: 'TODO', head: 200 }, 'grep')).toBe('TODO');
    expect(extractKeyArgument({ url: 'https://x' }, 'http_get')).toBe('https://x');
  });
  it('表外工具回退：首个非空字符串值；无字符串值取首键', () => {
    expect(extractKeyArgument({ q: 1, note: 'hello' }, 'mcp_unknown')).toBe('hello');
    expect(extractKeyArgument({ n: 42 }, 'mcp_unknown')).toBe('n=42');
  });
  it('入参为 JSON 字符串/空/非对象时诚实空串', () => {
    expect(extractKeyArgument('{"path":"b.txt"}', 'fs_read')).toBe('b.txt');
    expect(extractKeyArgument(null, 'fs_read')).toBe('');
    expect(extractKeyArgument([1, 2], 'fs_read')).toBe('');
  });
  it('关键字段非字符串时回退其余字段', () => {
    expect(extractKeyArgument({ path: 5, other: 'x' }, 'fs_read')).toBe('x');
  });
});
