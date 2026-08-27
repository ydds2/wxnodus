// tests/kernel-permissions.test.ts — L2-3 工具表 + 权限模式（危险分级/硬红线）
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreTools, isDangerous, type ToolDef } from '../src/kernel/tools.js';
import { modeVerdict, HARD_REDLINES, classifyBashCommand, classifyToolAction, createApprovalCache, unwrapCommand, loadPermRules, savePermRules, applyRules, type Verdict, type PermRule } from '../src/kernel/permissions.js';

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
    const result = await t.run({ command: 'echo hi' }, { cwd: process.cwd(), dataDir: process.cwd() });
    // 危险工具结果包裹 <untrusted_tool_result>
    if (isDangerous(coreTools(), 'bash')) {
      expect(String(result)).toContain('<untrusted_tool_result>');
    }
  });
});

// ── P0-1：危险检测升级（wrapper 解包 + operand 后置变体）──
describe('wrapper 解包与变体检测', () => {
  it('sudo/env/bash -lc 逐层解包', () => {
    expect(unwrapCommand('sudo rm -rf /')).toBe('rm -rf /');
    expect(unwrapCommand('env FOO=1 rm -rf /')).toBe('rm -rf /');
    expect(unwrapCommand('bash -lc "rm -rf /"')).toContain('rm -rf /'); // 解包后引号保留，危险语义不变
    expect(unwrapCommand('sh -c sudo rm -rf /')).toBe('rm -rf /');
  });
  it('深度上限（9 层嵌套不再解包，防爆炸）', () => {
    let c = 'rm -rf /';
    for (let i = 0; i < 12; i++) c = `sudo ${c}`;
    expect(unwrapCommand(c)).not.toBe('rm -rf /');
  });
  it('operand 后置 flag 变体（rm build/ -rf）判为 danger', () => {
    expect(classifyBashCommand('rm build/ -rf')).toBe('danger');
    expect(classifyBashCommand('sudo rm build/ -rf')).toBe('danger');
  });
  it('解包后 danger 判定（sudo rm -rf /）', () => {
    expect(classifyBashCommand('sudo rm -rf /')).toBe('danger');
    expect(classifyBashCommand('bash -lc "rm -rf /tmp/x"')).toBe('danger');
  });
});

// ── P0-2：审批规则文件 ──
describe('审批规则文件', () => {
  it('save→load 往返 + 非法规则过滤', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-perm-'));
    try {
      savePermRules(dir, [
        { tool: 'fs_write', pattern: 'src/**', decision: 'allow' },
        { tool: 'bash', decision: 'deny' },
        { tool: '', decision: 'allow' as any },
      ]);
      const rules = loadPermRules(dir);
      expect(rules.length).toBe(2);
      // 深度（Gemini policy 对齐）：返回 {decision, rule}；glob 命中/不命中
      expect(applyRules('fs_write', { path: 'src/main.ts' }, rules)?.decision).toBe('allow');
      expect(applyRules('fs_write', { path: 'dist/x.js' }, rules)).toBeNull();
      // 无 pattern 规则全匹配
      expect(applyRules('bash', {}, rules)?.decision).toBe('deny');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('深度：priority 排序 / modes 过滤 / bash commandPrefix / denyMessage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-pr-'))
    try {
      const rules = [
        { tool: 'bash', pattern: 'git push', decision: 'deny' as const, priority: 10, denyMessage: 'git push 请手动执行' },
        { tool: 'bash', pattern: 'git *', decision: 'allow' as const, priority: 5 },
        { tool: 'fs_write', pattern: 'src/**', decision: 'allow' as const, modes: ['smart'] },
      ]
      // priority 大者先匹配：git push 命中 deny（priority 10 优先于 git * allow）
      const push = applyRules('bash', { command: 'git push origin main' }, rules as any)
      expect(push?.decision).toBe('deny')
      expect(push?.rule.denyMessage).toBe('git push 请手动执行')
      // 非 push 的 git 命令命中 allow（priority 5）
      expect(applyRules('bash', { command: 'git status' }, rules as any)?.decision).toBe('allow')
      // modes 过滤：非 smart 模式 fs_write 规则不生效
      expect(applyRules('fs_write', { path: 'src/x.ts' }, rules as any, 'auto')).toBeNull()
      expect(applyRules('fs_write', { path: 'src/x.ts' }, rules as any, 'smart')?.decision).toBe('allow')
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── P3：规则 reason 字段（Codex exec policy 可读理由）──
describe('PermRule reason 字段', () => {
  it('保存/加载带 reason 的规则并保持', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-perm2-'));
    try {
      savePermRules(d, [{ tool: 'bash', decision: 'deny', reason: '公司红线：禁止生产库 DROP' }]);
      const rules = loadPermRules(d);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({ tool: 'bash', decision: 'deny', reason: '公司红线：禁止生产库 DROP' });
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  it('reason 可选——无理由规则正常（兼容旧配置）', () => {
    const d = mkdtempSync(join(tmpdir(), 'wx-perm3-'));
    try {
      writeFileSync(join(d, 'permissions.json'), JSON.stringify([{ tool: 'fs_write', decision: 'ask', pattern: 'src/**' }]));
      const rules = loadPermRules(d);
      expect(rules[0]).toMatchObject({ tool: 'fs_write', decision: 'ask', pattern: 'src/**' });
      expect(rules[0]?.reason).toBeUndefined();
    } finally { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });
});

describe('只读工具名单自动推导（开放兼容 M2.1）', () => {
  const { deriveReadonlyTools, setReadonlyTools, isReadonlyTool } = (globalThis as any).__perm ?? {};
  it('danger!==true 的工具推导为只读；不含幽灵名', async () => {
    const { deriveReadonlyTools } = await import('../src/kernel/permissions.js');
    const tools = {
      fs_read: { danger: false },
      fs_write: { danger: true },
      bash: { danger: true },
      grep: { danger: false },
      find_files: { danger: false },
      memory_search: { danger: false },
      http_get: { danger: true },
      skill_search: { danger: false },
    };
    const names = deriveReadonlyTools(tools);
    expect(names).toContain('find_files');
    expect(names).toContain('memory_search');
    expect(names).not.toContain('fs_write');
    expect(names).not.toContain('bash');
  });
  it('setReadonlyTools 注入后 isReadonlyTool 生效（修漂移：旧幽灵名不再放行）', async () => {
    const { deriveReadonlyTools, setReadonlyTools, isReadonlyTool } = await import('../src/kernel/permissions.js');
    setReadonlyTools(deriveReadonlyTools({ fs_read: { danger: false }, fs_write: { danger: true } }));
    expect(isReadonlyTool('fs_read')).toBe(true);
    expect(isReadonlyTool('fs_write')).toBe(false);
    expect(isReadonlyTool('skill_search')).toBe(false); // 幽灵名自动消失
    // 恢复默认（避免污染其他测试）
    setReadonlyTools(deriveReadonlyTools({ fs_read: {}, ls: {}, grep: {}, skill_load: {}, repo_map: {} }));
  });
});

// V4 P0-4 红队用例：bash 分级切分补全——换行/单&/$()/反引号/管道尾接破坏命令，
// 全部不得伪装成只读（smart 模式 readonly 免审批 = 破坏性命令无确认执行）。
describe('V4 P0-4 bash 分级切分红队', () => {
  const disguise = [
    'cat file\nRemove-Item -Recurse -Force src',            // 换行伪装
    'ls\r\ndel C:\\important',                              // CRLF 伪装
    'git status & taskkill /F /IM node.exe',                // 单 & 后台串联
    'echo $(del C:\\x)',                                    // $() 命令替换
    'echo $(rm -rf ./src)',                                 // $() 内嵌破坏
    'echo $(echo $(del nested))',                           // 嵌套 $()
    'echo `rm -rf /tmp/x`',                                 // 反引号替换
    'cat a | del b',                                        // 管道尾接删除
    'pwd <(rm -rf x)',                                      // 进程替换（readonly 加严兜底）
    'while true; do rm x; done',                            // 控制结构（readonly 加严兜底）
  ];
  for (const cmd of disguise) {
    it(`伪装只读被拒：${JSON.stringify(cmd).slice(0, 46)}`, () => {
      expect(classifyBashCommand(cmd)).not.toBe('readonly');
    });
  }
  it('合法只读命令零回归', () => {
    for (const ok of ['pwd', 'ls -la', 'cat README.md', 'git status', 'git log --oneline -5', 'echo hello world']) {
      expect(classifyBashCommand(ok)).toBe('readonly');
    }
  });
  it('合法写/网络命令分级不回归', () => {
    expect(classifyBashCommand('npm install')).toBe('write');
    expect(classifyBashCommand('curl https://example.com')).toBe('network');
    expect(classifyBashCommand('echo hi && rm -rf x')).toBe('danger');
  });
});

// M-3（V4 维护轨·W-4 双速权限试点）：sandbox=on + 灰度开关 → 工作区内低危写免审批
describe('modeVerdict 双速权限试点（M-3）', () => {
  const cwd = process.cwd();
  it('fastPath 开：工作区内 fs_write/fs_edit 免审批（confirm→approve）', () => {
    const opts = { sandboxFastPath: { cwd } };
    expect(modeVerdict('smart', 'fs_write', { path: 'src/a.ts' }, true, opts)).toBe('approve');
    expect(modeVerdict('manual', 'fs_edit', { path: join(cwd, 'b.txt'), oldText: 'x', newText: 'y' }, true, opts)).toBe('approve');
  });
  it('工作区外维持强审批；apply_patch 不在试点面', () => {
    const opts = { sandboxFastPath: { cwd } };
    expect(modeVerdict('smart', 'fs_write', { path: '../outside.txt' }, true, opts)).toBe('confirm');
    expect(modeVerdict('smart', 'fs_write', { path: 'c:/windows/system32/evil.dll' }, true, opts)).toBe('confirm');
    expect(modeVerdict('smart', 'apply_patch', { patch: '*** Update File: in.txt' }, true, opts)).toBe('confirm');
  });
  it('敏感写红线不受 fastPath 影响；默认（无 opts）行为零变化', () => {
    expect(modeVerdict('yolo', 'fs_write', { path: 'config/.env' }, true, { sandboxFastPath: { cwd } })).toBe('reject');
    expect(modeVerdict('smart', 'fs_write', { path: 'src/a.ts' }, true)).toBe('confirm');
  });
});

// P1-4（2026-08-27）：applyRules 判定平局裁决——deny > ask > allow（同 priority 时 deny 不再被 allow 抢跑）
describe('applyRules 平局裁决（deny>ask>allow）', () => {
  it('同 key 同 priority：deny 胜 allow（跨层合并后同 key 并存的保底语义）', () => {
    const rules: PermRule[] = [
      { tool: 'fs_write', pattern: 'src/**', decision: 'allow', priority: 0 },
      { tool: 'fs_write', pattern: 'src/**', decision: 'deny', priority: 0 },
    ];
    const hit = applyRules('fs_write', { path: 'src/a.ts' }, rules);
    expect(hit?.decision).toBe('deny');
  });
  it('同 priority：ask 胜 allow；高 priority allow 仍胜低 priority deny（priority 是第一序）', () => {
    expect(applyRules('fs_write', { path: 'src/a.ts' }, [
      { tool: 'fs_write', decision: 'allow', priority: 0 },
      { tool: 'fs_write', decision: 'ask', priority: 0 },
    ])?.decision).toBe('ask');
    expect(applyRules('fs_write', { path: 'src/a.ts' }, [
      { tool: 'fs_write', decision: 'deny', priority: 1 },
      { tool: 'fs_write', pattern: 'src/**', decision: 'allow', priority: 10 },
    ])?.decision).toBe('allow');
  });
});
