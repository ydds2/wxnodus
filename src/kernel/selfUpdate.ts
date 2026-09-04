// src/kernel/selfUpdate.ts — V4 P5-1：wxnodus update 自升级（用户权力·约束四）
// 机制参考（不抄实现）：codex `codex update`（显式升级命令）/kimi Windows 单包自动更新
// /crush update.go（release 比对+dev 跳过）。用户裁决三原则：
//   ① 绝不自动安装——新版本只提示（banner/命令），安装必须显式 --apply/--file；
//   ② 失败保持旧版可运行——apply 前备份（N-1），失败自动回恢复；
//   ③ 气隙/私有部署一等公民——--file 本地 zip 安装（复用官方安装链）。
// feed 契约（三形态）：
//   A. 自有 JSON：{ version: '4.0.1', url: 'https://…/wxnodus-4.0.1.zip', sha256?: '…', notes? }
//   B. GitHub Release API：tag_name + assets[].browser_download_url（sha256 缺省时诚实降级不校验）
//   C. 版本清单（P3a 我的世界式双渠道）：{ latest:{release,snapshot}, versions:[{id,type,url,sha256}] }
//      —— channel 参数选择渠道（release 默认/snapshot 快照）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WXNODUS_VERSION } from './version.js';
import { parseVersion } from './semverRange.js';
import { parseVersionManifest, selectVersion, type UpdateChannel } from './versionManifest.js';

export interface UpdateFeedInfo {
  updateAvailable: boolean;
  latest: string | null;
  downloadUrl: string | null;
  sha256: string | null;
  notes: string | null;
}

/** x.y.z[-pre] 数值比较——主三段解析统一走 semverRange.parseVersion（K2 单一事实源收敛 2026-09-04，
 * 替换自带独立正则；预发布段按字典序低于同号正式版；解析失败 fail-closed 返回 false） */
export function isNewerVersion(latest: string, current: string): boolean {
  const pre = (v: string) => /^v?[\d.]+-(.+)$/.exec(String(v).trim())?.[1] ?? null;
  const a = parseVersion(String(latest).replace(/^[vV]/, ''));
  const b = parseVersion(String(current).replace(/^[vV]/, ''));
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  // 同号：正式版 > 预发布；预发布之间字典序
  const pa = pre(latest), pb = pre(current);
  if (pa === null) return pb !== null;
  if (pb === null) return false;
  return pa > pb;
}

/** 拉取 feed 并比对（feed 未配置 → 诚实 null 信息；网络失败 → updateAvailable:false + notes 说明） */
export async function fetchLatestRelease(
  feedUrl: string | null | undefined,
  currentVersion: string = WXNODUS_VERSION,
  fetchImpl?: typeof fetch,
  timeoutMs = 6000,
  channel: UpdateChannel = 'release',
): Promise<UpdateFeedInfo> {
  if (!feedUrl) {
    return { updateAvailable: false, latest: null, downloadUrl: null, sha256: null, notes: '未配置更新源（settings.updateFeed 或 WXNODUS_UPDATE_FEED）' };
  }
  // A2（2026-08-27）：缺省走出站统一 fetch（env 代理 + 私网段默认直连）——内网 feed 可用；
  // 测试注入的 fetchImpl 仍优先（契约不变）。
  const doFetch = fetchImpl ?? (await import('../infrastructure/http/outboundFetch.js')).createOutboundFetch().fetch;
  let raw: any;
  try {
    const res = await doFetch(feedUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { updateAvailable: false, latest: null, downloadUrl: null, sha256: null, notes: `更新源响应 ${res.status}` };
    raw = await res.json();
  } catch (e: any) {
    return { updateAvailable: false, latest: null, downloadUrl: null, sha256: null, notes: `更新源不可达（${String(e?.message ?? e).slice(0, 80)}）` };
  }
  // C. 版本清单（P3a 双渠道——优先于旧双形态判定）
  const manifest = parseVersionManifest(raw)
  if (manifest) {
    const sel = selectVersion(manifest, channel)
    if (!sel.entry) {
      return { updateAvailable: false, latest: sel.latest, downloadUrl: null, sha256: null, notes: sel.notes };
    }
    return {
      updateAvailable: isNewerVersion(sel.entry.id, currentVersion),
      latest: sel.entry.id,
      downloadUrl: sel.entry.url ?? null,
      sha256: sel.entry.sha256 ?? null,
      notes: sel.notes,
    };
  }
  // B. GitHub Release API 形态
  if (raw && typeof raw.tag_name === 'string' && Array.isArray(raw.assets)) {
    const zipAsset = raw.assets.find((a: any) => /\.zip$/i.test(String(a?.browser_download_url ?? a?.url ?? '')));
    const latest = String(raw.tag_name).replace(/^[vV]/, '');
    return {
      updateAvailable: isNewerVersion(latest, currentVersion),
      latest,
      downloadUrl: zipAsset?.browser_download_url ?? zipAsset?.url ?? null,
      sha256: zipAsset?.digest ?? null,
      notes: typeof raw.body === 'string' ? raw.body.slice(0, 300) : null,
    };
  }
  // A. 自有 JSON 契约
  if (raw && typeof raw.version === 'string') {
    return {
      updateAvailable: isNewerVersion(String(raw.version), currentVersion),
      latest: String(raw.version),
      downloadUrl: typeof raw.url === 'string' ? raw.url : null,
      sha256: typeof raw.sha256 === 'string' ? raw.sha256 : null,
      notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 300) : null,
    };
  }
  return { updateAvailable: false, latest: null, downloadUrl: null, sha256: null, notes: '更新源格式无法识别（需 {version,url,sha256?} 或 GitHub Release API 形态）' };
}

// ── 跳过状态（用户裁决：--skip <ver> 后该版本不再提示） ──

export interface UpdateState { skipped: string[] }

export function loadUpdateState(dataDir: string): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'update-state.json'), 'utf8')) as UpdateState;
    return { skipped: Array.isArray(raw.skipped) ? raw.skipped.filter(v => typeof v === 'string') : [] };
  } catch { return { skipped: [] }; }
}

export function markVersionSkipped(dataDir: string, version: string): void {
  const st = loadUpdateState(dataDir);
  if (!st.skipped.includes(version)) st.skipped.push(version);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify(st, null, 2), 'utf8');
  } catch { /* 状态落盘失败不阻断 */ }
}

// ── apply / rollback（备份 N-1 + 失败恢复） ──

export interface InstallerRunner { (zipDir: string, targetDir: string): Promise<{ ok: boolean; output: string }> }

export interface ApplyUpdateInput {
  /** 已下载/本地 zip 的字节（--file 读取或 --apply 下载由调用方完成） */
  zipBuffer: Buffer;
  expectedSha256?: string | null;
  targetDir: string;
  /** 解压 zip 到临时目录（默认 readZip 展开——注入便于单测） */
  extract: (zipBuffer: Buffer, destDir: string) => Promise<void>;
  /** 运行解压目录内的 install.ps1（默认由 CLI 层注入 powershell 执行） */
  runInstaller: InstallerRunner;
  /** 版本验证（安装后调 <target>/cli --version；注入便于单测） */
  verifyInstalled: (targetDir: string) => Promise<string | null>;
}

export interface ApplyUpdateResult { ok: boolean; steps: string[]; error?: string }

/**
 * 应用更新：sha256 校验 → 备份当前目录（N-1：.prev 保留一份）→ 展开新包 →
 * 运行安装器 → 装后版本验证 → 失败自动恢复备份（旧版保持可运行——验收红线）。
 */
export async function applyUpdate(input: ApplyUpdateInput): Promise<ApplyUpdateResult> {
  const steps: string[] = [];
  const backupDir = `${input.targetDir}.prev`;
  // ① sha256 校验（提供 expected 时强制；不匹配绝不安装）
  if (input.expectedSha256) {
    const actual = createHash('sha256').update(input.zipBuffer).digest('hex');
    if (actual !== input.expectedSha256.toLowerCase()) {
      return { ok: false, steps, error: `sha256 校验失败（期望 ${input.expectedSha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）——已拒绝安装` };
    }
    steps.push(`sha256 校验通过（${actual.slice(0, 12)}…）`);
  } else {
    steps.push('未提供 sha256——跳过完整性校验（信任本地/私有通道文件）');
  }
  // ② 备份当前目录（存在才备份；N-1：先清旧备份）
  if (existsSync(input.targetDir)) {
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* 旧备份清理失败不阻断 */ }
    renameSync(input.targetDir, backupDir);
    steps.push(`已备份当前版本 → ${backupDir}（rollback 出口）`);
  }
  // ③ 展开新包 + 安装
  const staging = `${input.targetDir}.staging`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    await input.extract(input.zipBuffer, staging);
    steps.push(`新包已展开（staging ${staging}）`);
    const r = await input.runInstaller(staging, input.targetDir);
    if (!r.ok) throw new Error(`安装器失败：${r.output.slice(0, 200)}`);
    steps.push('安装器执行成功');
    // ④ 装后验证：版本可读（wxnodus --version 语义）
    const ver = await input.verifyInstalled(input.targetDir);
    if (!ver) throw new Error('装后验证失败：无法读取新版本号');
    steps.push(`装后验证通过：${ver}`);
    rmSync(staging, { recursive: true, force: true });
    return { ok: true, steps };
  } catch (e: any) {
    // ⑤ 失败恢复：还原备份（验收红线——失败保持旧版可运行）
    steps.push(`更新失败：${String(e?.message ?? e).slice(0, 200)}`);
    try {
      if (existsSync(backupDir)) {
        rmSync(input.targetDir, { recursive: true, force: true });
        renameSync(backupDir, input.targetDir);
        steps.push('已自动恢复备份——旧版本保持可运行');
      }
    } catch (restoreErr: any) {
      return { ok: false, steps, error: `恢复备份亦失败（${String(restoreErr?.message ?? restoreErr).slice(0, 120)}）——手动恢复：${backupDir}` };
    }
    return { ok: false, steps, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 回退上一版（.prev 备份互换；无备份诚实拒绝） */
export async function rollbackUpdate(targetDir: string): Promise<ApplyUpdateResult> {
  const backupDir = `${targetDir}.prev`;
  const steps: string[] = [];
  if (!existsSync(backupDir)) {
    return { ok: false, steps, error: `无可回退备份（${backupDir} 不存在）——仅 --apply 升级时创建` };
  }
  if (!existsSync(targetDir)) {
    renameSync(backupDir, targetDir);
    steps.push('当前版本缺失——备份直接转正');
    return { ok: true, steps };
  }
  const currentAsBackup = `${targetDir}.prev-rollback-tmp`;
  try {
    renameSync(targetDir, currentAsBackup);
    renameSync(backupDir, targetDir);
    renameSync(currentAsBackup, backupDir);
    steps.push('已回退到上一版（当前版本互换入 .prev——可再次 rollback 往返）');
    return { ok: true, steps };
  } catch (e: any) {
    return { ok: false, steps, error: `回退失败：${String(e?.message ?? e).slice(0, 200)}` };
  }
}
