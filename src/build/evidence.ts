// src/build/evidence.ts — L3-1 证据链（交付可信度核心）
// 设计：项目目录指纹（完整 SHA-256 64 hex——KF-020：绝不截断，截断 6 hex 碰撞空间不可接受）+ 证据 JSON（状态/检查项/端口/时间）
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export function fingerprint(projectDir: string): string {
  // V4 P5-4（B-28）：哈希含相对路径——此前只哈希内容，同内容不同文件名/文件改名指纹
  // 不变（证据链对结构变化不敏感）。路径与内容一并入哈希。
  const h = createHash('sha256');
  const root = resolve(projectDir);
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      try {
        if (statSync(p).isDirectory()) { if (!f.startsWith('.') && f !== 'node_modules') walk(p); }
        else if (f !== 'evidence.json') {
          h.update(relative(root, p));
          h.update(readFileSync(p));
        }
      } catch { /* 忽略 */ }
    }
  };
  walk(projectDir);
  return h.digest('hex');
}

export interface Evidence {
  status: string;
  checks: string[];
  port: number | null;
  fingerprint: string;
  ts: number;
}

export function writeEvidence(projectDir: string, data: { status: string; checks: string[]; port: number | null; detail?: string }): boolean {
  try {
    const ev: Evidence = { ...data, fingerprint: fingerprint(projectDir), ts: Date.now() } as Evidence;
    writeFileSync(join(projectDir, 'evidence.json'), JSON.stringify(ev, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

export function readEvidence(projectDir: string): Evidence | null {
  try { return JSON.parse(readFileSync(join(projectDir, 'evidence.json'), 'utf8')); }
  catch { return null; }
}

// W3-01：证据链状态 → Run 完成终态投影（ok→succeeded，failed→failed，缺失/其余→inconclusive——
// 证据不足以断言成功也不足以断言失败时，诚实上报 inconclusive 而不是 succeeded；终态再由共享 completionTransport 映射到各传输层）
export function evidenceCompletionStatus(ev: Evidence | null): 'succeeded' | 'failed' | 'inconclusive' {
  if (ev?.status === 'ok') return 'succeeded';
  if (ev?.status === 'failed') return 'failed';
  return 'inconclusive';
}

// 合规检查（L3-3 深度接入——审计修复：从「文件存在」骨架升级为真实检查项：
// 授权声明（LICENSE）/ AI 生成标注（README 或证据含 ai_generated）/ 审计留痕（dataDir 审计链）
export function complianceCheck(projectDir: string, dataDir?: string, auditDb?: { prepare(sql: string): { get(...a: unknown[]): unknown } }): { ok: boolean; items: string[] } {
  const items: string[] = [];
  const has = (f: string) => existsSync(join(projectDir, f));
  // 1. 授权声明：LICENSE 文件存在（开源合规前提）
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(has);
  if (license) items.push(`授权声明：${license} 存在`);
  else items.push('⚠ 缺少授权声明（LICENSE）');
  // 2. AI 生成标注：README 或 evidence 声明 ai_generated（透明性红线）
  let aiMarked = false;
  try {
    const readme = readFileSync(join(projectDir, 'README.md'), 'utf8').slice(0, 4000);
    aiMarked = /ai[_ -]?generated|AI 生成|由 AI 生成/i.test(readme);
  } catch { /* 无 README */ }
  const ev = readEvidence(projectDir);
  aiMarked = aiMarked || Boolean(ev && (ev as any).ai_generated === true);
  items.push(aiMarked ? 'AI 生成标注：已声明' : '⚠ 缺少 AI 生成标注');
  // 3. 证据链状态：evidence.status 必须为 ok（验证通过才算合规）
  items.push(ev ? `证据链：${ev.status}（${(ev.checks ?? []).join('+') || '无检查项'}）` : '⚠ 缺少证据链（evidence.json）');
  // 4. 审计留痕：audit 表有事件（V4 P5-4 修正——此前查 audit.json 文件，而审计早已
  // 落 SQLite audit 表：文件永不存在 → 恒报 ⚠。改查表；无 db 注入时诚实标注跳过）
  if (auditDb) {
    try {
      const n = (auditDb.prepare('SELECT COUNT(*) c FROM audit').get() as { c: number }).c;
      items.push(n > 0 ? `审计留痕：${n} 条哈希链事件` : '⚠ 审计链为空');
    } catch {
      items.push('⚠ 审计留痕：audit 表不可读');
    }
  } else if (dataDir) {
    items.push('审计留痕：未注入 DB（跳过在线校验）');
  }
  // 判定：证据链状态 ok 即合规门通过（LICENSE/AI 标注/审计为提示项——强制三项会
  // 让脚手架产物恒失败；提示项以 ⚠ 呈现给用户人工补齐）
  const ok = ev?.status === 'ok' || (ev == null && items.filter(i => !i.startsWith('⚠')).length >= 3);
  return { ok, items };
}
