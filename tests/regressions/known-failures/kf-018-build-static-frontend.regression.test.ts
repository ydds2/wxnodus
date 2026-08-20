// tests/regressions/known-failures/kf-018-build-static-frontend.regression.test.ts — KF-018 迁移绿回归
// 契约：脚手架交付可静态部署的前端产物（根 index.html 零依赖兜底页）+ 生成的服务真实静态回退服务它。
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { instantiate } from '../../../src/build/scaffold.js';

// 规则脑分解已移除（2026-08-18）：instantiate 的 plan 参数必传——固定单模块计划
const FIXED_PLAN = { modules: [{ name: 'app', deps: [], desc: '单模块应用' }], order: ['app'], milestones: ['M1 应用构建', 'M2 验证与交付'] };

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } } });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wxn-kf-018-')); tempDirs.push(d); return d; };

describe('KF-018 resolved: 静态前端产物交付', () => {
  it('根 index.html 存在（零依赖兜底页，未构建前端也可静态部署）', () => {
    const dir = tmp();
    const spec = { title: '待办系统', summary: '帮我做一个待办系统', scaffold: 'todo', acceptance: ['能新增任务', '能标记完成', '数据持久化'] };
    const r = instantiate(spec, dir, FIXED_PLAN);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
  });

  it('生成的服务真实静态回退服务根页面（/ 返回 200 + HTML）', async () => {
    const dir = tmp();
    const spec = { title: '待办系统', summary: '帮我做一个待办系统', scaffold: 'todo', acceptance: ['能新增任务', '能标记完成', '数据持久化'] };
    expect(instantiate(spec, dir, FIXED_PLAN).ok).toBe(true);
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [join(dir, 'server', 'index.js')], { cwd: dir, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('server start timeout')), 10000);
        child.stdout.on('data', (c: Buffer) => {
          buf += String(c);
          if (buf.includes('listening')) { clearTimeout(timer); resolve(buf); }
        });
        child.on('error', reject);
      });
      const port = Number((stdout.match(/listening on (\d+)/) ?? [])[1] ?? '');
      expect(port).toBeGreaterThan(0);
      const body = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text());
      expect(body).toContain('<!DOCTYPE html>');
      expect(body).toContain('零依赖兜底');
    } finally {
      child.kill();
    }
  });
});
