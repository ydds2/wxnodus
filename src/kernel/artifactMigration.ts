// src/kernel/artifactMigration.ts — V4 P5-2：用户产物迁移框架（约束四·迁移兼容权）
// 背景：migrations/db/registry.ts 只覆盖 DB schema；文件系统级用户产物（skills/plugins/
// MCP 配置/权限规则/主题/会话库/事件流/项目产物…）无迁移框架。升级 wxnodus 不许丢用户资产。
// 设计（对齐【调研⑤】主题 5：temp+rename 原子性、迁移前全量备份——实现按本仓架构重写）：
//   ① USER_ARTIFACTS 声明式产物清单（id/路径/形态/schemaVersion）
//   ② artifactStatus：逐产物 ok/missing/corrupt 状态（形态校验而非存在性猜测）
//   ③ ArtifactMigrator 迁移器链：detects（旧形态判定）→ plan（dry-run 动作清单）→
//     apply（幂等纯函数）；runMigrations 统一执行：备份→逐个应用→任一失败整体回滚
//     （绝不半迁移——fail-safe 红线）
//   ④ 迁移历史持久化 migrations/applied.json；/migrate status 命令消费
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// ── ① 产物清单 ────────────────────────────────────────────────

export interface ArtifactSpec {
  id: string;
  /** 相对 dataDir 的路径（文件或目录） */
  path: string;
  kind: 'file' | 'dir';
  /** 当前 schema 版本（漂移检测基准；迁移器 fromVersion 对应旧值） */
  schemaVersion: number;
  description: string;
  /** 形态校验：存在但内容不是预期形态 → corrupt（如 settings.json 非 JSON 对象） */
  validate?: (dataDir: string) => boolean;
}

const isJsonObjectFile = (p: string): boolean => {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'));
    return typeof v === 'object' && v !== null;
  } catch { return false; }
};

export const USER_ARTIFACTS: ArtifactSpec[] = [
  { id: 'settings', path: 'settings.json', kind: 'file', schemaVersion: 1, description: '配置中心（模型/密钥档案——加密态原样迁移）', validate: d => isJsonObjectFile(join(d, 'settings.json')) },
  { id: 'permissions', path: 'permissions.json', kind: 'file', schemaVersion: 1, description: '权限规则（allow/deny/ask）', validate: d => isJsonObjectFile(join(d, 'permissions.json')) },
  { id: 'mcp-config', path: 'mcp.json', kind: 'file', schemaVersion: 1, description: 'MCP 服务器配置', validate: d => isJsonObjectFile(join(d, 'mcp.json')) },
  { id: 'skills', path: 'skills', kind: 'dir', schemaVersion: 1, description: '用户技能（SKILL.md 目录树）' },
  { id: 'plugins', path: 'plugins', kind: 'dir', schemaVersion: 1, description: '本地插件（只收不出——仅本地自用）' },
  { id: 'commands', path: 'commands', kind: 'dir', schemaVersion: 1, description: '自定义命令' },
  { id: 'themes', path: 'themes', kind: 'dir', schemaVersion: 1, description: '自定义主题' },
  { id: 'keymaps', path: 'keymaps', kind: 'dir', schemaVersion: 1, description: '自定义键位' },
  { id: 'sessions-db', path: 'nodus.db', kind: 'file', schemaVersion: 1, description: '会话库+黑洞记忆+审计链（SQLite）' },
  { id: 'events', path: 'events.jsonl', kind: 'file', schemaVersion: 1, description: '事件流（可重放）' },
  { id: 'session-streams', path: 'session-streams', kind: 'dir', schemaVersion: 1, description: '逐会话事件流 JSONL' },
  { id: 'projects', path: 'projects', kind: 'dir', schemaVersion: 1, description: '项目产物（/build 脚手架/证据）' },
  { id: 'undo-shadows', path: 'undo-shadows', kind: 'dir', schemaVersion: 1, description: '撤销快照（/undo 依赖）' },
  { id: 'todos', path: 'todos.json', kind: 'file', schemaVersion: 1, description: '待办（todo 工具持久层）', validate: d => isJsonObjectFile(join(d, 'todos.json')) },
  { id: 'config-locale', path: 'config.json', kind: 'file', schemaVersion: 1, description: '首启语言配置', validate: d => isJsonObjectFile(join(d, 'config.json')) },
];

export type ArtifactState = 'ok' | 'missing' | 'corrupt';

export interface ArtifactStatus { spec: ArtifactSpec; state: ArtifactState; note: string }

/** 逐产物状态（存在+形态双校验；missing 是合法新装状态，corrupt 才是异常） */
export function artifactStatus(dataDir: string): ArtifactStatus[] {
  return USER_ARTIFACTS.map(spec => {
    const p = join(dataDir, spec.path);
    let st;
    try { st = statSync(p); } catch {
      return { spec, state: 'missing', note: '未创建（新装/未使用该能力）' };
    }
    const kindMatch = spec.kind === 'dir' ? st.isDirectory() : st.isFile();
    if (!kindMatch) return { spec, state: 'corrupt', note: `形态异常：期望 ${spec.kind === 'dir' ? '目录' : '文件'}` };
    if (spec.validate && !spec.validate(dataDir)) {
      return { spec, state: 'corrupt', note: '内容形态校验失败（非预期 JSON 结构？）' };
    }
    return { spec, state: 'ok', note: spec.kind === 'dir' ? `${readdirSync(p).length} 项` : `${st.size} B` };
  });
}

// ── ③ 迁移器链 ────────────────────────────────────────────────

export interface ArtifactMigrator {
  id: string;
  /** 涉及产物 id（备份范围依据） */
  artifacts: string[];
  /** 旧形态判定（dataDir 存在需要迁移的旧形态） */
  detects(dataDir: string): boolean;
  /** dry-run：将执行的动作清单（不落盘） */
  plan(dataDir: string): string[];
  /** 应用（备份完成后调用；必须幂等——重入时 detects 已 false 自然跳过） */
  apply(dataDir: string): { ok: true } | { ok: false; error: string };
}

/** 注册表（V4.0 首版无历史包袱迁移器——框架就位，后续版本按需登记） */
export const ARTIFACT_MIGRATORS: ArtifactMigrator[] = [];

export interface MigrationRunResult {
  ok: boolean;
  /** 本次命中的迁移器 id */
  applied: string[];
  steps: string[];
  /** 备份目录（回滚出口；无动作时 null） */
  backupDir: string | null;
  error?: string;
}

interface AppliedRecord { id: string; at: number; ok: boolean }

function migrationsDir(dataDir: string): string { return join(dataDir, 'migrations'); }

export function migrationHistory(dataDir: string): AppliedRecord[] {
  try {
    const raw = JSON.parse(readFileSync(join(migrationsDir(dataDir), 'applied.json'), 'utf8')) as AppliedRecord[];
    return Array.isArray(raw) ? raw.filter(r => r?.id && typeof r.at === 'number') : [];
  } catch { return []; }
}

/**
 * 执行迁移器链（fail-safe 红线：绝不半迁移）：
 * ① detects 收集命中 → 无命中直接 ok（幂等重入零成本）
 * ② 涉及产物全量备份 migrations/backups/<ts>/（temp+rename 原子复制）
 * ③ 逐个 apply —— 任一失败：从备份整体恢复已应用产物 → 报告且退出
 * ④ 全部成功 → applied.json 记录 + 清理保留窗口外的旧备份（保留最近 5 份）
 */
export function runMigrations(
  dataDir: string,
  migrators: ArtifactMigrator[] = ARTIFACT_MIGRATORS,
  opts: { now?: () => number; keepBackups?: number } = {},
): MigrationRunResult {
  const steps: string[] = [];
  const hits = migrators.filter(m => {
    try { return m.detects(dataDir); } catch { return false; }
  });
  if (!hits.length) return { ok: true, applied: [], steps: ['无可执行的产物迁移（形态均已是当前版本）'], backupDir: null };

  // ② 备份：涉及产物 + applied.json（原子：先复制到 .tmp 再 rename）
  const ts = (opts.now ?? Date.now)();
  const backupDir = join(migrationsDir(dataDir), 'backups', String(ts));
  const backupTmp = `${backupDir}.tmp`;
  const touchedIds = [...new Set(hits.flatMap(m => m.artifacts))];
  const specs = USER_ARTIFACTS.filter(a => touchedIds.includes(a.id));
  try {
    rmSync(backupTmp, { recursive: true, force: true });
    mkdirSync(backupTmp, { recursive: true });
    for (const spec of specs) {
      const src = join(dataDir, spec.path);
      if (!existsSync(src)) continue;
      cpSync(src, join(backupTmp, spec.path), { recursive: true });
    }
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(backupTmp, backupDir);
    steps.push(`已备份 ${specs.length} 项产物 → ${backupDir}`);
  } catch (e: any) {
    return { ok: false, applied: [], steps, backupDir: null, error: `备份失败（不执行迁移——绝不半迁移）：${String(e?.message ?? e).slice(0, 150)}` };
  }

  // ③ 逐个应用；失败整体回滚
  const applied: string[] = [];
  for (const m of hits) {
    try {
      steps.push(`▶ ${m.id}：${m.plan(dataDir).join('；')}`);
      const r = m.apply(dataDir);
      if (!r.ok) throw new Error(r.error);
      applied.push(m.id);
    } catch (e: any) {
      // 回滚：从备份恢复全部涉及产物（含已应用与半应用的）
      try {
        for (const spec of specs) {
          const backupPath = join(backupDir, spec.path);
          const livePath = join(dataDir, spec.path);
          if (!existsSync(backupPath)) continue;
          rmSync(livePath, { recursive: true, force: true });
          cpSync(backupPath, livePath, { recursive: true });
        }
        steps.push(`已从备份整体恢复（绝不半迁移）——旧数据完好`);
        return { ok: false, applied, steps, backupDir, error: `迁移器 ${m.id} 失败：${String(e?.message ?? e).slice(0, 200)}` };
      } catch (restoreErr: any) {
        return { ok: false, applied, steps, backupDir, error: `迁移失败且回滚亦失败（${String(restoreErr?.message ?? restoreErr).slice(0, 120)}）——手动恢复：${backupDir}` };
      }
    }
  }

  // ④ 记录 + 备份窗口清理（保留最近 5 份）
  try {
    const history = [...migrationHistory(dataDir), ...applied.map(id => ({ id, at: ts, ok: true }))];
    mkdirSync(migrationsDir(dataDir), { recursive: true });
    writeFileSync(join(migrationsDir(dataDir), 'applied.json'), JSON.stringify(history, null, 2), 'utf8');
    const backupsRoot = join(migrationsDir(dataDir), 'backups');
    const olds = readdirSync(backupsRoot).filter(d => !d.endsWith('.tmp')).sort();
    for (const old of olds.slice(0, Math.max(0, olds.length - (opts.keepBackups ?? 5)))) {
      try { rmSync(join(backupsRoot, old), { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ }
    }
  } catch { /* 历史落盘失败不回滚迁移本体 */ }
  return { ok: true, applied, steps, backupDir };
}
