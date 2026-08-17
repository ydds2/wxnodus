// src/commands/ext/deterministicTools.ts — 确定性工具类命令（handlersExt 巨文件拆分第 1 块，audit §13.43）
// /calc /hash /base64 /uuid /rand /json /timer /sql /fs /units /csv——全部只读/纯计算，
// 不依赖 handlersExt 的共享状态。fsLsRows/fsReadRows/sqlTableRows 纯函数自 handlersExt 迁入
// （handlersExt 以 re-export 保持既有测试导入兼容）。
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { join, basename } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { HandlerCtx } from '../handlers.js';
import type { CommandBus } from '../../app/CommandBus.js';

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => l.length), title.length) + 4;
  return [`┌${'─'.repeat(w)}┐`, `│ ${title}${' '.repeat(w - title.length - 2)} │`, ...body.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`), `└${'─'.repeat(w)}┘`].join('\n');
};

/** 只读表达式求值（仅数字与四则运算符，白名单校验防注入——失败返回 null） */
function safeEval(expr: string): number | null {
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return null;
  try {
    const v = Function(`"use strict"; return (${expr});`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** /fs ls 封顶诚实标注（纯函数可单测）：超 30 个追加总数标注行 */
export function fsLsRows(items: string[]): string[] {
  const shown = items.slice(0, 30);
  return items.length > 30 ? [...shown, `…（共 ${items.length} 个，前 30 个——/fs tree 或分段查看）`] : shown;
}

/** /fs read 60 行封顶诚实标注（纯函数可单测）：超 60 行追加总数标注行 */
export function fsReadRows(lines: string[]): string[] {
  const shown = lines.slice(0, 60);
  return lines.length > 60 ? [...shown, `…（共 ${lines.length} 行，前 60 行——bash tail/sed 续看）`] : shown;
}

/** /sql 面板行（纯函数可单测）：前 cap 行 + 超限总数标注（行数影响数据结论——绝不静默截前 20 行） */
export function sqlTableRows(rows: Array<Record<string, unknown>>, cols: string[], cap = 20): string[] {
  const body = rows.slice(0, cap).map(r => ` ${cols.map(col => String(r[col] ?? '').slice(0, 40)).join(' | ')}`);
  return rows.length > cap ? [...body, ` …（共 ${rows.length} 行，前 ${cap} 行——WHERE/LIMIT 收窄续查）`] : body;
}

export function registerDeterministicTools(bus: CommandBus, ctx: HandlerCtx): void {
  // ── 工具类（确定性）────────────────────────────
  bus.register('/calc', (args) => {
    const expr = args.join(' ');
    if (!expr) return '用法：/calc <表达式>（如 /calc 1+2*3）';
    const v = safeEval(expr);
    return v === null ? '表达式不合法（仅支持数字与 +-*/() ）' : `${expr} = ${v}`;
  });

  bus.register('/hash', (args) => {
    const [algo, ...rest] = args;
    const text = rest.join(' ');
    if (!['md5', 'sha1', 'sha256'].includes(algo ?? '') || !text) return '用法：/hash <md5|sha1|sha256> <文本>';
    return createHash(algo!).update(text, 'utf8').digest('hex');
  });

  bus.register('/base64', (args) => {
    const [op, ...rest] = args;
    const text = rest.join(' ');
    if (!['e', 'd', 'encode', 'decode'].includes(op ?? '') || !text) return '用法：/base64 <e|d> <文本>';
    try {
      return op === 'e' || op === 'encode' ? Buffer.from(text, 'utf8').toString('base64') : Buffer.from(text, 'base64').toString('utf8');
    } catch { return '解码失败（非法 Base64）'; }
  });

  bus.register('/uuid', () => randomUUID());

  bus.register('/rand', (args) => {
    const n = parseInt(args[0] ?? '16', 10);
    if (!Number.isFinite(n) || n < 1 || n > 64) return '用法：/rand [长度1-64]';
    return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
  });

  bus.register('/json', (args) => {
    const text = args.join(' ');
    if (!text) return '用法：/json <JSON 字符串>（格式化/校验）';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch { return '非法 JSON'; }
  });

  bus.register('/timer', (args) => {
    const sec = parseInt(args[0] ?? '', 10);
    const hint = args.slice(1).join(' ') || '时间到';
    if (!Number.isFinite(sec) || sec < 1 || sec > 3600) return '用法：/timer <秒> [提示语]（到时通过事件通知提示）';
    const end = Date.now() + sec * 1000;
    setTimeout(() => {
      try { ctx.bus.emit('system.notice', { text: `⏰ 计时器到点（${sec}s）：${hint}` }); } catch { /* 进程可能已退出 */ }
    }, sec * 1000);
    return `计时器已启动：${sec}s（${new Date(end).toTimeString().slice(0, 8)} 到点，提示语「${hint.slice(0, 30)}」）`;
  });

  bus.register('/sql', (args) => {
    const q = args.join(' ');
    if (!q) return '用法：/sql <SELECT 查询>（只读）';
    const s = q.trim().toLowerCase();
    if (!s.startsWith('select') && !s.startsWith('pragma')) return '仅允许只读查询（SELECT/PRAGMA）';
    try {
      const rows = ctx.db.prepare(q).all() as any[];
      if (!rows.length) return '（0 行）';
      const cols = Object.keys(rows[0] ?? {});
      return lines(' SQL ', [` ${cols.join(' | ')}`, ...sqlTableRows(rows, cols)]);
    } catch (e: any) { return `SQL 错误：${e?.message?.slice(0, 120)}`; }
  });

  bus.register('/fs', (args) => {
    const [op, ...rest] = args;
    const target = rest.join(' ').replace(/^["']|["']$/g, '');
    if (!target) return '用法：/fs <ls|read|stat|tree|glob> <路径|模式> [--depth N]';
    try {
      const p = join(ctx.cwd, target);
      if (op === 'ls') {
        if (!existsSync(p)) return `不存在：${p}`;
        const rows = fsLsRows(readdirSync(p));
        const body = rows.slice(0, 30).map(i => ` ${statSync(join(p, i)).isDirectory() ? '📁' : '📄'} ${i}`);
        const tail = rows.at(-1)?.startsWith('…（共') ? [` ${rows.at(-1)!}`] : [];
        return lines(` ls ${target} `, [...body, ...tail]);
      }
      if (op === 'read' || op === 'cat') {
        if (!existsSync(p) || statSync(p).isDirectory()) return `不存在或为目录：${p}`;
        const size = statSync(p).size;
        if (size > 200_000) return `文件过大（${size} 字节），仅支持 ≤200KB`;
        const allLines = readFileSync(p, 'utf8').split('\n');
        const rows = fsReadRows(allLines);
        const body = rows.slice(0, 60).map(l => ` ${l}`);
        const tail = rows.at(-1)?.startsWith('…（共') ? [` ${rows.at(-1)!}`] : [];
        return lines(` read ${basename(p)} `, [...body, ...tail]);
      }
      if (op === 'stat') {
        if (!existsSync(p)) return `不存在：${p}`;
        const st = statSync(p);
        return lines(` stat ${target} `, [
          ` 类型：${st.isDirectory() ? '目录' : '文件'}`,
          ` 大小：${st.size} 字节`,
          ` 修改：${new Date(st.mtimeMs).toLocaleString()}`,
        ]);
      }
      // A21：目录树——/fs tree <路径> [--depth N]（ASCII 树，限深防爆炸）
      if (op === 'tree') {
        // 路径参数需剔除 --depth N（flags 不属路径）
        const depthArgIdx = args.indexOf('--depth');
        const treeTarget = args
          .slice(1)
          .filter((_, i) => depthArgIdx < 0 || (i !== depthArgIdx - 1 && i !== depthArgIdx))
          .join(' ')
          .replace(/^["']|["']$/g, '');
        const treePath = treeTarget ? join(ctx.cwd, treeTarget) : ctx.cwd;
        if (!existsSync(treePath) || !statSync(treePath).isDirectory()) return `不存在或非目录：${treePath}`;
        const depth = depthArgIdx >= 0 ? Math.min(Math.max(Number(args[depthArgIdx + 1]) || 2, 1), 6) : 2;
        const out: string[] = [basename(treePath) || treeTarget || '.'];
        const walk = (dir: string, prefix: string, level: number) => {
          if (level > depth) {
            out.push(`${prefix}…（深度 ${depth} 截断，--depth N 调深）`);
            return;
          }
          let entries: Array<{ name: string; isDir: boolean }> = [];
          try {
            entries = readdirSync(dir, { withFileTypes: true })
              .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
              .slice(0, 40)
              .map(e => ({ name: e.name, isDir: e.isDirectory() }));
          } catch { return; }
          entries.forEach((e, i) => {
            const last = i === entries.length - 1;
            out.push(`${prefix}${last ? '└─ ' : '├─ '}${e.name}${e.isDir ? '/' : ''}`);
            if (e.isDir) walk(join(dir, e.name), prefix + (last ? '   ' : '│  '), level + 1);
          });
        };
        walk(treePath, '', 1);
        return lines(` tree ${treeTarget || '.'} `, out.slice(0, 80));
      }
      // A21：glob 批量匹配——/fs glob <模式>（相对 cwd；** 递归；* 单层）
      if (op === 'glob') {
        const pattern = target.replace(/\\/g, '/');
        const results: string[] = [];
        const simpleGlob = (seg: string) => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*')}$`);
        const walk = (dir: string, rel: string, depthLeft: number) => {
          if (depthLeft < 0) return;
          let entries: Array<{ name: string; isDir: boolean }> = [];
          try {
            entries = readdirSync(dir, { withFileTypes: true })
              .filter(e => e.name !== 'node_modules' && e.name !== '.git')
              .map(e => ({ name: e.name, isDir: e.isDirectory() }));
          } catch { return; }
          for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (simpleGlob(pattern).test(r)) results.push(r);
            if (e.isDir) walk(join(dir, e.name), r, depthLeft - 1);
          }
        };
        walk(ctx.cwd, '', 6);
        if (!results.length) return `未匹配：${pattern}`;
        return lines(` glob ${pattern}（${results.length} 个） `, results.slice(0, 50));
      }
      return '用法：/fs <ls|read|stat|tree|glob> <路径|模式> [--depth N]';
    } catch (e: any) { return `文件操作失败：${e?.message?.slice(0, 120)}`; }
  });

  bus.register('/units', (args) => {
    const [from, to, ...rest] = args;
    const v = parseFloat(rest.join(' '));
    if (!Number.isFinite(v) || !from || !to) return '用法：/units <米|千米|厘米|毫米> <英尺|英寸> <数值>';
    const M: Record<string, number> = { 米: 1, 千米: 1000, 厘米: 0.01, 毫米: 0.001, 英尺: 0.3048, 英寸: 0.0254, 英里: 1609.344 };
    const a = M[from], b = M[to];
    if (!a || !b) return `不支持的单位：${from} / ${to}（支持：${Object.keys(M).join('、')}）`;
    return `${v} ${from} = ${(v * a / b).toFixed(6)} ${to}`;
  });

  bus.register('/csv', (args) => {
    const text = args.join(' ');
    if (!text) return '用法：/csv <a,b,c|1,2,3|...>（多行用 | 分隔）';
    const rows = text.split('|').map(r => r.split(',').map(c => c.trim()));
    if (!rows.length) return '空 CSV';
    const w = Math.min(Math.max(...rows.flat().map(c => c.length)) + 2, 30);
    return lines(' CSV ', rows.map(r => ` ${r.map(c => c.padEnd(w)).join('│')}`));
  });
}
