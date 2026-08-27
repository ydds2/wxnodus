// tests/policy-layers.test.ts — A3 / P1-4（2026-08-27）：三层策略加载与合并语义
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadMergedPolicyRules, loadPolicyLayer, type PolicyRule } from '../src/infrastructure/policy/policyLayers.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-policy-')); dirs.push(d); return d; };

const rule = (tool: string, decision: PolicyRule['decision'], pattern?: string, priority?: number): PolicyRule =>
  ({ tool, decision, ...(pattern ? { pattern } : {}), ...(priority !== undefined ? { priority } : {}) });

describe('A3 三层策略（loadMergedPolicyRules）', () => {
  it('全局 deny 不可被下层放宽：项目 allow 同 key 也无法解禁', () => {
    vi.resetModules();
    const dir = tmp();
    const globalPath = join(dir, 'global.json');
    const userPath = join(dir, 'user.json');
    const projectPath = join(dir, 'project.json');
    writeFileSync(globalPath, JSON.stringify([rule('fs_write', 'deny', 'config/**')]));
    writeFileSync(userPath, JSON.stringify([rule('fs_write', 'allow')]));
    writeFileSync(projectPath, JSON.stringify([rule('fs_write', 'allow', 'config/**')]));
    const env = { WXNODUS_GLOBAL_POLICY: globalPath } as NodeJS.ProcessEnv;
    const merged = loadMergedPolicyRules({
      dataDir: dir, workspaceRoot: join(dir, 'ws'),
      globalPath, // 显式路径覆盖 env
    }, { ...process.env, ...env });
    const denies = merged.rules.filter(r => r.tool === 'fs_write' && r.decision === 'deny');
    expect(denies).toHaveLength(1); // 全局 deny 保留
    expect(denies[0]!.priority).toBe(2000); // 信任序加权（压过任何下层 allow）
    expect(merged.diagnostics).toHaveLength(0);
  });

  it('用户 deny 压过项目 allow（信任序 user > project，+1000 加权）', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'permissions.json'), JSON.stringify([rule('fs_write', 'deny', 'secrets/**')]));
    mkdirSync(join(dir, 'ws', '.wxnodus'), { recursive: true });
    writeFileSync(join(dir, 'ws', '.wxnodus', 'policy.json'), JSON.stringify([rule('fs_write', 'allow', 'secrets/**', 500)]));
    const merged = loadMergedPolicyRules({ dataDir: dir, workspaceRoot: join(dir, 'ws') });
    const denies = merged.rules.filter(r => r.decision === 'deny' && r.pattern === 'secrets/**');
    expect(denies).toHaveLength(1);
    expect(denies[0]!.priority).toBe(1000); // > 项目 allow 的 500 → deny 生效
  });

  it('allow/ask 同 key 具体层优先：项目 > 用户 > 全局', () => {
    const dir = tmp();
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, JSON.stringify([rule('fs_read', 'ask', 'src/**', 5)]));
    writeFileSync(join(dir, 'permissions.json'), JSON.stringify([rule('fs_read', 'ask', 'src/**', 5)]));
    mkdirSync(join(dir, 'ws', '.wxnodus'), { recursive: true });
    writeFileSync(join(dir, 'ws', '.wxnodus', 'policy.json'), JSON.stringify([rule('fs_read', 'allow', 'src/**', 5)]));
    const merged = loadMergedPolicyRules({ dataDir: dir, workspaceRoot: join(dir, 'ws'), globalPath });
    const hit = merged.rules.filter(r => r.tool === 'fs_read' && r.pattern === 'src/**');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.decision).toBe('allow'); // 项目层胜出
  });

  it('全局文件损坏 → 规则丢弃 + 诊断（绝不静默吞错）', () => {
    const dir = tmp();
    const globalPath = join(dir, 'global.json');
    writeFileSync(globalPath, '{broken json');
    const merged = loadMergedPolicyRules({ dataDir: dir, workspaceRoot: join(dir, 'ws'), globalPath });
    expect(merged.layers[0]!.loadError).toBeTruthy();
    expect(merged.diagnostics.some(d => d.includes('global'))).toBe(true);
    expect(merged.layers[0]!.rules).toHaveLength(0);
  });

  it('非法规则条目跳过并诊断；合法条目保留', () => {
    const dir = tmp();
    const p = join(dir, 'user.json');
    writeFileSync(p, JSON.stringify([rule('fs_read', 'allow'), { tool: 'x', decision: 'nope' }, 'garbage', { tool: 'fs_write', decision: 'deny' }]));
    const layer = loadPolicyLayer('user', p);
    expect(layer.rules).toHaveLength(2);
    expect(layer.loadError).toContain('2 条非法规则');
  });
});
