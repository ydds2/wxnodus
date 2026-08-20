// tests/kernel-exec-policy.test.ts — supremacy 1.7 execpolicy 首词规则（B-06）：索引 + 等价性 + agent 接线
// 覆盖：firstWordOf 首词提取/通配兜底、索引分桶、候选预筛、判定优先级、
// **安全等价断言**（首词预筛 vs 全量 applyRules 对同一规则集同判定——不漏不误）、agent bash 拒绝路径
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDB, closeDB } from '../src/store/db.js';
import { createEventBus } from '../src/kernel/events.js';
import { createMemory } from '../src/kernel/memory.js';
import { createAgent, type ModelCall, type ToolCallMsg } from '../src/kernel/agent.js';
import { applyRules, type PermRule } from '../src/kernel/permissions.js';
import { firstWordOf, buildExecPolicyIndex, pickExecPolicyCandidates, applyExecPolicy } from '../src/kernel/execPolicy.js';

describe('firstWordOf（首词提取）', () => {
  it('首词 = 首个空白前 token；无空白=整体', () => {
    expect(firstWordOf('git push*')).toBe('git');
    expect(firstWordOf('git')).toBe('git');
    expect(firstWordOf('  npm run *')).toBe('npm');
  });
  it('空 pattern（匹配全部）与首词含通配/字符类 → null（catch-all）', () => {
    expect(firstWordOf('')).toBeNull();
    expect(firstWordOf('   ')).toBeNull();
    expect(firstWordOf('g*t push')).toBeNull();
    expect(firstWordOf('[rg]sync *')).toBeNull();
  });
});

describe('execpolicy 索引与判定', () => {
  const RULES: PermRule[] = [
    { tool: 'bash', pattern: 'git push*', decision: 'deny', reason: '禁止推送', priority: 10 },
    { tool: 'bash', pattern: 'git *', decision: 'allow', reason: 'git 常用操作放行' },
    { tool: 'bash', pattern: 'npm *', decision: 'ask' },
    { tool: 'bash', decision: 'deny', reason: '未收录命令一律确认前拒绝' },
    { tool: 'bash', pattern: 'g*t curl', decision: 'deny', reason: '首词通配兜底' },
    { tool: 'fs_write', pattern: 'src/**', decision: 'allow' }, // 非 bash 规则不进索引
  ];

  it('buildExecPolicyIndex：首词分桶 + 无 pattern/通配首词进 catch-all；非 bash 规则不进索引', () => {
    const idx = buildExecPolicyIndex(RULES);
    expect(idx.byWord.get('git')).toHaveLength(2);
    expect(idx.byWord.get('npm')).toHaveLength(1);
    expect(idx.byWord.has('fs_write')).toBe(false);
    expect(idx.catchAll).toHaveLength(2); // 无 pattern deny + 'g*t curl'
  });

  it('候选预筛：首词桶 + catch-all；无关首词规则不进候选', () => {
    const idx = buildExecPolicyIndex(RULES);
    const git = pickExecPolicyCandidates('git status', idx);
    expect(git.some(r => r.pattern === 'git *')).toBe(true);
    expect(git.some(r => r.pattern === 'npm *')).toBe(false); // 首词无关 → 不可能匹配
    expect(git.some(r => !r.pattern)).toBe(true); // catch-all 恒在
  });

  it('判定：priority 高者先（git push* deny 压过 git * allow）', () => {
    const idx = buildExecPolicyIndex(RULES);
    const r = applyExecPolicy('git push origin main', {}, idx, 'smart')!;
    expect(r.decision).toBe('deny');
    expect(r.rule.pattern).toBe('git push*');
    const r2 = applyExecPolicy('git status', {}, idx, 'smart')!;
    expect(r2.decision).toBe('allow');
  });

  it('未收录命令 → catch-all deny；modes 过滤生效', () => {
    const idx = buildExecPolicyIndex(RULES);
    expect(applyExecPolicy('rm -rf /', {}, idx, 'smart')!.decision).toBe('deny');
    const modes: PermRule[] = [{ tool: 'bash', decision: 'ask', modes: ['yolo'] }];
    const idx2 = buildExecPolicyIndex(modes);
    expect(applyExecPolicy('any', {}, idx2, 'smart')).toBeNull(); // 限定 yolo 模式，smart 不命中
    expect(applyExecPolicy('any', {}, idx2, 'yolo')!.decision).toBe('ask');
  });

  it('**安全等价断言**：首词预筛与全量 applyRules 对 bash 命令判定恒一致（不漏不误）', () => {
    const idx = buildExecPolicyIndex(RULES);
    const commands = [
      'git status', 'git push origin main', 'git push', 'npm install', 'npmx run', 'rm -rf /',
      'g t curl x', 'gt curl', 'curl http://x', '', '  git  log  ', 'GIT STATUS',
    ];
    for (const cmd of commands) {
      const fast = applyExecPolicy(cmd, {}, idx, 'smart');
      const slow = applyRules('bash', { command: cmd }, RULES, 'smart');
      expect(fast?.decision ?? null, `cmd=${cmd}`).toBe(slow?.decision ?? null);
      expect(fast?.rule.pattern ?? null, `cmd=${cmd}`).toBe(slow?.rule.pattern ?? null);
    }
  });
});

describe('agent 接线：bash 规则经首词索引裁决（supremacy 1.7）', () => {
  let dir: string;
  let db: ReturnType<typeof openDB>;
  let bus: ReturnType<typeof createEventBus>;
  let mem: ReturnType<typeof createMemory>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wxn-exp-'));
    db = openDB(dir);
    bus = createEventBus(dir);
    mem = createMemory(db);
  });
  afterAll(() => {
    closeDB(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('permissions.json 的 bash 前缀规则：deny 直拒（不弹审批）、allow 跳过审批（bus 通知）', async () => {
    writeFileSync(join(dir, 'permissions.json'), JSON.stringify([
      { tool: 'bash', pattern: 'git push*', decision: 'deny', denyMessage: '推送请手动执行' },
      { tool: 'bash', pattern: 'git *', decision: 'allow' },
    ]));
    let approvals = 0;
    const notices: string[] = [];
    bus.on('system.notice', (e: any) => notices.push(String(e?.payload?.text ?? '')));
    const script: Array<ModelCall | ToolCallMsg> = [
      { type: 'tool_call', name: 'bash', args: { command: 'git push origin main' } },
      { type: 'tool_call', name: 'bash', args: { command: 'git status' } },
      { type: 'text', content: '完成' },
    ];
    const agent = createAgent({
      db, bus, mem, sessionId: 'exp-' + Math.random().toString(36).slice(2, 8),
      dataDir: dir,
      config: { settings: { baseURL: 'https://mock', model: 'mock' } } as any,
      callModel: async () => script.shift()!,
      onApproval: async () => { approvals++; return true; },
    } as any);
    await agent.run('测试 bash 规则');
    const sessionRow = db.prepare(`SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1`).get() as { id: string };
    const rows = db.prepare(`SELECT content FROM messages WHERE session_id=? AND role='tool' ORDER BY id`).all(sessionRow.id) as Array<{ content: string }>;
    const toolOuts = rows.map(r => r.content);
    expect(toolOuts[0]).toContain('工具被规则拒绝：bash');
    expect(toolOuts[0]).toContain('推送请手动执行');
    expect(toolOuts[1]).not.toContain('工具被规则拒绝'); // allow 规则命中 → 真实执行
    expect(notices.some(n => n.includes('规则放行'))).toBe(true); // allow 命中经 bus 通知（可审计）
    expect(approvals).toBe(0); // deny 直拒 + allow 放行——全程零审批弹窗
  });
});
