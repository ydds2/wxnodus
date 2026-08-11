// src/kernel/cronExpr.ts — 标准 cron 5 字段表达式（分 时 日 月 周）
// 设计：自研解析器（无依赖）——支持数字 / * / */n 步进 / a-b 区间 / a,b,c 列表；
//       cronMatches 判断给定时间是否命中（分钟级精度，与调度轮询匹配）。
//       兼容保留 every Nm 自然语言格式（parseCronExpr 识别后转换为 5 字段）。
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>; // 0/7 = 周日
}

export type CronParseResult = { ok: true; expr: string; fields: CronFields } | { ok: false; error: string };

const RANGES: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // dayOfMonth
  { min: 1, max: 12 },  // month
  { min: 0, max: 7 },   // dayOfWeek（7 归一为 0）
];

/** 解析单个字段（星号 / 星号斜杠 n 步进 / a-b 区间 / a,b,c 列表 / 数字），返回命中集合 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const p = part.trim();
    if (!p) return null;
    const stepMatch = /^\*\/(\d+)$/.exec(p);
    if (stepMatch) {
      const step = parseInt(stepMatch[1]!, 10);
      if (step < 1) return null;
      for (let v = min; v <= max; v += step) out.add(v);
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(p);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1]!, 10);
      const b = parseInt(rangeMatch[2]!, 10);
      if (a > b || a < min || b > max) return null;
      for (let v = a; v <= b; v++) out.add(v);
      continue;
    }
    if (p === '*') {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    if (/^\d+$/.test(p)) {
      const v = parseInt(p, 10);
      if (v < min || v > max) return null;
      out.add(v);
      continue;
    }
    return null; // 无法解析
  }
  // dayOfWeek 归一：7 → 0（周日）
  if (min === 0 && max === 7 && out.has(7)) { out.delete(7); out.add(0); }
  return out;
}

/** 解析标准 5 字段 cron 表达式（分 时 日 月 周）；兼容 every Nm/Nh/Nd 自然语言 */
export function parseCronExpr(expr: string): CronParseResult {
  const trimmed = String(expr ?? '').trim();
  if (!trimmed) return { ok: false, error: '空表达式' };
  // every Nm / every Nh / every Nd → 转 5 字段（分钟/小时/天步进）
  const nat = /^every (\d+)([mhd])$/.exec(trimmed);
  if (nat) {
    const n = parseInt(nat[1]!, 10);
    const unit = nat[2]!;
    if (n < 1) return { ok: false, error: '间隔需 ≥1' };
    const conv = unit === 'm' ? `*/${n} * * * *` : unit === 'h' ? `0 */${n} * * *` : `0 0 */${n} * *`;
    const inner = parseCronExpr(conv);
    if (!inner.ok) return inner;
    return { ok: true, expr: trimmed, fields: inner.fields };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: `需 5 字段（分 时 日 月 周），收到 ${parts.length} 个` };
  const fields: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const set = parseField(parts[i]!, RANGES[i]!.min, RANGES[i]!.max);
    if (!set) return { ok: false, error: `字段 ${i + 1}「${parts[i]}」无法解析（支持 数字/*/步进/区间/列表）` };
    fields.push([...set]);
  }
  return {
    ok: true,
    expr: trimmed,
    fields: {
      minute: new Set(fields[0]),
      hour: new Set(fields[1]),
      dayOfMonth: new Set(fields[2]),
      month: new Set(fields[3]),
      dayOfWeek: new Set(fields[4]),
    },
  };
}

/** 判断时间是否命中表达式（分钟级） */
export function cronMatches(fields: CronFields, date: Date = new Date()): boolean {
  const dow = date.getDay(); // 0 = 周日
  if (!fields.minute.has(date.getMinutes())) return false;
  if (!fields.hour.has(date.getHours())) return false;
  if (!fields.dayOfMonth.has(date.getDate())) return false;
  if (!fields.month.has(date.getMonth() + 1)) return false;
  if (!fields.dayOfWeek.has(dow)) return false;
  return true;
}

/** 表达式描述（人类可读） */
export function describeCronExpr(expr: string): string {
  const r = parseCronExpr(expr);
  if (!r.ok) return expr;
  const f = r.fields;
  const all = (s: Set<number>) => s.size >= (s === f.minute ? 60 : s === f.hour ? 24 : s === f.dayOfMonth ? 31 : s === f.month ? 12 : 8);
  const show = (s: Set<number>) => (all(s) ? '*' : [...s].sort((a, b) => a - b).join(','));
  return `分:${show(f.minute)} 时:${show(f.hour)} 日:${show(f.dayOfMonth)} 月:${show(f.month)} 周:${show(f.dayOfWeek)}`;
}
