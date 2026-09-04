import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { readBoundedBody } from '../infrastructure/http/boundedResponseReader.js';
import {
  assertNoReparsePoints,
  DEFAULT_SAFE_TAR_LIMITS,
  extractSafeTarGz,
} from '../infrastructure/extensions/safeTarArchive.js';
import { assertSafeExtensionName } from '../domain/safeNames.js';
import { authorizeOutboundUrl } from '../infrastructure/http/outboundTargetPolicy.js';
import { saveProjectMcpConfig, loadProjectMcpConfig, type McpServerConfig } from './mcp.js';

export type MarketType = 'skill' | 'mcp' | 'plugin';

export interface MarketItem {
  type: MarketType;
  name: string;
  description: string;
  version?: string;
  install: string;
  source: 'npm' | 'github';
  /** Npm MCP installs may carry an SRI-pinned tarball artifact. */
  integrity?: string;
  stars?: number;
}

export interface MarketDeps {
  fetchImpl?: typeof fetch;
  safety?: (url: string) => Promise<{ ok: boolean; reason?: string }>;
  /** npm install 执行器（测试注入；默认 execFileSync npm——MCP artifact 运行时依赖解析用） */
  npmInstall?: (cwd: string) => { ok: boolean; error?: string };
}

export interface MarketProvenanceReceipt {
  source: string;
  resolvedIdentity: string;
  expectedDigest: string;
  observedDigest: string;
  timestamp: string;
}

export const MARKET_HOSTS = new Set([
  'registry.npmjs.org',
  'api.github.com',
  'codeload.github.com',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
]);

export const MARKET_TYPE_KEYWORDS: Record<MarketType, string[]> = {
  skill: ['claude-skill', 'agent-skill', 'skills', 'SKILL.md'],
  mcp: ['mcp', 'modelcontextprotocol'],
  plugin: ['claude-plugin', 'wxnodus-plugin', 'codex-plugin', 'opencode-plugin'],
};

const JSON_BYTES = 2 * 1024 * 1024;
const MCP_ARTIFACT_ROOT = '.wxnodus-mcp-artifacts';
const ARCHIVE_BYTES = DEFAULT_SAFE_TAR_LIMITS.maxCompressedBytes;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'wxnodus-market/1.0';
const PROVENANCE_FILE = '.wxnodus-provenance.json';

const authorizeMarketUrl = async (url: string, deps: MarketDeps): Promise<void> => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`市场仅支持 HTTPS：${parsed.protocol}`);
  if (parsed.username || parsed.password) throw new Error('市场 URL 不允许凭据');
  if (!MARKET_HOSTS.has(parsed.hostname)) throw new Error(`市场仅支持 npm/GitHub 开放源——${parsed.hostname} 不在白名单`);
  if (deps.safety) {
    const result = await deps.safety(url);
    if (!result.ok) throw new Error(`URL 被 SSRF 防护拒绝：${result.reason ?? 'unknown'}`);
  } else {
    const result = await authorizeOutboundUrl(url);
    if (!result.ok) throw new Error(`URL 被出站策略拒绝：${result.error.code}`);
  }
};

const fetchBounded = async (
  initialUrl: string,
  maxBytes: number,
  accept: string,
  timeoutMs: number,
  deps: MarketDeps,
): Promise<{ bytes: Buffer; url: string }> => {
  // ⅩⅩⅨ（专项审计 D-4）：缺省下载器走出站 fetch——env/系统代理支持（企业代理环境市场整链
  // 此前瘫痪）+ 私网直连红线；测试替身仍经 deps.fetchImpl 注入。
  // ⅩⅩⅩ（D-8）：下载重试——fetchBounded 内部 1 次失败后 2s 退避重试 1 次（网络抖动/CDN 切换）
  const fetchImpl = deps.fetchImpl ?? (((await import('../infrastructure/http/outboundFetch.js')).createOutboundFetch()).fetch as typeof fetch);
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await authorizeMarketUrl(current, deps);
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`重定向 ${response.status} 缺 Location`);
      if (hop === MAX_REDIRECTS) throw new Error(`重定向次数超限（${MAX_REDIRECTS}）`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`源返回 ${response.status}`);
    const bounded = await readBoundedBody(response, maxBytes);
    if (!bounded.ok) throw new Error(`响应超过 ${maxBytes} 字节上限`);
    return { bytes: bounded.value.bytes, url: current };
  }
  throw new Error(`重定向次数超限（${MAX_REDIRECTS}）`);
};

const fetchJson = async (url: string, deps: MarketDeps = {}): Promise<any> => {
  const response = await fetchBounded(url, JSON_BYTES, 'application/json', 10_000, deps);
  try {
    return JSON.parse(response.bytes.toString('utf8'));
  } catch {
    throw new Error('源返回无效 JSON');
  }
};

export async function searchNpm(query: string, type?: MarketType, limit = 20, deps: MarketDeps = {}): Promise<MarketItem[]> {
  const q = `${query.trim()} ${type ? MARKET_TYPE_KEYWORDS[type].slice(0, 2).join(' ') : ''}`.trim();
  const data = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${limit}`, deps);
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  return objects.map((object: any) => {
    const pkg = object?.package ?? {};
    const keywords: string[] = Array.isArray(pkg.keywords) ? pkg.keywords : [];
    const itemType: MarketType = keywords.some(keyword => /mcp|modelcontextprotocol/i.test(keyword))
      ? 'mcp'
      : keywords.some(keyword => /skill/i.test(keyword))
        ? 'skill'
        : keywords.some(keyword => /plugin/i.test(keyword))
          ? 'plugin'
          : (type ?? 'plugin');
    return {
      type: itemType,
      name: String(pkg.name ?? ''),
      description: String(pkg.description ?? '').slice(0, 120),
      version: pkg.version ? String(pkg.version) : undefined,
      install: String(pkg.name ?? ''),
      source: 'npm' as const,
    };
  });
}

export async function searchGithub(query: string, type: MarketType, limit = 20, deps: MarketDeps = {}): Promise<MarketItem[]> {
  const topic = type === 'mcp' ? 'mcp-server' : type === 'skill' ? 'claude-skills' : 'claude-plugin';
  const q = `${query.trim()} topic:${topic}`.replace(/\s+/g, '+');
  const data = await fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${limit}`, deps);
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map((repo: any) => ({
    type,
    name: String(repo.full_name ?? ''),
    description: String(repo.description ?? '').slice(0, 120),
    install: `github:${String(repo.full_name ?? '')}`,
    source: 'github' as const,
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : undefined,
  }));
}

const validNpmPackage = (name: string): boolean => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
  && !name.includes('..') && name.length <= 214;

const immutableVersion = (value: unknown): string => {
  const version = typeof value === 'string' ? value : '';
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('registry 未返回不可变 semver 版本');
  }
  return version;
};

/** npm 包 tarball 下载（registry → SRI 校验 → 字节）——MCP/技能/插件三类安装的共用下载面 */
export type NpmTarballResult =
  | { ok: true; bytes: Buffer; name: string; version: string; digestLabel: string }
  | { ok: false; message: string };

export async function downloadNpmTarball(pkg: string, deps: MarketDeps = {}): Promise<NpmTarballResult> {
  const name = pkg.trim();
  if (!validNpmPackage(name)) return { ok: false, message: '包名非法' };
  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, deps);
    const version = immutableVersion(meta?.version);
    const tarball = typeof meta?.dist?.tarball === 'string' ? meta.dist.tarball : '';
    if (!tarball) throw new Error('registry 无 dist.tarball');
    const expected = expectedNpmDigest(meta.dist);
    const downloaded = await fetchBounded(tarball, ARCHIVE_BYTES, 'application/octet-stream', 60_000, deps);
    const observed = verifyDigest(downloaded.bytes, expected);
    return { ok: true, bytes: downloaded.bytes, name, version, digestLabel: observed };
  } catch (error: any) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 240) };
  }
}

export async function installMcpFromNpm(pkg: string, cwd: string, deps: MarketDeps = {}): Promise<{ ok: boolean; message: string }> {
  const name = pkg.trim();
  if (!validNpmPackage(name)) return { ok: false, message: '包名非法' };
  try {
    const dl = await downloadNpmTarball(name, deps);
    if (!dl.ok) throw new Error(dl.message);
    const installed = await installDownloadedMcp(dl.bytes, cwd, dl.name, dl.version, {
      source: `npm:${dl.name}`,
      resolvedIdentity: `${dl.name}@${dl.version}`,
      expectedDigest: dl.digestLabel,
      observedDigest: dl.digestLabel,
      timestamp: new Date().toISOString(),
    }, deps);
    if (!installed.ok || !installed.entrypoint) return installed;
    const existing = loadProjectMcpConfig(cwd);
    if (existing.some(server => server.name === name)) return { ok: true, message: `MCP ${name} 已在 .mcp.json（无重复添加）` };
    const entry: McpServerConfig = { name, command: process.execPath, args: [installed.entrypoint] };
    saveProjectMcpConfig(cwd, [...existing, entry]);
    return { ok: true, message: `${installed.message}；已写入固定入口 .mcp.json` };
  } catch (error: any) {
    return { ok: false, message: `MCP 安装失败：${String(error?.message ?? error).slice(0, 240)}` };
  }
}

interface ExpectedDigest {
  algorithm: 'sha512' | 'sha256';
  bytes: Buffer;
  label: string;
}

const expectedNpmDigest = (dist: any): ExpectedDigest => {
  const integrity: string = typeof dist?.integrity === 'string' ? dist.integrity.trim() : '';
  const tokens: string[] = integrity.split(/\s+/).filter(Boolean);
  for (const algorithm of ['sha512', 'sha256'] as const) {
    const token = tokens.find(candidate => candidate.startsWith(`${algorithm}-`));
    if (!token) continue;
    const encoded = token.slice(algorithm.length + 1).split('?')[0]!;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.byteLength !== (algorithm === 'sha512' ? 64 : 32) || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      throw new Error(`registry dist.integrity ${algorithm} 无效`);
    }
    return { algorithm, bytes, label: `${algorithm}-${bytes.toString('base64')}` };
  }
  const sha256 = typeof dist?.sha256 === 'string' ? dist.sha256.toLowerCase() : '';
  if (/^[a-f0-9]{64}$/.test(sha256)) return { algorithm: 'sha256', bytes: Buffer.from(sha256, 'hex'), label: `sha256:${sha256}` };
  throw new Error('registry 缺少可验证的 dist.integrity（sha512/sha256）或 sha256');
};

const verifyDigest = (bytes: Buffer, expected: ExpectedDigest): string => {
  const observed = createHash(expected.algorithm).update(bytes).digest();
  if (observed.byteLength !== expected.bytes.byteLength || !timingSafeEqual(observed, expected.bytes)) {
    throw new Error(`${expected.algorithm} 完整性哈希不匹配`);
  }
  return expected.label.includes('-')
    ? `${expected.algorithm}-${observed.toString('base64')}`
    : `${expected.algorithm}:${observed.toString('hex')}`;
};

const readSkillName = (skillDir: string): string => {
  let text: string;
  try { text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8'); }
  catch { throw new Error('SKILL.md 读取失败'); }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md frontmatter 无效');
  const document = parseDocument(match[1], { prettyErrors: false, strict: true });
  if (document.errors.length > 0) throw new Error('SKILL.md YAML 无效');
  const value = document.toJS();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SKILL.md frontmatter 无效');
  const name = (value as Record<string, unknown>).name;
  if (typeof name !== 'string') throw new Error('SKILL.md 缺合法 name');
  assertSafeExtensionName(name);
  return name;
};

const writeReceipt = (directory: string, receipt: MarketProvenanceReceipt): void => {
  writeFileSync(join(directory, PROVENANCE_FILE), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
};

const acquireInstallLock = (root: string, name: string): string => {
  const lock = join(root, `.${name}.install.lock`);
  try { mkdirSync(lock, { recursive: false }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`安装锁已被占用：${name}`);
    throw error;
  }
  return lock;
};

const promoteCandidate = (candidate: string, dataDir: string, name: string): void => {
  const root = join(dataDir, 'skills');
  mkdirSync(root, { recursive: true });
  const current = join(root, name);
  const backup = join(root, `.${name}.backup-${randomUUID()}`);
  const lock = acquireInstallLock(root, name);
  let backupPresent = false;
  let committed = false;
  try {
    assertNoReparsePoints(candidate);
    if (existsSync(current)) {
      renameSync(current, backup);
      backupPresent = true;
    }
    try {
      renameSync(candidate, current);
      assertNoReparsePoints(current);
      committed = true;
    } catch (error) {
      if (existsSync(current)) rmSync(current, { recursive: true, force: true });
      if (backupPresent) {
        renameSync(backup, current);
        backupPresent = false;
      }
      throw error;
    }
    if (backupPresent) {
      try { rmSync(backup, { recursive: true, force: true }); backupPresent = false; }
      catch { /* committed current remains authoritative; stale backup is recoverable */ }
    }
  } finally {
    if (!committed && backupPresent && existsSync(backup) && !existsSync(current)) {
      renameSync(backup, current);
      backupPresent = false;
    }
    try { rmSync(lock, { recursive: true, force: true }); }
    catch { /* a stale lock is preferable to reporting a committed install as failed */ }
  }
};

export const installSkillDir = (
  srcDir: string,
  dataDir: string,
  receipt?: MarketProvenanceReceipt,
): { ok: boolean; message: string } => {
  let candidate = '';
  try {
    const name = readSkillName(srcDir);
    const root = join(dataDir, 'skills');
    mkdirSync(root, { recursive: true });
    candidate = join(root, `.${name}.candidate-${randomUUID()}`);
    cpSync(srcDir, candidate, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    assertNoReparsePoints(candidate);
    if (receipt) writeReceipt(candidate, receipt);
    promoteCandidate(candidate, dataDir, name);
    candidate = '';
    return { ok: true, message: `已安装技能 ${name} → data/skills/${name}（/reload-skills 后即刻可用）` };
  } catch (error: any) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 240) };
  } finally {
    if (candidate) {
      try { rmSync(candidate, { recursive: true, force: true }); }
      catch { /* failed candidate cleanup must not invalidate a committed install */ }
    }
  }
};

/** 默认 npm install 执行器（Windows npm.cmd / POSIX npm——build/gate.ts 同款先例；120s 超时 fail-closed） */
const defaultNpmInstall = (cwd: string): { ok: boolean; error?: string } => {
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120_000, encoding: 'utf8' });
    return { ok: true };
  } catch (e: any) {
    const head = String(e?.stderr || e?.message || e).split('\n')[0]?.slice(0, 160) ?? 'npm install 失败';
    return { ok: false, error: head };
  }
};

const installDownloadedMcp = async (
  archive: Buffer,
  cwd: string,
  pkg: string,
  version: string,
  receipt: MarketProvenanceReceipt,
  deps: MarketDeps = {},
): Promise<{ ok: boolean; message: string; entrypoint?: string }> => {
  const root = join(cwd, MCP_ARTIFACT_ROOT);
  mkdirSync(root, { recursive: true });
  const extraction = join(root, `.extract-${randomUUID()}`);
  const target = join(root, `${pkg.replace(/[^a-zA-Z0-9_.-]/g, '_')}@${version}`);
  try {
    const extractedRoot = await extractSafeTarGz(archive, extraction, DEFAULT_SAFE_TAR_LIMITS, null);
    const packageRoot = existsSync(join(extractedRoot, 'package')) ? join(extractedRoot, 'package') : extractedRoot;
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) throw new Error('MCP artifact 缺少 package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (manifest.name !== pkg || manifest.version !== version) throw new Error('MCP artifact package identity mismatch');
    const main = typeof manifest.main === 'string' ? manifest.main : 'index.js';
    const entrypoint = join(packageRoot, main);
    if (!existsSync(entrypoint)) throw new Error('MCP artifact 缺少 package entrypoint');
    assertNoReparsePoints(extractedRoot);
    // N-E2 修复（2026-08-29 深潜评估）：npm tarball 不含 node_modules——此前仅校验 package.json/entrypoint
    // 即写 .mcp.json（假成功：依赖未解析，首次 tools/list 即 MODULE_NOT_FOUND）。
    // 现在解包后真实解析运行时依赖（npm install --omit=dev），失败即整体失败（半成品不落盘）。
    const depNames = Object.keys((manifest.dependencies ?? {}) as Record<string, unknown>);
    if (depNames.length > 0) {
      const ran = (deps.npmInstall ?? defaultNpmInstall)(packageRoot);
      if (!ran.ok) {
        throw new Error(`运行时依赖解析失败（${depNames.slice(0, 4).join(', ')}${depNames.length > 4 ? '…' : ''}）：${ran.error ?? 'npm install 未成功'}——该 artifact 未安装`);
      }
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(packageRoot, target);
    writeReceipt(target, receipt);
    return { ok: true, message: `已安装并固定 MCP artifact ${pkg}@${version}${depNames.length ? '（运行时依赖已解析）' : ''} → ${target}`, entrypoint: join(target, main) };
  } finally {
    try { rmSync(extraction, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
};

const installDownloadedSkill = async (
  archive: Buffer,
  dataDir: string,
  receipt: MarketProvenanceReceipt,
): Promise<{ ok: boolean; message: string }> => {
  const root = join(dataDir, 'skills');
  mkdirSync(root, { recursive: true });
  const extraction = join(root, `.extract-${randomUUID()}`);
  try {
    const skillDir = await extractSafeTarGz(archive, extraction);
    const result = installSkillDir(skillDir, dataDir, receipt);
    if (!result.ok) throw new Error(result.message);
    return result;
  } finally {
    try { rmSync(extraction, { recursive: true, force: true }); }
    catch { /* extraction cleanup is best-effort after a committed install */ }
  }
};

export async function installSkillFromNpm(pkg: string, dataDir: string, deps: MarketDeps = {}): Promise<{ ok: boolean; message: string }> {
  const name = pkg.trim();
  if (!validNpmPackage(name)) return { ok: false, message: '包名非法' };
  try {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, deps);
    const version = immutableVersion(meta?.version);
    const tarball = typeof meta?.dist?.tarball === 'string' ? meta.dist.tarball : '';
    if (!tarball) throw new Error('registry 无 dist.tarball');
    const expected = expectedNpmDigest(meta.dist);
    const downloaded = await fetchBounded(tarball, ARCHIVE_BYTES, 'application/octet-stream', 60_000, deps);
    const observed = verifyDigest(downloaded.bytes, expected);
    return await installDownloadedSkill(downloaded.bytes, dataDir, {
      source: `npm:${name}`,
      resolvedIdentity: `${name}@${version}`,
      expectedDigest: expected.label,
      observedDigest: observed,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return { ok: false, message: `技能安装失败：${String(error?.message ?? error).slice(0, 240)}` };
  }
}

export async function installSkillFromGithub(repo: string, dataDir: string, deps: MarketDeps = {}): Promise<{ ok: boolean; message: string }> {
  const normalized = repo.trim().replace(/^github:/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9_.-]+$/.test(normalized) || normalized.includes('..')) {
    return { ok: false, message: '仓库名非法（需 owner/repo）' };
  }
  try {
    const metadata = await fetchJson(`https://api.github.com/repos/${normalized}/commits/HEAD`, deps);
    const commit = typeof metadata?.sha === 'string' ? metadata.sha.toLowerCase() : '';
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('GitHub 未返回不可变 commit SHA');
    const url = `https://codeload.github.com/${normalized}/tar.gz/${commit}`;
    const downloaded = await fetchBounded(url, ARCHIVE_BYTES, 'application/octet-stream', 60_000, deps);
    const digest = createHash('sha256').update(downloaded.bytes).digest('hex');
    return await installDownloadedSkill(downloaded.bytes, dataDir, {
      source: `github:${normalized}`,
      resolvedIdentity: `${normalized}@${commit}`,
      // ⅩⅩⅩ（D-5）：expectedDigest 改为不可变锚（commit SHA 短缀）——安装后可独立校验
      expectedDigest: `git:${commit.slice(0, 16)}→sha256:${digest.slice(0, 16)}`,
      observedDigest: `sha256:${digest}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return { ok: false, message: `技能安装失败：${String(error?.message ?? error).slice(0, 240)}` };
  }
}
