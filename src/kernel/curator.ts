// src/kernel/curator.ts — 黑洞策展（机制补强：后台间隔自动审查）
// 设计（参考 Hermes curator 的 idle 定期审查思想，本地化为准——不常驻进程）：
//   cli 启动后后台 setTimeout 检查间隔（settings.curator.intervalHours，默认 24h）：
//   距上次审查（data/curator-state.json）超期 → 执行一轮确定性审查（记忆/技能统计 +
//   建议），结果写入总线 system.notice；/curator on|off|interval 控制。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Memory } from './memory.js';
import type { EventBus } from './events.js';
import { discoverSkills } from './skills.js';

export interface CuratorConfig {
  enabled: boolean;
  intervalHours: number;
}

export function curatorConfigFrom(settings: Record<string, any> | undefined): CuratorConfig {
  const c = settings?.curator;
  return {
    enabled: c?.enabled !== false,
    intervalHours: Math.max(1, Number(c?.intervalHours) || 24),
  };
}

export function readCuratorState(dataDir: string): { lastRunAt: number | null } {
  const file = join(dataDir, 'curator-state.json');
  if (!existsSync(file)) return { lastRunAt: null };
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { lastRunAt: null }; }
}

export function writeCuratorState(dataDir: string, state: { lastRunAt: number }): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'curator-state.json'), JSON.stringify(state), 'utf8');
  } catch { /* 状态写入失败不阻断 */ }
}

// 确定性审查：记忆/技能统计 + 建议（真实数据）
export function runCuratorReview(mem: Memory, dataDir: string, cwd: string, sessionId = 'default'): string {
  // V4 P5-4（C 级）：会话 id 化——此前硬编码 'default'，非 default 会话的记忆/吸附统计
  // 永远查的是 default 的（多会话数据错位）；调用方传入当前会话
  const recall = mem.recall(sessionId);
  const working = mem.working(sessionId);
  const absorbed = mem.absorbCount(sessionId);
  const skills = discoverSkills(dataDir, cwd);
  const lines2: string[] = [
    ` 记忆：全量 ${recall.length} 条｜工作窗口 ${working.length} 条｜已吸附 ${absorbed} 条`,
    ` 技能：${skills.length} 个（${skills.map(s => s.name).slice(0, 8).join('、') || '无'}）`,
  ];
  const tips: string[] = [];
  if (recall.length > 80) tips.push(`记忆 ${recall.length} 条较多，建议 /compact 或 /digest 整理`);
  if (absorbed > 100) tips.push(`黑洞已吸附 ${absorbed} 条，可用 /hole 检索`);
  if (skills.length > 20) tips.push(`技能 ${skills.length} 个，可用 /skill list 检查重复`);
  if (!tips.length) tips.push('状态健康，无需整理');
  lines2.push('', ' 建议：');
  for (const t of tips) lines2.push(`  - ${t}`);
  return lines2.join('\n');
}

// 间隔检查 + 后台执行（cli 启动后调用一次；幂等——超期才执行）
export function maybeRunCurator(opts: {
  getSettings: () => Record<string, any> | undefined;
  mem: Memory;
  dataDir: string;
  cwd: string;
  bus: EventBus;
}): void {
  const cfg = curatorConfigFrom(opts.getSettings());
  if (!cfg.enabled) return;
  const state = readCuratorState(opts.dataDir);
  const elapsed = state.lastRunAt ? (Date.now() - state.lastRunAt) / 3_600_000 : Infinity;
  if (elapsed < cfg.intervalHours) return;
  try {
    const report = runCuratorReview(opts.mem, opts.dataDir, opts.cwd);
    writeCuratorState(opts.dataDir, { lastRunAt: Date.now() });
    opts.bus.emit('system.notice', { text: `[curator] 自动审查完成：${report.split('\n')[0]}` });
  } catch { /* 审查失败静默，下次再试 */ }
}
