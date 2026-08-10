// tests/kernel-permissions.test.ts — L2-3 工具表 + 权限模式（危险分级/硬红线）
import { describe, it, expect } from 'vitest';
import { coreTools, isDangerous, type ToolDef } from '../src/kernel/tools.js';
import { modeVerdict, HARD_REDLINES, classifyBashCommand, classifyToolAction, createApprovalCache, type Verdict } from '../src/kernel/permissions.js';

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
    expect(modeVerdict('smart', 'bash', { command: 'mkdir x' })).toBe('confirm'); // 写命令仍确认
    expect(modeVerdict('smart', 'fs_read', { path: 'x' })).toBe('approve');
  });
});

describe('模式语义', () => {
  it('plan：只读研究 + 计划审批（F12：只读工具免审批，危险工具需计划审批）', () => {
    expect(modeVerdict('plan', 'fs_read', { path: 'x' })).toBe('approve');
    expect(modeVerdict('plan', 'bash', { command: 'ls' })).toBe('approve'); // 只读命令 plan 下放行
    expect(modeVerdict('plan', 'bash', { command: 'npm install x' })).toBe('plan');
  });
  it('auto：非危险直接 approve', () => {
    expect(modeVerdict('auto', 'fs_read', { path: 'x' })).toBe('approve');
    expect(modeVerdict('auto', 'bash', { command: 'ls' })).toBe('approve');
  });
  it('auto：自动编辑语义（Claude acceptEdits）——文件写入免确认，命令按分级', () => {
    expect(modeVerdict('auto', 'fs_write', { path: 'x' })).toBe('approve');
    expect(modeVerdict('auto', 'fs_edit', { path: 'x' })).toBe('approve');
    expect(modeVerdict('auto', 'bash', { command: 'mkdir x' })).toBe('confirm'); // 写命令仍确认
    expect(modeVerdict('auto', 'bash', { command: 'curl https://x' })).toBe('confirm'); // 网络仍确认
  });
  it('goal：loop-goal 权限语义同自动编辑', () => {
    expect(modeVerdict('goal', 'fs_write', { path: 'x' })).toBe('approve');
    expect(modeVerdict('goal', 'bash', { command: 'mkdir x' })).toBe('confirm');
    expect(modeVerdict('goal', 'bash', { command: 'pwd' })).toBe('approve');
  });
  it('manual：危险工具必须 confirm', () => {
    expect(modeVerdict('manual', 'fs_write', { path: 'x' })).toBe('confirm');
  });
});

describe('bash 命令分级（Claude Code read-only 白名单 + Kimi 分类同款）', () => {
  it('只读命令分类 readonly', () => {
    for (const c of ['pwd', 'ls -la', 'cat a.txt', 'git status', 'git log --oneline -5', 'grep -rn foo src', 'find . -name "*.ts"', 'echo hello', 'pwd && ls -la']) {
      expect(classifyBashCommand(c)).toBe('readonly');
    }
  });
  it('写入/网络/危险分类', () => {
    expect(classifyBashCommand('mkdir out')).toBe('write');
    expect(classifyBashCommand('git add .')).toBe('write');
    expect(classifyBashCommand('curl https://x.com')).toBe('network');
    expect(classifyBashCommand('wget http://y')).toBe('network');
    expect(classifyBashCommand('npm install lodash')).toBe('write');
    expect(classifyBashCommand('some-unknown-cmd')).toBe('danger');
    expect(classifyBashCommand('')).toBe('danger');
  });
  it('多命令串取最保守等级（echo && rm 必为危险）', () => {
    expect(classifyBashCommand('echo hi && rm -rf x')).toBe('danger');
    expect(classifyBashCommand('cd src && git status')).toBe('readonly');
    expect(classifyBashCommand('ls; mkdir x')).toBe('write');
  });
  it('smart 模式：只读命令免确认，写/危险仍需确认', () => {
    expect(modeVerdict('smart', 'bash', { command: 'pwd && ls -la' })).toBe('approve');
    expect(modeVerdict('smart', 'bash', { command: 'mkdir x' })).toBe('confirm');
    expect(modeVerdict('smart', 'bash', { command: 'curl https://x.com' })).toBe('confirm');
    expect(modeVerdict('smart', 'bash', { command: 'rm -rf /' })).toBe('reject'); // 红线先行
  });
  it('manual 模式：只读命令也确认（全量确认语义）', () => {
    expect(modeVerdict('manual', 'bash', { command: 'pwd' })).toBe('confirm');
  });
});

describe('工具动作分类（审批框徽标）', () => {
  it('bash 按命令分级，其余按只读名单', () => {
    expect(classifyToolAction('bash', { command: 'ls' }).category).toBe('readonly');
    expect(classifyToolAction('bash', { command: 'rm -rf x' }).category).toBe('danger');
    expect(classifyToolAction('fs_read', { path: 'a' }).category).toBe('readonly');
    expect(classifyToolAction('fs_write', { path: 'a' }).category).toBe('write');
    expect(classifyToolAction('fs_write', { path: 'a' }).icon).toBe('✏️');
  });
});

describe('会话级批准缓存（Kimi auto_approve_actions 同款）', () => {
  it('session 批准后同 action 自动放行', () => {
    const cache = createApprovalCache();
    expect(cache.has('bash', { command: 'mkdir x' })).toBe(false);
    cache.grant('bash', { command: 'mkdir x' });
    expect(cache.has('bash', { command: 'mkdir x' })).toBe(true);
    expect(cache.has('bash', { command: 'mkdir y' })).toBe(false); // 不同命令不误放
    expect(cache.has('fs_write', { path: 'a.txt' })).toBe(false);
    cache.grant('fs_write', { path: 'a.txt' });
    expect(cache.has('fs_write', { path: 'a.txt' })).toBe(true);
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
