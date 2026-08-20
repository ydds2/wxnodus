// tests/kernel-projectScan.test.ts — L2-7 /init 项目分析：本地扫描生成 AGENTS.md
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject, renderAgentsMd } from '../src/kernel/projectScan.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wx-init-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scanProject 本地扫描', () => {
  it('识别 Node 项目与构建/测试命令', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { build: 'tsc', test: 'vitest', start: 'node dist/index.js' } }));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules'));
    const p = scanProject(dir);
    expect(p.type).toBe('Node.js/TypeScript');
    expect(p.buildCmd).toBe('npm run build');
    expect(p.testCmd).toBe('npm test');
    expect(p.runCmd).toBe('npm start');
    expect(p.structure).toContain('src/');
    expect(p.structure).not.toContain('node_modules/'); // 忽略目录过滤
  });
  it('识别 Python 与 Go 项目', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]');
    expect(scanProject(dir).type).toBe('Python');
    rmSync(join(dir, 'pyproject.toml'));
    writeFileSync(join(dir, 'go.mod'), 'module demo');
    const p = scanProject(dir);
    expect(p.type).toBe('Go');
    expect(p.testCmd).toBe('go test ./...');
  });
  it('README 摘要截取', () => {
    writeFileSync(join(dir, 'README.md'), '# Demo\n' + 'x'.repeat(3000));
    expect(scanProject(dir).readme.length).toBeLessThanOrEqual(1500);
  });
});

describe('renderAgentsMd 生成', () => {
  it('生成中文结构文档且含真实扫描数据', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }));
    const md = renderAgentsMd(scanProject(dir));
    expect(md).toContain('# AGENTS.md');
    expect(md).toContain('Node.js/TypeScript');
    expect(md).toContain('npm test');
    expect(md).toContain('/init');
    expect(md).toContain('约定');
  });
  it('空目录也能生成（不抛错）', () => {
    const md = renderAgentsMd(scanProject(dir));
    expect(md.length).toBeGreaterThan(50);
  });
});

// ── P3b：更多项目形态与渲染真实性 ──
describe('scanProject 更多形态', () => {
  it('go.mod 识别 Go 项目', () => {
    writeFileSync(join(dir, 'go.mod'), 'module demo\n\ngo 1.22');
    mkdirSync(join(dir, 'cmd'));
    const p = scanProject(dir);
    expect(p.type).toBe('Go');
    expect(p.structure).toContain('cmd/');
  });
  it('Python 项目运行命令', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]');
    writeFileSync(join(dir, 'main.py'), 'print(1)');
    const p = scanProject(dir);
    expect(p.type).toBe('Python');
    expect(p.runCmd).toContain('python');
  });
  it('README 被采集进 profile', () => {
    writeFileSync(join(dir, 'README.md'), '# Demo 项目说明');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
    const p = scanProject(dir);
    expect(p.readme).toContain('Demo');
  });
  it('renderAgentsMd 输出真实扫描事实（非占位）', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '事实项目', scripts: { build: 'tsc' } }));
    mkdirSync(join(dir, 'lib'));
    const p = scanProject(dir);
    const md = renderAgentsMd(p);
    expect(md).toContain('事实项目');
    expect(md).toContain('lib/');
    expect(md).toContain('npm run build');
    expect(md).not.toContain('TODO');
    expect(md).not.toContain('待补充');
  });
});
