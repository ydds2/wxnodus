// tests/regressions/known-failures/kf-022-scaffold-build-pipeline.regression.test.ts — KF-022 迁移绿回归
// 契约：scaffold 步骤必须由 BuildPlan（模块拓扑）驱动——instantiate 消费 plan（模块按拓扑序
// 落位 + plan.json 落盘），绝不绕过计划只消费 Spec；plan 必传（规则脑兜底已移除）。
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { instantiate } from '../../../src/build/scaffold.js';
import { topoSort } from '../../../src/build/plan.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-kf-022-')); tempDirs.push(d); return d; };

const spec = { title: '库存管理系统', summary: '多模块库存管理平台，含数据库与前端', scaffold: 'generic', acceptance: ['可运行'] };
const PLAN = { modules: [{ name: 'db', deps: [] as string[], desc: '数据层' }, { name: 'api', deps: ['db'], desc: 'API 层' }, { name: 'frontend', deps: ['api'], desc: '前端' }], order: ['db', 'api', 'frontend'], milestones: [] };

describe('KF-022 resolved: scaffold 由 BuildPlan 驱动', () => {
  it('显式传入 plan：模块按拓扑序落位，plan.json 落盘（真实消费证据）', () => {
    const dir = tmp();
    const r = instantiate(spec, dir, PLAN);
    expect(r.ok).toBe(true);
    const planJson = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as { order: string[] };
    expect(planJson.order).toEqual(topoSort(PLAN.modules));
    expect(planJson.order[0]).toBe('db'); // 拓扑：db 在前（api 依赖 db）
    // 文件完整（模块落位 + 验证/文档/测试统一生成）
    for (const f of ['server/index.js', 'server/router.js', 'server/store.js', 'server/smoke.test.js', 'public/index.html', 'README.md', 'package.json', 'healthcheck.js']) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  it('scaffold.ts 源码消费 BuildPlan/topoSort（源级断言——管道不可再被绕过）', async () => {
    const { readFileSync: read } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = read(resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/build/scaffold.ts'), 'utf8');
    expect(src).toMatch(/BuildPlan|topoSort/);
    expect(src).toContain('plan.json');
    expect(src).not.toContain('plan?'); // plan 必传（可选签名已移除）
  });
});
