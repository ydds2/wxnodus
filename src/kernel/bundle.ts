// src/kernel/bundle.ts — 场景整合包（Modpack 对标：把 skill/MCP/插件/配置规整为一个可安装可导出的资源包）
// 清单：data/bundles/<name>.bundle.json；install 复用 market.ts 安装器（skill→data/skills、
// mcp→项目 .mcp.json、plugin→提示走 /plugin 管线）；export 打包 manifest + 已安装技能 vendoring
// （离线分发——像 Minecraft 整合包一样把 mods 打进去）；use 把 config.settings 并入项目配置
// （B-05 分层——该 cwd 后续会话即场景生产会话）。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installMcpFromNpm, installSkillFromNpm, installSkillFromGithub, installSkillDir, type MarketDeps } from './market.js';
import { mergeProjectSettings } from './projectConfig.js';
import { WXNODUS_VERSION } from './version.js';

export interface BundleManifest {
  name: string;
  description: string;
  version: string;
  skills: string[];   // npm:<pkg> 或 github:<owner>/<repo>
  mcps: string[];     // npm:<pkg>（npx 命令形式）
  plugins: string[];  // 引用名（安装走 /plugin 管线）
  config?: { settings?: Record<string, any>; mode?: string };
  /** V4 P5-3：版本指纹——创建时的 wxnodus 版本（对方安装时兼容性校验依据） */
  wxnodus?: string;
  /** V4 P5-3：最低兼容版本（打包者显式声明；缺省不设限——向后兼容旧包） */
  wxnodusMin?: string;
}

export const bundleDir = (dataDir: string): string => join(dataDir, 'bundles');
export const bundlePath = (dataDir: string, name: string): string => join(bundleDir(dataDir), `${name}.bundle.json`);

const BUNDLE_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/i;

export const createBundle = (dataDir: string, name: string, description: string): { ok: boolean; message: string; manifest?: BundleManifest } => {
  const n = name.trim().toLowerCase();
  if (!BUNDLE_NAME_RE.test(n)) return { ok: false, message: '名称非法（小写字母数字 ._- 开头非数字，≤64 字符）' };
  if (existsSync(bundlePath(dataDir, n))) return { ok: false, message: `整合包 ${n} 已存在（/bundle list 查看）` };
  const manifest: BundleManifest = { name: n, description: description.trim() || '场景整合包', version: '1.0.0', skills: [], mcps: [], plugins: [], wxnodus: WXNODUS_VERSION };
  mkdirSync(bundleDir(dataDir), { recursive: true });
  writeFileSync(bundlePath(dataDir, n), JSON.stringify(manifest, null, 2), 'utf8');
  return { ok: true, message: `已创建整合包 ${n}（${bundlePath(dataDir, n)}）`, manifest };
};

export const loadBundle = (dataDir: string, name: string): { ok: boolean; message: string; manifest?: BundleManifest } => {
  const p = bundlePath(dataDir, name.trim().toLowerCase());
  try {
    if (!existsSync(p)) return { ok: false, message: `整合包不存在：${name}（/bundle list 查看）` };
    const m = JSON.parse(readFileSync(p, 'utf8')) as BundleManifest;
    // N-2 修复：name 必须过 BUNDLE_NAME_RE——一处校验保护 saveBundle/editBundle/exportBundle/useBundle/importBundle
    // 全部写路径（防清单篡改/损坏清单的路径穿越）
    if (!m || typeof m !== 'object' || typeof m.name !== 'string' || !BUNDLE_NAME_RE.test(m.name)
      || !Array.isArray(m.skills) || !Array.isArray(m.mcps) || !Array.isArray(m.plugins)) {
      return { ok: false, message: `整合包清单损坏：${name}` };
    }
    return { ok: true, message: '', manifest: m };
  } catch (e: any) { return { ok: false, message: `读取失败：${String(e?.message ?? e).slice(0, 120)}` }; }
};

/** 资源引用 → 技能目录名推导（npm 包末段 / github repo 名）——export vendoring 与 install 幂等跳过共用。 */
export const skillDirHint = (ref: string): string => {
  const clean = ref.trim().replace(/^npm:/, '').replace(/^github:[\w.-]+\//, '');
  return clean.split('/').pop() ?? '';
};

/** 解包树安全校验（zip-slip 防护）：深度 ≤4（真实结构 <name>/vendored/<skill>/SKILL.md 三层目录）、
 * 条目 ≤1000、逐条目 realpath 必须落在 root 内。 */
export const validateExtractedTree = (root: string): { ok: boolean; message: string } => {
  const realRoot = realpathSync(root) + sep;
  let count = 0;
  const walk = (base: string, depth: number): string | null => {
    if (depth > 4) return '目录层级超限（>4 层）';
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (++count > 1000) return '条目数超限（>1000）';
      const full = join(base, e.name);
      try {
        if (!realpathSync(full).startsWith(realRoot)) return `解包条目逃逸根目录：${e.name}`;
      } catch { return `条目不可解析：${e.name}`; }
      if (e.isDirectory()) {
        const err = walk(full, depth + 1);
        if (err) return err;
      }
    }
    return null;
  };
  const err = walk(root, 1);
  return err ? { ok: false, message: err } : { ok: true, message: '' };
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

export interface BundleInstallReport { item: string; ok: boolean; deferred?: boolean; message: string }

/** 安装整合包全部资源（复用 market 安装器；本地已存在技能跳过网络——离线导入流可用；
 * plugin 走 /plugin 管线提示（deferred 标记——不虚报成功，汇总三段分列）。 */
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
    // N-5 配套幂等：本地副本已存在（vendored/先前安装）→ 跳过网络安装（离线导入流不误报失败）
    const hint = skillDirHint(ref);
    if (hint && existsSync(join(dataDir, 'skills', hint))) {
      reports.push({ item: `skill:${ref}`, ok: true, message: '已存在本地副本（vendored/先前安装），跳过网络安装' });
      continue;
    }
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
    reports.push({ item: `plugin:${plugin}`, ok: true, deferred: true, message: `插件安装走既有管线：/plugin install ${plugin}（整合包不代装插件——沙箱/校验契约由 /plugin 持有）` });
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
    // vendoring：已安装到 data/skills 的技能整目录打进包（离线可用）——N-6 cpSync 去 shell 依赖
    const skillsDir = join(dataDir, 'skills');
    const vendored: string[] = [];
    if (existsSync(skillsDir)) {
      const installed = new Set(readdirSync(skillsDir));
      for (const ref of m.skills) {
        const nm = skillDirHint(ref);
        if (!nm || !installed.has(nm)) continue;
        mkdirSync(join(build, m.name, 'vendored'), { recursive: true });
        cpSync(join(skillsDir, nm), join(build, m.name, 'vendored', nm), { recursive: true });
        vendored.push(nm);
      }
    }
    const outDirFinal = outDir ?? dataDir;
    mkdirSync(outDirFinal, { recursive: true });
    // tar 冒号路径坑：cwd + 相对名——先落 build，再落位到输出目录
    const tgzName = `${m.name}-${m.version}.bundle.tgz`;
    const t = spawnSync('tar', ['-czf', tgzName, m.name], { cwd: build, timeout: 60_000, windowsHide: true });
    if (t.status !== 0) return { ok: false, message: `打包失败：${String(t.stderr ?? '').slice(0, 120)}` };
    const tgz = join(outDirFinal, tgzName);
    try {
      rmSync(tgz, { force: true }); // 重复导出 = 重新生成（覆盖合理）
      try {
        renameSync(join(build, tgzName), tgz);
      } catch {
        // N-3：跨盘 EXDEV/占用等 rename 失败 → 拷贝回退；任何路径不抛异常逃逸
        try {
          cpSync(join(build, tgzName), tgz);
          rmSync(join(build, tgzName), { force: true });
        } catch (e2: any) {
          return { ok: false, message: `打包产物落位失败：${String(e2?.message ?? e2).slice(0, 120)}` };
        }
      }
    } catch (e: any) {
      return { ok: false, message: `打包产物落位失败：${String(e?.message ?? e).slice(0, 120)}` };
    }
    return { ok: true, message: `已导出 ${basename(tgz)}（${vendored.length ? `vendored ${vendored.join('、')} ` : ''}离线可分发）`, path: tgz };
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
};

/** 应用整合包到场景：config.settings 并入项目配置（B-05 分层——该 cwd 后续会话即场景生产会话）+
 * N-5 全量安装（skills+MCP 全部落位，本地已存在跳过——「一条命令开场景」闭环）。 */
export async function useBundle(
  manifest: BundleManifest, dataDir: string, cwd: string, deps: MarketDeps = {},
): Promise<{ ok: boolean; message: string }> {
  const parts: string[] = [];
  if (manifest.config?.settings && Object.keys(manifest.config.settings).length) {
    mergeProjectSettings(cwd, manifest.config.settings);
    parts.push(`settings 并入项目配置（${Object.keys(manifest.config.settings).join('、')}——该 cwd 后续会话即场景生产会话）`);
  }
  if (manifest.config?.mode) parts.push(`建议权限模式 ${manifest.config.mode}（/sandbox ${manifest.config.mode} 切换）`);
  const reports = await installBundle(manifest, dataDir, cwd, deps);
  const okR = reports.filter(x => x.ok && !x.deferred).length;
  const defR = reports.filter(x => x.deferred).length;
  if (reports.length) parts.push(`资源安装 ✅ ${okR} · ⏭ ${defR} · ❌ ${reports.length - okR - defR}`);
  parts.push(`技能 ${manifest.skills.length} 项已安装/确认（/reload-skills 后即刻可用）`);
  return { ok: true, message: `场景「${manifest.name}」已应用：\n` + parts.map(p => ` · ${p}`).join('\n') };
}

/** V4 P5-3：当前 wxnodus 版本 ≥ 最低要求（x.y.z 数值比较；非法声明视为兼容——不误拒旧包） */
export function bundleVersionOk(minVersion: string, current: string = WXNODUS_VERSION): boolean {
  // 预发布后缀（-rc.1/-alpha 等）剥除后按主三段比较（4.0.0-rc.1 ≥ 4.0.0 语义）
  const seg = (v: string) => String(v).replace(/^[vV]/, '').split('-')[0]!.split('.').map(Number);
  const a = seg(minVersion);
  const b = seg(current);
  if (a.some(n => !Number.isFinite(n)) || b.some(n => !Number.isFinite(n))) return true;
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  }
  return true;
}

/** 导入整合包（N-1，纯本地零网络）：解包 → 树安全校验 → 清单校验（name 正则）→ 同名拒绝 →
 * vendored 技能经 installSkillDir 原子落位 → 清单落位。tgz 是不可信输入——三道校验任一不过即拒绝。 */
export const importBundle = (tgzPath: string, dataDir: string): { ok: boolean; message: string } => {
  if (!existsSync(tgzPath)) return { ok: false, message: `文件不存在：${tgzPath}` };
  const tmp = mkdtempSync(join(tmpdir(), 'wxn-imp-'));
  try {
    // tgz 先拷入 tmp（tar 冒号路径坑：绝对 Windows 路径会被当远程主机——cwd + 相对名规避）
    cpSync(tgzPath, join(tmp, basename(tgzPath)));
    const t = spawnSync('tar', ['-xzf', basename(tgzPath)], { cwd: tmp, timeout: 60_000, windowsHide: true });
    if (t.status !== 0) return { ok: false, message: `解包失败：${String(t.stderr ?? '').slice(0, 120)}` };
    const tree = validateExtractedTree(tmp);
    if (!tree.ok) return { ok: false, message: `解包树校验失败：${tree.message}` };
    // 有界查找 bundle.json（深度 ≤3，首个命中）
    const findManifest = (base: string, depth: number): string | null => {
      if (depth > 3) return null;
      if (existsSync(join(base, 'bundle.json'))) return join(base, 'bundle.json');
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const hit = findManifest(join(base, e.name), depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    const manifestFile = findManifest(tmp, 1);
    if (!manifestFile) return { ok: false, message: '包内无 bundle.json（非 wxnodus 整合包）' };
    let m: BundleManifest;
    try { m = JSON.parse(readFileSync(manifestFile, 'utf8')) as BundleManifest; } catch { return { ok: false, message: 'bundle.json 解析失败' }; }
    if (!m || typeof m !== 'object' || typeof m.name !== 'string' || !BUNDLE_NAME_RE.test(m.name)
      || !Array.isArray(m.skills) || !Array.isArray(m.mcps) || !Array.isArray(m.plugins)) {
      return { ok: false, message: '整合包清单损坏（name 非法或字段缺失）' };
    }
    // V4 P5-3：版本兼容校验——wxnodusMin 显式声明且当前版本低于下限时明确拒绝
    //（manifest 不兼容时拒绝——卡片验收；旧包无该字段不设限，向后兼容）
    if (typeof m.wxnodusMin === 'string' && !bundleVersionOk(m.wxnodusMin)) {
      return { ok: false, message: `整合包 ${m.name} 需要 wxnodus ≥ ${m.wxnodusMin}（当前 ${WXNODUS_VERSION}）——请先 wxnodus update 升级` };
    }
    if (existsSync(bundlePath(dataDir, m.name))) {
      return { ok: false, message: `整合包 ${m.name} 已存在（/bundle remove ${m.name} 移除或改包名后重试）` };
    }
    const manifestDir = dirname(manifestFile);
    const vendoredDir = join(manifestDir, 'vendored');
    let installed = 0;
    if (existsSync(vendoredDir)) {
      for (const e of readdirSync(vendoredDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = join(vendoredDir, e.name);
        if (!existsSync(join(dir, 'SKILL.md'))) continue;
        const r = installSkillDir(dir, dataDir);
        if (r.ok) installed += 1;
      }
    }
    mkdirSync(bundleDir(dataDir), { recursive: true });
    writeFileSync(bundlePath(dataDir, m.name), JSON.stringify(m, null, 2), 'utf8');
    return { ok: true, message: `已导入 ${m.name} v${m.version}：清单落位 · vendored 技能 ${installed} 个 · 下一步 /bundle use ${m.name}（应用配置并补齐 MCP）` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};
