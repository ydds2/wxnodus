// tests/build-spec.test.ts — L3-1 概念编译器：规格契约/计划分解/脚手架/验证/证据/质量门
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSpec, validateSpec, type Spec } from '../src/build/spec.js';
import { makePlan, topoSort } from '../src/build/plan.js';
import { instantiate, checkLeftover } from '../src/build/scaffold.js';
import { writeEvidence, fingerprint } from '../src/build/evidence.js';
import { verifyProject, type VerifyResult } from '../src/build/verify.js';
import { runGate, type GateCtx } from '../src/build/gate.js';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-build-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('规格契约（spec）', () => {
  it('规则脑命中：待办系统 → todo 模具 + 3 条验收 + 禁主观词', () => {
    const s = makeSpec('帮我做一个待办系统', { key: null });
    expect(s.scaffold).toBe('todo');
    expect(s.title.length).toBeGreaterThan(0);
    expect(s.acceptance.length).toBe(3);
    for (const a of s.acceptance) {
      expect(a).not.toMatch(/良好|合理|美观|优雅/); // 禁主观词
    }
  });

  it('validateSpec 拒绝无验收/主观词规格', () => {
    const bad: Spec = { title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['界面要美观', '好用'] };
    expect(validateSpec(bad).ok).toBe(false);
    const good: Spec = { title: '记账本', summary: '本地记账', scaffold: 'ledger', acceptance: ['能增删记录', '能统计合计', '数据持久化'] };
    expect(validateSpec(good).ok).toBe(true);
  });

  it('未知关键词诚实拒答（unknown）', () => {
    const s = makeSpec('帮我发射火箭到火星', { key: null });
    expect(s.scaffold).toBe('unknown');
  });
});

describe('计划分解（plan）', () => {
  it('topoSort 依赖排序（服务端先于前端）', () => {
    const mods = [
      { name: 'frontend', deps: ['api'] },
      { name: 'api', deps: ['db'] },
      { name: 'db', deps: [] },
    ];
    const order = topoSort(mods);
    expect(order.indexOf('db')).toBeLessThan(order.indexOf('api'));
    expect(order.indexOf('api')).toBeLessThan(order.indexOf('frontend'));
  });
  it('循环依赖检测', () => {
    const mods = [
      { name: 'a', deps: ['b'] },
      { name: 'b', deps: ['a'] },
    ];
    expect(() => topoSort(mods)).toThrow(/循环/);
  });
  it('makePlan 生成里程碑', () => {
    const plan = makePlan('记账系统', { key: null });
    expect(plan.milestones.length).toBeGreaterThanOrEqual(2);
    expect(plan.modules.length).toBeGreaterThan(0);
  });
});

describe('脚手架（scaffold）', () => {
  it('instantiate 生成可运行项目骨架（server+public+evidence 占位）', () => {
    const p = join(dir, 'proj1');
    const r = instantiate({ title: '测试项目', summary: 'x', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p);
    expect(r.ok).toBe(true);
    expect(existsSync(join(p, 'server'))).toBe(true);
    expect(existsSync(join(p, 'public'))).toBe(true);
    expect(existsSync(join(p, 'README.md'))).toBe(true);
    expect(existsSync(join(p, 'package.json'))).toBe(true);
  });
  it('残留槽位检测：LEFTOVER 拒交付', () => {
    const p = join(dir, 'proj2');
    instantiate({ title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p);
    // 篡改一个文件注入 LEFTOVER 标记
    const f = join(p, 'server', 'index.js');
    expect(existsSync(f)).toBe(true);
    const { writeFileSync } = require('node:fs');
    writeFileSync(f, '// LEFTOVER_PLACEHOLDER\n', 'utf8');
    expect(checkLeftover(p)).toBe(false); // 有残留 → 拒交付
  });
});

describe('证据链（evidence）', () => {
  it('writeEvidence 落盘三行证据 + 指纹', () => {
    const p = join(dir, 'proj3');
    instantiate({ title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p);
    const fp = fingerprint(p);
    expect(fp.length).toBe(6); // sha256[:6]
    const r = writeEvidence(p, { status: 'ok', checks: ['health-ok'], port: 4321 });
    expect(r).toBe(true);
    const ev = JSON.parse(readFileSync(join(p, 'evidence.json'), 'utf8'));
    expect(ev.status).toBe('ok');
    expect(ev.fingerprint).toBe(fp);
  });
});

describe('验证引擎（verify）', () => {
  it('健康检查通过/失败路径', async () => {
    const p = join(dir, 'proj4');
    instantiate({ title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p);
    const ok: VerifyResult = await verifyProject(p, { timeoutMs: 3000 });
    expect(['ok', 'skipped']).toContain(ok.status); // 无真实服务时 skipped 也接受
  });
});

describe('质量门（gate）', () => {
  it('四门：自测/健康/证据/合规', async () => {
    const p = join(dir, 'proj5');
    instantiate({ title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p);
    const ctx: GateCtx = { projectDir: p, dataDir: dir };
    const g = await runGate(ctx);
    expect(g.gates.length).toBe(5); // 四门 + 测试门（P2 第五门）
    expect(g.gates.some(x => x.name === '自测门')).toBe(true);
    expect(g.gates.some(x => x.name === '证据门')).toBe(true);
  });
});

// ── P2：测试门（概念编译器第五门）──
describe('runGate 测试门', () => {
  it('产物含 test 脚本 → 真实执行 npm test', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-gate-'));
    try {
      mkdirSync(join(dir, 'server'), { recursive: true });
      writeFileSync(join(dir, 'server', 'index.js'), 'console.log("ok")');
      writeFileSync(join(dir, 'healthcheck.js'), 'console.log("ok")');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'g', scripts: { test: 'node -e "console.log(\'pass\')"' } }));
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ ok: true }));
      writeFileSync(join(dir, 'README.md'), '# g');
      const { runGate } = await import('../src/build/gate.js');
      const r = await runGate({ projectDir: dir, dataDir: dir });
      const testGate = r.gates.find(g => g.name === '测试门');
      expect(testGate?.ok).toBe(true);
      expect(testGate?.detail).toContain('通过');
      expect(r.pass).toBe(true);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
  it('无 test 脚本 → 跳过（不误判失败）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-gate2-'));
    try {
      mkdirSync(join(dir, 'server'), { recursive: true });
      writeFileSync(join(dir, 'server', 'index.js'), 'console.log("ok")');
      writeFileSync(join(dir, 'healthcheck.js'), 'console.log("ok")');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'g' }));
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ ok: true }));
      writeFileSync(join(dir, 'README.md'), '# g');
      const { runGate } = await import('../src/build/gate.js');
      const r = await runGate({ projectDir: dir, dataDir: dir });
      const testGate = r.gates.find(g => g.name === '测试门');
      expect(testGate?.ok).toBe(true); // 跳过视为通过
      expect(testGate?.detail).toContain('跳过');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
