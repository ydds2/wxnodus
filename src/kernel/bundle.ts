// src/kernel/bundle.ts — 场景整合包（Modpack 对标：把 skill/MCP/插件/配置规整为一个可安装可导出的资源包）
// 清单：data/bundles/<name>.bundle.json；install 复用 market.ts 安装器（skill→data/skills、
// mcp→项目 .mcp.json、plugin→提示走 /plugin 管线）；export 打包 manifest + 已安装技能 vendoring
// （离线分发——像 Minecraft 整合包一样把 mods 打进去）；use 把 config.settings 并入项目配置
// （B-05 分层——该 cwd 后续会话即场景生产会话）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installMcpFromNpm, installSkillFromNpm, installSkillFromGithub, type MarketDeps } from './market.js';
import { mergeProjectSettings } from './projectConfig.js';

export interface BundleManifest {
  name: string;
  description: string;
  version: string;
  skills: string[];   // npm:<pkg> 或 github:<owner>/<repo>
  mcps: string[];     // npm:<pkg>（npx 命令形式）
  plugins: string[];  // 引用名（安装走 /plugin 管线）
  config?: { settings?: Record<string, any>; mode?: string };
}

export const bundleDir = (dataDir: string): string => join(dataDir, 'bundles');
export const bundlePath = (dataDir: string, name: string): string => join(bundleDir(dataDir), `${name}.bundle.json`);

const BUNDLE_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/i;

export const createBundle = (dataDir: string, name: string, description: string): { ok: boolean; message: string; manifest?: BundleManifest } => {
  const n = name.trim().toLowerCase();
  if (!BUNDLE_NAME_RE.test(n)) return { ok: false, message: '名称非法（小写字母数字 ._- 开头非数字，≤64 字符）' };
  if (existsSync(bundlePath(dataDir, n))) return { ok: false, message: `整合包 ${n} 已存在（/bundle list 查看）` };
  const manifest: BundleManifest = { name: n, description: description.trim() || '场景整合包', version: '1.0.0', skills: [], mcps: [], plugins: [] };
  mkdirSync(bundleDir(dataDir), { recursive: true });
  writeFileSync(bundlePath(dataDir, n), JSON.stringify(manifest, null, 2), 'utf8');
  return { ok: true, message: `已创建整合包 ${n}（${bundlePath(dataDir, n)}）`, manifest };
};

export const loadBundle = (dataDir: string, name: string): { ok: boolean; message: string; manifest?: BundleManifest } => {
  const p = bundlePath(dataDir, name.trim().toLowerCase());
  try {
    if (!existsSync(p)) return { ok: false, message: `整合包不存在：${name}（/bundle list 查看）` };
    const m = JSON.parse(readFileSync(p, 'utf8')) as BundleManifest;
    if (!m || typeof m !== 'object' || !Array.isArray(m.skills) || !Array.isArray(m.mcps) || !Array.isArray(m.plugins)) {
      return { ok: false, message: `整合包清单损坏：${name}` };
    }
    return { ok: true, message: '', manifest: m };
  } catch (e: any) { return { ok: false, message: `读取失败：${String(e?.message ?? e).slice(0, 120)}` }; }
};

const saveBundle = (dataDir: string, m: BundleManifest): void => {
  mkdirSync(bundleDir(dataDir), { recursive: true });
  writeFileSync(bundlePath(dataDir, m.name), JSON.stringify(m, null, 2), 'utf8');
};

export const listBundles = (dataDir: string): BundleManifest[] => {
  const dir = bundleDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.bundle.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as BundleManifest; } catch { return null; } })
    .filter((m): m is BundleManifest => !!m);
};

/** 增删资源项：add skill|mcp|plugin <引用>；remove <类别> <引用> */
export const editBundle = (
  dataDir: string, name: string, kind: 'skills' | 'mcps' | 'plugins', ref: string, action: 'add' | 'remove',
): { ok: boolean; message: string } => {
  const r = loadBundle(dataDir, name);
  if (!r.ok || !r.manifest) return r;
  const m = r.manifest;
  const clean = ref.trim();
  if (!clean) return { ok: false, message: '资源引用不能为空（npm:<包名> 或 github:<owner>/<repo>）' };
  if (action === 'add') {
    if (!m[kind].includes(clean)) m[kind].push(clean);
    saveBundle(dataDir, m);
    return { ok: true, message: `已加入 ${kind}：${clean}（${m[kind].length} 项）` };
  }
  const before = m[kind].length;
  m[kind] = m[kind].filter(x => x !== clean);
  saveBundle(dataDir, m);
  return { ok: true, message: before === m[kind].length ? `未找到该项：${clean}` : `已移除 ${kind}：${clean}（${m[kind].length} 项）` };
};

export interface BundleInstallReport { item: string; ok: boolean; message: string }

/** 安装整合包全部资源（复用 market 安装器；plugin 走 /plugin 管线提示——诚实边界） */
export async function installBundle(
  manifest: BundleManifest, dataDir: string, cwd: string, deps: MarketDeps = {},
): Promise<BundleInstallReport[]> {
  const reports: BundleInstallReport[] = [];
  for (const mcp of manifest.mcps) {
    const pkg = mcp.replace(/^npm:/, '').trim();
    const r = await installMcpFromNpm(pkg, cwd, deps);
    reports.push({ item: `mcp:${pkg}`, ok: r.ok, message: r.message });
  }
  for (const skill of manifest.skills) {
    const ref = skill.trim();
    if (ref.startsWith('npm:')) {
      const r = await installSkillFromNpm(ref.slice(4), dataDir, deps);
      reports.push({ item: `skill:${ref}`, ok: r.ok, message: r.message });
    } else if (/^github:[\w.-]+\/[\w.-]+$/.test(ref)) {
      const r = await installSkillFromGithub(ref, dataDir, deps);
      reports.push({ item: `skill:${ref}`, ok: r.ok, message: r.message });
    } else {
      reports.push({ item: `skill:${ref}`, ok: false, message: '引用格式非法（需 npm:<包> 或 github:<owner>/<repo>）' });
    }
  }
  for (const plugin of manifest.plugins) {
    reports.push({ item: `plugin:${plugin}`, ok: true, message: `插件安装走既有管线：/plugin install ${plugin}（整合包不代装插件——沙箱/校验契约由 /plugin 持有）` });
  }
  return reports;
}

/** 导出整合包（tar.gz：manifest + 已安装技能 vendoring——离线可分发的 Modpack 语义） */
export const exportBundle = (dataDir: string, name: string, outDir?: string): { ok: boolean; message: string; path?: string } => {
  const r = loadBundle(dataDir, name);
  if (!r.ok || !r.manifest) return r;
  const m = r.manifest;
  const build = join(tmpdir(), `wxn-bundle-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(build, m.name), { recursive: true });
  try {
    writeFileSync(join(build, m.name, 'bundle.json'), JSON.stringify(m, null, 2), 'utf8');
    // vendoring：已安装到 data/skills 的技能整目录打进包（离线可用）
    const skillsDir = join(dataDir, 'skills');
    const vendored: string[] = [];
    if (existsSync(skillsDir)) {
      const installed = new Set(readdirSync(skillsDir));
      for (const ref of m.skills) {
        const nm = ref.replace(/^npm:/, '').replace(/^github:[\w.-]+\//, '').split('/').pop() ?? '';
        if (!nm || !installed.has(nm)) continue;
        mkdirSync(join(build, m.name, 'vendored'), { recursive: true });
        const cp = spawnSync('xcopy', ['/E', '/I', '/Y', `${join(skillsDir, nm)}\\.`, `${join(build, m.name, 'vendored', nm)}\\`], { timeout: 30_000, windowsHide: true });
        if (cp.status === 0) vendored.push(nm);
      }
    }
    const outDirFinal = outDir ?? dataDir;
    mkdirSync(outDirFinal, { recursive: true });
    // tar 冒号路径坑：cwd + 相对名——先落 build，再 rename 到输出目录（跨目录同盘 rename 原子）
    const tgzName = `${m.name}-${m.version}.bundle.tgz`;
    const t = spawnSync('tar', ['-czf', tgzName, m.name], { cwd: build, timeout: 60_000, windowsHide: true });
    if (t.status !== 0) return { ok: false, message: `打包失败：${String(t.stderr ?? '').slice(0, 120)}` };
    const tgz = join(outDirFinal, tgzName);
    renameSync(join(build, tgzName), tgz);
    return { ok: true, message: `已导出 ${basename(tgz)}（${vendored.length ? `vendored ${vendored.join('、')} ` : ''}离线可分发）`, path: tgz };
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
};

/** 应用整合包到场景：config.settings 并入项目配置（B-05 分层——该 cwd 后续会话即场景生产会话）+ MCP 落 .mcp.json */
export async function useBundle(
  manifest: BundleManifest, dataDir: string, cwd: string, deps: MarketDeps = {},
): Promise<{ ok: boolean; message: string }> {
  const parts: string[] = [];
  if (manifest.config?.settings && Object.keys(manifest.config.settings).length) {
    mergeProjectSettings(cwd, manifest.config.settings);
    parts.push(`settings 并入项目配置（${Object.keys(manifest.config.settings).join('、')}——该 cwd 后续会话即场景生产会话）`);
  }
  if (manifest.config?.mode) parts.push(`建议权限模式 ${manifest.config.mode}（/sandbox ${manifest.config.mode} 切换）`);
  const mcpReports = await installBundle({ ...manifest, skills: [], plugins: [] }, dataDir, cwd, deps);
  const okM = mcpReports.filter(x => x.ok).length;
  if (mcpReports.length) parts.push(`MCP ${okM}/${mcpReports.length} 成功（.mcp.json）`);
  parts.push(`技能 ${manifest.skills.length} 项已登记（/bundle install ${manifest.name} 落位后 /reload-skills 生效）`);
  return { ok: true, message: `场景「${manifest.name}」已应用：\n` + parts.map(p => ` · ${p}`).join('\n') };
}
