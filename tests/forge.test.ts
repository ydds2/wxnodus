// tests/forge.test.ts — L3-2 组件化构建：MCP Server 锻造/技能打包/注册表/合规标注
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgeMcpServer, forgeSkillDir, type ToolSignature } from '../src/forge/forge.js';
import { createRegistry, type Registry } from '../src/forge/registry.js';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-forge-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('forge MCP Server 锻造', () => {
  it('从工具签名生成可运行 MCP Server（stdio JSON-RPC）', () => {
    const sigs: ToolSignature[] = [{ name: 'calc', description: '计算器', inputSchema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } }];
    const out = forgeMcpServer(join(dir, 'components'), 'calc-server', sigs);
    expect(existsSync(join(out, 'server.js'))).toBe(true);
    expect(existsSync(join(out, 'README.md'))).toBe(true);
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('深度合成'); // 合规红线：AI 生成标注
    const server = readFileSync(join(out, 'server.js'), 'utf8');
    expect(server).toContain('stdio'); // MCP stdio 传输
    expect(server).toContain('calc');
  });
});

describe('forge Skill 打包', () => {
  it('生成 SKILL.md（agentskills 规范 + ai_generated 标注）', () => {
    const out = forgeSkillDir(join(dir, 'skills'), 'my-skill', '描述', '工作流');
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8');
    expect(skill).toContain('ai_generated: true');
    expect(skill).toContain('深度合成');
    expect(skill).toContain('my-skill');
  });
});

describe('组件注册表', () => {
  it('添加/列表/搜索/状态机（quarantine→verified 须证据→installed）', () => {
    const reg: Registry = createRegistry(join(dir, 'registry.json'));
    const id = reg.add({ name: 'calc', kind: 'mcp', source: 'forge', version: '1.0.0' });
    expect(id).toBeTruthy();
    expect(reg.list().length).toBe(1);
    expect(reg.search('calc').length).toBe(1);
    expect(reg.search('nope').length).toBe(0);
    // KF-017 诚实语义：无证据不得伪 verified；验证须经 verify() 携带证据
    reg.setStatus(id, 'verified');
    expect(reg.list()[0].status).toBe('quarantine');
    expect(reg.verify(id, { built: true, sha256: 'a'.repeat(64) })).toMatchObject({ ok: true });
    expect(reg.list()[0].status).toBe('verified');
    reg.setStatus(id, 'installed');
    expect(reg.list()[0].status).toBe('installed');
  });
  it('注册表持久化（重新打开可读回）', () => {
    const reg2 = createRegistry(join(dir, 'registry.json'));
    expect(reg2.list().length).toBe(1);
    expect(reg2.list()[0].name).toBe('calc');
  });
});
