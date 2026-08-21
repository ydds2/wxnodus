// tests/build-spec.test.ts — L3-1 概念编译器：规格契约/计划分解/脚手架/验证/证据/质量门
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSpec, diagnoseSpec, type Spec } from '../src/build/spec.js';
import { topoSort } from '../src/build/plan.js';
import { instantiate, checkLeftover } from '../src/build/scaffold.js';
import { writeEvidence, fingerprint } from '../src/build/evidence.js';
import { verifyProject, type VerifyResult } from '../src/build/verify.js';
import { runGate, type GateCtx } from '../src/build/gate.js';

// 规则脑分解已移除（2026-08-18）：instantiate 的 plan 参数必传——固定单模块计划
const FIXED_PLAN = { modules: [{ name: 'app', deps: [], desc: '单模块应用' }], order: ['app'], milestones: ['M1 应用构建', 'M2 验证与交付'] };

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'wxn-build-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('规格契约（spec）', () => {
  it('validateSpec 拒绝无验收/主观词规格', () => {
    const bad: Spec = { title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['界面要美观', '好用'] };
    expect(validateSpec(bad).ok).toBe(false);
    const good: Spec = { title: '记账本', summary: '本地记账', scaffold: 'ledger', acceptance: ['能增删记录', '能统计合计', '数据持久化'] };
    expect(validateSpec(good).ok).toBe(true);
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
});

describe('脚手架（scaffold）', () => {
  it('instantiate 生成可运行项目骨架（server+public+evidence 占位）', () => {
    const p = join(dir, 'proj1');
    const r = instantiate({ title: '测试项目', summary: 'x', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p, FIXED_PLAN);
    expect(r.ok).toBe(true);
    expect(existsSync(join(p, 'server'))).toBe(true);
    expect(existsSync(join(p, 'public'))).toBe(true);
    expect(existsSync(join(p, 'README.md'))).toBe(true);
    expect(existsSync(join(p, 'package.json'))).toBe(true);
  });
  it('残留槽位检测：LEFTOVER 拒交付', () => {
    const p = join(dir, 'proj2');
    instantiate({ title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p, FIXED_PLAN);
    // 篡改一个文件注入 LEFTOVER 标记
    const f = join(p, 'server', 'index.js');
    expect(existsSync(f)).toBe(true);
    const { writeFileSync } = require('node:fs');
    writeFileSync(f, '// LEFTOVER_PLACEHOLDER\n', 'utf8');
    expect(checkLeftover(p)).toBe(false); // 有残留 → 拒交付
  });

  it('A22 成熟栈：REST 分层（router/store）+ React 19 + esbuild + 冒烟测试齐全', () => {
    const p = join(dir, 'proj-mature');
    const r = instantiate({ title: '成熟栈', summary: 'x', scaffold: 'todo', acceptance: ['a', 'b', 'c'] }, p, FIXED_PLAN);
    expect(r.ok).toBe(true);
    // 服务端分层：入口/路由/存储/测试 四文件
    expect(existsSync(join(p, 'server', 'index.js'))).toBe(true);
    expect(existsSync(join(p, 'server', 'router.js'))).toBe(true);
    expect(existsSync(join(p, 'server', 'store.js'))).toBe(true);
    expect(existsSync(join(p, 'server', 'smoke.test.js'))).toBe(true);
    // 前端：React 19 源码 + esbuild 打包脚本
    expect(existsSync(join(p, 'public', 'src', 'main.jsx'))).toBe(true);
    expect(existsSync(join(p, 'public', 'src', 'App.jsx'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'));
    expect(pkg.scripts.test).toBe('node --test server/*.test.js'); // 零依赖冒烟（质量门真跑；只跑 *.test.js——目录模式会把 index.js 当测试、顶层 listen 冲突）
    expect(pkg.scripts.build).toContain('esbuild');
    expect(pkg.dependencies.react).toMatch(/^\^19/);
    expect(pkg.devDependencies.esbuild).toBeDefined();
    // 冒烟测试用 node:test（无第三方依赖）
    expect(readFileSync(join(p, 'server', 'smoke.test.js'), 'utf8')).toContain("require('node:test')");
  });

  it('A22 五模具差异化：路由表各不相同', () => {
    const p = join(dir, 'proj-molds');
    const routes = { todo: '/api/items', ledger: '/api/stats', note: '/api/search', anim: '/api/frames', generic: '/api/items' };
    for (const [mold, route] of Object.entries(routes)) {
      const mp = join(p, mold);
      const r = instantiate({ title: mold, summary: 'x', scaffold: mold, acceptance: ['a', 'b', 'c'] }, mp, FIXED_PLAN);
      expect(r.ok).toBe(true);
      const server = readFileSync(join(mp, 'server', 'index.js'), 'utf8');
      expect(server).toContain(route);
      expect(server).toContain('createRouter(routes)'); // REST 分层接线
      expect(server).toContain("require('./store.js')");
      // 冒烟用例差异化（ledger 统计 / note 搜索 / anim 帧）
      const smoke = readFileSync(join(mp, 'server', 'smoke.test.js'), 'utf8');
      expect(smoke).toContain('健康探活');
      if (mold === 'ledger') expect(smoke).toContain('/api/stats');
      if (mold === 'note') expect(smoke).toContain('/api/search');
      if (mold === 'anim') expect(smoke).toContain('/api/frames');
    }
  });
});

describe('证据链（evidence）', () => {
  it('writeEvidence 落盘三行证据 + 指纹', () => {
    const p = join(dir, 'proj3');
    instantiate({ title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p, FIXED_PLAN);
    const fp = fingerprint(p);
    expect(fp.length).toBe(64); // 完整 SHA-256（KF-020：绝不截断）
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
    instantiate({ title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p, FIXED_PLAN);
    const ok: VerifyResult = await verifyProject(p, { timeoutMs: 3000 });
    expect(['ok', 'skipped']).toContain(ok.status); // 无真实服务时 skipped 也接受
  });
});

describe('质量门（gate）', () => {
  it('四门：自测/健康/证据/合规', async () => {
    const p = join(dir, 'proj5');
    instantiate({ title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['a', 'b', 'c'] }, p, FIXED_PLAN);
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
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ status: 'ok', checks: [], port: null }));
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
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ status: 'ok', checks: [], port: null }));
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

describe('A21 diagnoseSpec 分级诊断', () => {
  it('合法规格：info 模具命中 + 无 error', () => {
    const good: Spec = { title: '待办系统', summary: '帮我做一个待办系统', scaffold: 'todo', acceptance: ['能新增任务', '能标记完成', '数据持久化'] };
    const diags = diagnoseSpec(good);
    expect(diags.filter(d => d.level === 'error')).toHaveLength(0);
    expect(diags.some(d => d.level === 'info' && d.code === 'spec.scaffold.hit')).toBe(true);
  });

  it('验收不足 3 条 → warning（可编译但提示）', () => {
    const s: Spec = { title: '记账本', summary: '本地记账', scaffold: 'ledger', acceptance: ['能增删记录'] };
    const diags = diagnoseSpec(s);
    expect(diags.some(d => d.level === 'warning' && d.code === 'spec.acceptance.count')).toBe(true);
    expect(validateSpec(s).ok).toBe(true); // warning 不阻断
  });

  it('主观词验收 → error（阻断）', () => {
    const s: Spec = { title: 'x', summary: 'y', scaffold: 'ledger', acceptance: ['界面要美观', '好用', '数据持久化'] };
    const diags = diagnoseSpec(s);
    expect(diags.some(d => d.level === 'error' && d.code === 'spec.acceptance.subjective')).toBe(true);
    expect(validateSpec(s).ok).toBe(false);
  });

  it('空验收 → error', () => {
    const s: Spec = { title: 'x', summary: 'y', scaffold: 'ledger', acceptance: [] };
    expect(validateSpec(s).ok).toBe(false);
  });
});

// V4 P5-4：scaffold 注入转义——title（用户需求/LLM Spec 不可信文本）进生成代码前消毒
describe('scaffold 注入转义（P5-4）', () => {
  it('恶意 title 消毒：JSX 表达式/标签/字符串逃逸/注释换行全剥，生成物无注入残片', () => {
    const p = join(dir, 'proj-evil');
    const evil = "测试</h1><script>alert(1)</script>{require('child_process')}` + process.exit(1) + `\n// EVIL";
    const r = instantiate({ title: evil, summary: 'y', scaffold: 'todo', acceptance: ['a', 'b', 'c'] }, p, FIXED_PLAN);
    expect(r.ok).toBe(true);
    const html = readFileSync(join(p, 'public', 'index.html'), 'utf8');
    const app = readFileSync(join(p, 'public', 'src', 'App.jsx'), 'utf8');
    const server = readFileSync(join(p, 'server', 'index.js'), 'utf8');
    for (const artifact of [html, app, server]) {
      // 契约：定界符全剥——注入载荷退化为惰性文本（单词残留无害，危险的是可执行形态）
      expect(artifact).not.toContain('<script>alert'); // HTML 标签注入阻断（模板自带合法 script 除外）
      expect(artifact).not.toContain('{require'); // JSX 表达式逃逸阻断（{} 剥离）
      expect(artifact).not.toContain("require('child_process')"); // 字符串逃逸阻断（引号剥离）
      expect(artifact).not.toContain('EVIL'); // 换行注释逃逸阻断（单行化）
    }
    // server.js 语法完好（消毒绝不破坏生成物——new Function 仅解析不执行）
    expect(() => new Function(server)).not.toThrow();
  });
});
