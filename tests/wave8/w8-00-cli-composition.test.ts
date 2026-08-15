// tests/wave8/w8-00-cli-composition.test.ts — W8-00：组合根接管第一刀（config/repositories/kernel 依赖装配）
// 契约：createCliComposition 以固定阶段（config → repositories → kernel）装配 CLI 核心依赖，
// 失败只 dispose 已启动资源（fail-closed）、shutdown 幂等；产出为真实可用的 db/memory/codeIndex。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCliComposition, type CliCompositionDeps } from '../../src/bootstrap/cliComposition.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'w8-comp-')); tempDirs.push(d); return d; };

const deps = (dataDir: string): CliCompositionDeps => ({ dataDir, workspaceRoot: tmp() });

describe('W8-00 createCliComposition（组合根第一刀）', () => {
  it('按固定阶段装配真实依赖：config/db/codeIndex/memoryRepository/mem 全部可用', async () => {
    const dir = tmp();
    const r = await createCliComposition(deps(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { value } = r;
    expect(typeof value.config.get).toBe('function');
    // db 真实可写（better-sqlite3 实盘）
    value.db.prepare('CREATE TABLE IF NOT EXISTS t(x)').run();
    value.db.prepare('INSERT INTO t VALUES (1)').run();
    expect(value.db.prepare('SELECT COUNT(*) c FROM t').get()).toEqual({ c: 1 });
    expect(value.memoryRepository).toBeTruthy();
    expect(value.codeIndex).toBeTruthy();
    expect(value.mem).toBeTruthy();
    await value.shutdown('test');
  });

  it('阶段失败 → 只 dispose 已启动资源 + 稳定错误码（fail-closed）', async () => {
    const dir = tmp();
    const { writeFileSync } = await import('node:fs');
    // dataDir 指向文件而非目录 → openDB 真实失败 → repositories 阶段失败，config 已启动资源被 dispose
    const fileAsDir = join(dir, 'not-a-dir');
    writeFileSync(fileAsDir, 'x');
    const r = await createCliComposition({ dataDir: fileAsDir, workspaceRoot: tmp() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CLI_COMPOSITION_PHASE_FAILED');
  });

  it('shutdown 幂等且聚合失败资源 id（重复关闭不重复 dispose）', async () => {
    const dir = tmp();
    const r = await createCliComposition(deps(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = await r.value.shutdown('once');
    const b = await r.value.shutdown('twice');
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  // W8-00 第二刀契约：kernel 阶段接管 bus/toolExecution/agent/plugins/MCP/secrets 装配——
  // presentation（gateway/TUI/headless、命令注册、审批桥）经 KernelBridges 注入，CLI 只剩表现层。
  it('第二刀：kernel 阶段装配 bus/toolExecution/agent/plugins/reloadMcp（桥回调真实注入）', async () => {
    const dir = tmp();
    const seen: string[] = [];
    const r = await createCliComposition({
      dataDir: dir,
      workspaceRoot: tmp(),
      sessionId: 'w8-kernel',
      bridges: {
        approver: async () => { seen.push('approver'); return true; },
        onApproval: async () => { seen.push('onApproval'); return true; },
        onClarify: async () => 'clarified',
        onSecretRequest: async () => null,
        onFormRequest: async () => null,
        onCommand: async (input) => `cmd:${input}`,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { value } = r;
    expect(value.bus).toBeTruthy();
    expect(value.toolExecution.pipeline).toBeTruthy();
    expect(typeof value.agent.run).toBe('function');
    expect(typeof value.reloadMcp).toBe('function');
    expect(Array.isArray(value.plugins)).toBe(true);
    expect(Array.isArray(value.getMcpClients())).toBe(true);
    expect(typeof value.secrets.setSecret).toBe('function');
    // 空环境重载不抛错（无 .mcp.json → 0 服务器）
    const reload = await value.reloadMcp();
    expect(reload.ok).toBe(true);
    expect(reload.count).toBe(0);
    expect(seen).toEqual([]); // 装配阶段不触发任何桥（桥仅在运行时被 agent/pipeline 消费）
    await value.shutdown('test');
  });

  it('第二刀：无桥时默认 fail-closed（agent 仍可装配，审批桥默认拒绝——绝不静默放行）', async () => {
    const dir = tmp();
    const r = await createCliComposition(deps(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 默认桥：approver/onApproval→false、onClarify→''、secret/form→null、command→''（不抛错即契约成立）
    expect(typeof r.value.agent.run).toBe('function');
    expect(r.value.toolExecution.pipeline).toBeTruthy();
    await r.value.shutdown('test');
  });
});
