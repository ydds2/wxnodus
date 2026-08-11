// tests/kernel-repoMap.test.ts — 仓库地图：符号提取/黑名单过滤/预算截断
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSymbols, buildRepoMap } from '../src/kernel/repoMap.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wx-rmap-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

describe('extractSymbols 语言启发式', () => {
  it('TS：函数/类/接口/类型/枚举', () => {
    const s = extractSymbols('lib.ts', [
      'export function greet(name: string): string {',
      'export class Agent {',
      'export interface ToolDef {',
      'export type Mode = "smart" | "auto";',
      'export enum Level {',
      'const helper = (a: number) => a * 2;',
      'export const pick = async (arr: string[]) => arr[0];',
      'const x = 42;', // 非声明，不提取
      '// export function comment() {}', // 注释跳过
    ].join('\n'));
    expect(s).toEqual([
      'export function greet(name: string): string {',
      'export class Agent {',
      'export interface ToolDef {',
      'export type Mode = "smart" | "auto";',
      'export enum Level {',
      'const helper = (a: number) => a * 2;',
      'export const pick = async (arr: string[]) => arr[0];',
    ]);
  });

  it('Python：def/class；Go：func/type struct；Rust：fn/struct/trait', () => {
    const py = extractSymbols('main.py', 'async def fetch(url):\nclass Server:\n    def start(self):\nvalue = 1');
    expect(py).toEqual(['async def fetch(url):', 'class Server:', 'def start(self):']); // 行首缩进被 trim（紧凑地图）
    const go = extractSymbols('main.go', 'func main() {\ntype Config struct {\nfunc (c *Config) Load() error {');
    expect(go).toContain('func main() {');
    expect(go).toContain('type Config struct {');
    expect(go).toContain('func (c *Config) Load() error {');
    const rs = extractSymbols('lib.rs', 'pub fn run() {}\nstruct Engine;\npub trait Runner {}\nimpl Runner for Engine {}');
    expect(rs).toContain('pub fn run() {}');
    expect(rs).toContain('struct Engine;');
    expect(rs).toContain('pub trait Runner {}');
    expect(rs).toContain('impl Runner for Engine {}');
  });

  it('不支持的语言返回空；注释与长行截断', () => {
    expect(extractSymbols('data.json', '{"a":1}')).toEqual([]);
    const long = extractSymbols('a.ts', `export function veryLongName${'x'.repeat(200)}(a: string) {`);
    expect(long[0]!.length).toBeLessThanOrEqual(120 + 1);
    expect(long[0]).toMatch(/…$/);
  });
});

describe('buildRepoMap 扫描与预算', () => {
  it('真实工程：提取符号、跳过黑名单与二进制', () => {
    const d = tmp();
    mkdirSync(join(d, 'src'), { recursive: true });
    mkdirSync(join(d, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(d, 'dist'), { recursive: true });
    writeFileSync(join(d, 'src', 'agent.ts'), 'export class Agent {}\nexport function run() {}\nconst data = 1;');
    writeFileSync(join(d, 'src', 'util.py'), 'def helper():\n    pass\nclass Tool:');
    writeFileSync(join(d, 'main.go'), 'package main\nfunc main() {\ntype Opt struct {');
    writeFileSync(join(d, 'node_modules', 'pkg', 'index.js'), 'export function ignored() {}');
    writeFileSync(join(d, 'dist', 'bundle.js'), 'export function ignored2() {}');
    writeFileSync(join(d, 'logo.png'), 'not-really-png');
    writeFileSync(join(d, 'README.md'), '# demo');
    const r = buildRepoMap(d, { budgetTokens: 2000 });
    expect(r.skipped).toBe(1); // png 二进制文件被跳过（node_modules 整棵目录不计数）
    expect(r.scanned).toBe(4); // agent.ts / util.py / main.go / README.md
    expect(r.map).toContain('# 仓库地图');
    expect(r.map).toContain('src/agent.ts');
    expect(r.map).toContain('export class Agent {}');
    expect(r.map).toContain('src/util.py');
    expect(r.map).toContain('func main() {');
    expect(r.map).not.toContain('ignored');
    expect(r.map).not.toContain('logo.png');
    // 确定性：两次构建输出一致
    expect(buildRepoMap(d).map).toBe(r.map);
  });

  it('预算截断：小预算仅纳入高权重文件并标注', () => {
    const d = tmp();
    mkdirSync(join(d, 'src'), { recursive: true });
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(d, 'src', `f${i}.ts`), `export function fn${i}() {}\nexport class C${i} {}\nexport const k${i} = ${i};`);
    }
    const r = buildRepoMap(d, { budgetTokens: 10 });
    expect(r.truncated).toBeGreaterThan(0);
    expect(r.map).toContain('预算截断');
    expect(r.files.length).toBeLessThan(8);
    // 截断后文件数 + 截断数 = 总文件数
    expect(r.files.length + r.truncated).toBe(8);
  });
});
