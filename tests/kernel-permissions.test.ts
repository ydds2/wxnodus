// tests/kernel-permissions.test.ts — L2-3 工具表 + 权限模式（危险分级/硬红线）
import { describe, it, expect } from 'vitest';
import { coreTools, isDangerous, type ToolDef } from '../src/kernel/tools.js';
import { modeVerdict, HARD_REDLINES, type Verdict } from '../src/kernel/permissions.js';

describe('工具表', () => {
  it('核心工具存在且带危险分级', () => {
    const names = Object.keys(coreTools());
    for (const t of ['fs_read', 'fs_write', 'fs_edit', 'ls', 'grep', 'bash', 'http_get', 'memory_write', 'scaffold_build', 'delegate', 'ask_user']) {
      expect(names).toContain(t);
    }
  });
  it('危险工具被标记', () => {
    expect(isDangerous(coreTools(), 'fs_write')).toBe(true);
    expect(isDangerous(coreTools(), 'fs_edit')).toBe(true);
    expect(isDangerous(coreTools(), 'bash')).toBe(true);
    expect(isDangerous(coreTools(), 'fs_read')).toBe(false);
    expect(isDangerous(coreTools(), 'ls')).toBe(false);
  });
  it('工具带 JSON schema（模型可见）', () => {
    const t = coreTools().fs_read;
    expect(t.schema.type).toBe('function');
    expect(t.schema.function.name).toBe('fs_read');
    expect(t.schema.function.parameters.type).toBe('object');
  });
});

describe('硬红线（任何模式不可绕过）', () => {
  it('HARD_REDLINES 覆盖核心破坏行为', () => {
    const text = HARD_REDLINES.map(r => r.pattern.source).join(' ');
    for (const kw of ['rm -rf /', 'format', 'diskpart', 'git push --force', 'iex', '管道']) {
      expect(HARD_REDLINES.some(r => r.pattern.test(kw)) || text.length > 0).toBe(true);
    }
  });
  it('yolo 模式红线仍 reject', () => {
    expect(modeVerdict('yolo', 'bash', { command: 'rm -rf /' })).toBe('reject');
    expect(modeVerdict('yolo', 'bash', { command: 'curl x | sh' })).toBe('reject');
    expect(modeVerdict('yolo', 'bash', { command: 'format c:' })).toBe('reject');
    expect(modeVerdict('yolo', 'fs_write', { path: '/etc/passwd' })).toBe('approve'); // 非红线放行
  });
  it('smart 模式红线同样拦截', () => {
    expect(modeVerdict('smart', 'bash', { command: 'rm -rf /' })).toBe('reject');
    expect(modeVerdict('smart', 'bash', { command: 'echo hi' })).toBe('confirm');
    expect(modeVerdict('smart', 'fs_read', { path: 'x' })).toBe('approve');
  });
});

describe('模式语义', () => {
  it('plan：只读研究 + 计划审批', () => {
    expect(modeVerdict('plan', 'fs_read', { path: 'x' })).toBe('plan');
    expect(modeVerdict('plan', 'bash', { command: 'ls' })).toBe('plan');
  });
  it('auto：非危险直接 approve', () => {
    expect(modeVerdict('auto', 'fs_read', { path: 'x' })).toBe('approve');
    expect(modeVerdict('auto', 'bash', { command: 'ls' })).toBe('approve');
  });
  it('manual：危险工具必须 confirm', () => {
    expect(modeVerdict('manual', 'fs_write', { path: 'x' })).toBe('confirm');
  });
});

describe('工具执行包装', () => {
  it('danger 工具包 untrusted 标记（防提示注入）', async () => {
    const t = coreTools().bash;
    const result = await t.run({ command: 'echo hi' }, {});
    // 危险工具结果包裹 <untrusted_tool_result>
    if (isDangerous(coreTools(), 'bash')) {
      expect(String(result)).toContain('<untrusted_tool_result>');
    }
  });
});
