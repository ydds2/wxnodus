// src/kernel/market.ts — 开放生态目录聚合（P3 评估轮：S-02 市场消费侧——不建自托管中央目录，
// 直接兼容全网开放资源：npm registry（skill/MCP 主流分发渠道）+ GitHub topic 搜索 +
// Claude Code .mcp.json 生态（MCP 服务器 = npx 命令进程）。
// 安全：固定源域名白名单 + checkUrlSafety 逐跳校验 + 超时 + 离线诚实报错；
// 落位复用既有格式：skill → data/skills/<name>/SKILL.md（即刻可发现）；mcp → 项目 .mcp.json。
// 测试注入面：fetchImpl/safety 可注入（注册表响应 mock 用）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checkUrlSafety as realCheckUrlSafety } from './ssrf.js';
import { saveProjectMcpConfig, loadProjectMcpConfig, type McpServerConfig } from './mcp.js';

export type MarketType = 'skill' | 'mcp' | 'plugin';

export interface MarketItem {
  type: MarketType;
  name: string;
  description: string;
  version?: string;
  /** 安装标识：npm 包名 或 github:owner/repo */
  install: string;
  source: 'npm' | 'github';
  stars?: number;
}

export interface MarketDeps {
  fetchImpl?: typeof fetch;
  safety?: (url: string) => Promise<{ ok: boolean; reason?: string }>;
}

/** 固定源白名单（市场只读这些开放平台——非白名单域名一律拒绝，防诱导外联） */
export const MARKET_HOSTS = new Set(['registry.npmjs.org', 'api.github.com', 'codeload.github.com', 'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com']);

export const MARKET_TYPE_KEYWORDS: Record<MarketType, string[]> = {
  skill: ['claude-skill', 'agent-skill', 'skills', 'SKILL.md'],
  mcp: ['mcp', 'modelcontextprotocol'],
  plugin: ['claude-plugin', 'wxnodus-plugin', 'codex-plugin', 'opencode-plugin'],
};

const fetchJson = async (url: string, deps: MarketDeps = {}): Promise<any> => {
  const host = new URL(url).hostname;
  if (!MARKET_HOSTS.has(host)) throw new Error(`市场仅支持 npm/GitHub 开放源——${host} 不在白名单`);
  const safety = deps.safety ?? realCheckUrlSafety;
  const s = await safety(url);
  if (!s.ok) throw new Error(`URL 被 SSRF 防护拒绝：${s.reason ?? 'unknown'}`);
  const f = deps.fetchImpl ?? fetch;
  const r = await f(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'wxnodus-market/1.0', accept: 'application/json' } });
  if (!r.ok) throw new Error(`源返回 ${r.status}`);
  return r.json();
};

/** npm registry 搜索（类型关键字并入查询；无关键字时全类） */
export async function searchNpm(query: string, type?: MarketType, limit = 20, deps: MarketDeps = {}): Promise<MarketItem[]> {
  const q = `${query.trim()} ${type ? MARKET_TYPE_KEYWORDS[type].slice(0, 2).join(' ') : ''}`.trim();
  const data = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${limit}`, deps);
  const objs = Array.isArray(data?.objects) ? data.objects : [];
  return objs.map((o: any) => {
    const p = o?.package ?? {};
    const keywords: string[] = Array.isArray(p.keywords) ? p.keywords : [];
    const itemType: MarketType = keywords.some(k => /mcp|modelcontextprotocol/i.test(k))
      ? 'mcp'
      : keywords.some(k => /skill/i.test(k))
        ? 'skill'
        : keywords.some(k => /plugin/i.test(k))
          ? 'plugin'
          : (type ?? 'plugin');
    return {
      type: itemType,
      name: String(p.name ?? ''),
      description: String(p.description ?? '').slice(0, 120),
      version: p.version ? String(p.version) : undefined,
      install: String(p.name ?? ''),
      source: 'npm' as const,
    };
  });
}

/** GitHub topic 搜索（无需 token 的公共搜索；type → topic 映射） */
export async function searchGithub(query: string, type: MarketType, limit = 20, deps: MarketDeps = {}): Promise<MarketItem[]> {
  const topic = type === 'mcp' ? 'mcp-server' : type === 'skill' ? 'claude-skills' : 'claude-plugin';
  const q = `${query.trim()} topic:${topic}`.replace(/\s+/g, '+');
  const data = await fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${limit}`, deps);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map((r: any) => ({
    type,
    name: String(r.full_name ?? ''),
    description: String(r.description ?? '').slice(0, 120),
    install: `github:${String(r.full_name ?? '')}`,
    source: 'github' as const,
    stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : undefined,
  }));
}

/** npm 包 MCP 安装：写入项目 .mcp.json（Claude Code 生态标准 npx 命令形式——与既有 mcp.ts 完全兼容） */
export async function installMcpFromNpm(pkg: string, cwd: string, deps: MarketDeps = {}): Promise<{ ok: boolean; message: string }> {
  const name = pkg.trim();
  if (!name || /\s/.test(name)) return { ok: false, message: '包名非法' };
  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, deps);
    const version = typeof meta?.version === 'string' ? meta.version : '?';
    const existing = loadProjectMcpConfig(cwd);
    if (existing.some(s => s.name === name)) return { ok: true, message: `MCP ${name} 已在 .mcp.json（无重复添加）` };
    const entry: McpServerConfig = { name, command: 'npx', args: ['-y', name] };
    saveProjectMcpConfig(cwd, [...existing, entry]);
    return { ok: true, message: `已添加 MCP 服务器 ${name}@${version} → .mcp.json（npx -y ${name}；/reload-skills 后工具面生效）` };
  } catch (e: any) {
    return { ok: false, message: `MCP 安装失败：${String(e?.message ?? e).slice(0, 160)}` };
  }
}

/** 解包 tgz 并定位 SKILL.md（返回含 SKILL.md 的目录；无则 null）——npm pack 产物 package/ 前缀
 *  路径处理：GNU tar 把 C:/… 冒号当远程主机语法（Cannot connect to C:）——
 *  以 cwd 传目录、参数只给相对文件名，彻底避开 Windows 冒号路径 */
const extractSkillDir = (tgz: string): string | null => {
  const dir = dirname(tgz);
  const r = spawnSync('tar', ['-xzf', basename(tgz)], { cwd: dir, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (r.status !== 0) return null;
  return walkForSkillMd(dir, dir, 0);
};

/** 深度优先找 SKILL.md（≤3 层，防解包炸弹式目录） */
const walkForSkillMd = (root: string, base: string, depth: number): string | null => {
  if (depth > 3) return null;
  if (existsSync(join(base, 'SKILL.md'))) return base;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const hit = walkForSkillMd(root, join(base, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
};

/** 技能目录原子落位（tmp 校验通过后 rename；目标已存在则覆盖更新） */
const installSkillDir = (srcDir: string, dataDir: string): { ok: boolean; message: string } => {
  const skillFile = join(srcDir, 'SKILL.md');
  let name = '';
  try {
    const text = readFileSync(skillFile, 'utf8');
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (m) {
      const nm = /^name:\s*(.+)$/m.exec(m[1]!);
      if (nm) name = nm[1]!.trim().replace(/["']/g, '');
    }
  } catch { return { ok: false, message: 'SKILL.md 读取失败' }; }
  if (!name || /[\\/:*?"<>|]/.test(name)) return { ok: false, message: `SKILL.md 缺合法 name（got: ${JSON.stringify(name)}）` };
  const dest = join(dataDir, 'skills', name);
  mkdirSync(join(dataDir, 'skills'), { recursive: true }); // 父目录缺失时 rename 会 ENOENT
  const staging = join(tmpdir(), `wxn-skill-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(staging, { recursive: true });
  const cp = spawnSync(process.platform === 'win32' ? 'xcopy' : 'cp', process.platform === 'win32'
    ? ['/E', '/I', '/Y', `${srcDir}\\.`, `${staging}\\`]
    : ['-r', `${srcDir}/.`, `${staging}/`], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (cp.status !== 0) { rmSync(staging, { recursive: true, force: true }); return { ok: false, message: '复制失败' }; }
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);
  return { ok: true, message: `已安装技能 ${name} → data/skills/${name}（/reload-skills 后即刻可用）` };
};

/** npm 包技能安装：registry 元数据 → npm pack → tar 解包 → SKILL.md 校验 → 原子落位 */
export async function installSkillFromNpm(pkg: string, dataDir: string, deps: MarketDeps = {}): Promise<{ ok: boolean; message: string }> {
  const name = pkg.trim();
  if (!name || /\s/.test(name)) return { ok: false, message: '包名非法' };
  const tmp = join(tmpdir(), `wxn-mkt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, deps);
    const tarball = typeof meta?.dist?.tarball === 'string' ? meta.dist.tarball : '';
    if (!tarball) throw new Error('registry 无 dist.tarball');
    const host = new URL(tarball).hostname;
    if (!MARKET_HOSTS.has(host)) throw new Error(`tarball 源不在白名单：${host}`);
    const safety = deps.safety ?? realCheckUrlSafety;
    const s = await safety(tarball);
    if (!s.ok) throw new Error(`tarball 被 SSRF 防护拒绝：${s.reason ?? ''}`);
    const f = deps.fetchImpl ?? fetch;
    const r = await f(tarball, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`下载失败 ${r.status}`);
    const tgz = join(tmp, 'pkg.tgz');
    writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
    const src = extractSkillDir(tgz);
    if (!src) throw new Error('包内无 SKILL.md（非技能包）');
    return installSkillDir(src, dataDir);
  } catch (e: any) {
    return { ok: false, message: `技能安装失败：${String(e?.message ?? e).slice(0, 160)}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** GitHub 仓库技能安装：codeload tarball → 解包 → SKILL.md 校验 → 原子落位 */
export async function installSkillFromGithub(repo: string, dataDir: string, deps: MarketDeps = {}): Promise<{ ok: boolean; message: string }> {
  const r = repo.trim().replace(/^github:/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) return { ok: false, message: '仓库名非法（需 owner/repo）' };
  const tmp = join(tmpdir(), `wxn-mkt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const url = `https://codeload.github.com/${r}/tar.gz/HEAD`;
    const safety = deps.safety ?? realCheckUrlSafety;
    const s = await safety(url);
    if (!s.ok) throw new Error(`被 SSRF 防护拒绝：${s.reason ?? ''}`);
    const f = deps.fetchImpl ?? fetch;
    const resp = await f(url, { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
    const tgz = join(tmp, 'repo.tgz');
    writeFileSync(tgz, Buffer.from(await resp.arrayBuffer()));
    const src = extractSkillDir(tgz);
    if (!src) throw new Error('仓库内无 SKILL.md（非技能仓库）');
    return installSkillDir(src, dataDir);
  } catch (e: any) {
    return { ok: false, message: `技能安装失败：${String(e?.message ?? e).slice(0, 160)}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
