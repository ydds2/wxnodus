// src/application/release/dependencyClosure.ts — DX-04：安装器依赖闭包（fail-closed 完整性校验）
// 生产依赖闭包 = root dependencies 递归展开（node_modules/<pkg>/package.json 的 dependencies 键）；
// dist 全量扫描静态 import / 字面量动态 import 的裸 specifier——任何 specifier 不在闭包内
// （且非 node: 内置、非显式声明）→ INSTALLER_DEPENDENCY_CLOSURE_INCOMPLETE，绝不打包缺依赖的安装器。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { OperationResult } from '../../protocol/results.js';
import { configError } from '../../domain/config/configSchema.js';

export interface DependencyClosure {
  /** node_modules/ 相对路径集合（生产依赖递归闭包内的所有文件） */
  files: Map<string, Buffer>;
  /** 闭包内的包名集合 */
  packages: Set<string>;
}

const isBuiltin = (spec: string): boolean => spec.startsWith('node:') || [
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https', 'net', 'os',
  'path', 'process', 'readline', 'stream', 'tty', 'url', 'util', 'zlib',
].includes(spec);

/** 从 node_modules 递归收集生产依赖闭包（相对 node_modules 的路径 → 字节） */
export function collectDependencyClosure(nodeModulesDir: string, rootDependencies: readonly string[]): DependencyClosure {
  const files = new Map<string, Buffer>();
  const packages = new Set<string>();
  const queue = [...rootDependencies];
  const seen = new Set<string>();
  const walkDir = (dir: string, base: string) => {
    for (const item of readdirSync(dir)) {
      const full = join(dir, item);
      if (statSync(full).isDirectory()) walkDir(full, base);
      else files.set(relative(base, full).split(sep).join('/'), readFileSync(full));
    }
  };
  while (queue.length) {
    const name = queue.shift()!;
    const parts = name.split('/');
    if (seen.has(name)) continue;
    seen.add(name);
    const pkgDir = join(nodeModulesDir, ...parts);
    let manifest: Record<string, unknown> = {};
    try { manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>; } catch { continue; }
    packages.add(name);
    // 闭包收集：包目录内全部文件（嵌套 node_modules 由本队列另行展开，不重复收）
    try {
      walkDir(pkgDir, nodeModulesDir);
    } catch { /* 包目录不可读：跳过（后续 specifier 校验会暴露） */ }
    const deps = manifest.dependencies as Record<string, string> | undefined;
    if (deps) for (const dep of Object.keys(deps)) queue.push(dep);
    // 包自身嵌套 node_modules 内的文件也入包（npm 嵌套布局）
    try {
      const nested = join(pkgDir, 'node_modules');
      for (const item of readdirSync(nested)) queue.push(`${name}/node_modules/${item}`.replace(/\/node_modules\/node_modules/g, '/node_modules'));
    } catch { /* 无嵌套 */ }
  }
  return { files, packages };
}

/** dist 内全部裸 import specifier（静态 + 字面量动态 import）——近似扫描（引号内 '...' 字面量） */
export function scanDistImportSpecifiers(distDir: string): Set<string> {
  const specifiers = new Set<string>();
  const walk = (dir: string) => {
    for (const item of readdirSync(dir)) {
      const full = join(dir, item);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!full.endsWith('.js')) continue;
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.') && !spec.startsWith('/') && !isBuiltin(spec)) specifiers.add(spec);
      }
    }
  };
  walk(distDir);
  return specifiers;
}

/** fail-closed 完整性校验：每个裸 specifier 必须落在闭包内（或显式声明为非字面量动态 import） */
export function verifyDependencyClosure(
  distSpecifiers: ReadonlySet<string>,
  closure: DependencyClosure,
  declaredDynamicImports: readonly string[] = [],
): OperationResult<void> {
  const missing = [...distSpecifiers]
    .filter(spec => !isBuiltin(spec) && !closure.packages.has(spec) && !declaredDynamicImports.includes(spec))
    .sort();
  if (missing.length) {
    return {
      ok: false,
      error: configError('INSTALLER_DEPENDENCY_CLOSURE_INCOMPLETE', 'installer.closure.incomplete', { missing }),
    };
  }
  return { ok: true, value: undefined };
}
