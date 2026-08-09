// src/compliance/compliance.ts — L3-3 合规五项（合规红线，不可删）
// ① 授权存证（六元组：授权人/时间/范围/目的/方式/到期，可撤销）
// ② AI 生成标注（深度合成办法第二十条——所有 AI 产物强制标注）
// ③ 审计导出（GDPR 5(2)：授权记录可导出审计）
// ④ 第三方许可证扫描（AGPL/BUSL 强传染性拦截）
// ⑤ 自动化护栏（robots.txt 红线 + 验证码识别——自动化必须尊重站点规则）
import Database from 'better-sqlite3';
import { writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── ① 授权存证 ───────────────────────────────────────────
export interface ConsentRecord {
  id: number;
  grantor: string;
  scope: string;
  purpose: string;
  method: string;
  expiresAt: number;
  evidenceRef: string;
  revokedAt: number | null;
  ts: number;
}

export class ConsentLedger {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS consent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grantor TEXT NOT NULL, scope TEXT NOT NULL, purpose TEXT NOT NULL,
      method TEXT NOT NULL, expires_at INTEGER NOT NULL, evidence_ref TEXT NOT NULL,
      revoked_at INTEGER, ts INTEGER NOT NULL
    )`);
  }
  grant(r: { grantor: string; scope: string; purpose: string; method: string; expiresAt: number; evidenceRef: string }): ConsentRecord {
    const info = this.db.prepare(`INSERT INTO consent (grantor, scope, purpose, method, expires_at, evidence_ref, ts) VALUES (?,?,?,?,?,?,?)`)
      .run(r.grantor, r.scope, r.purpose, r.method, r.expiresAt, r.evidenceRef, Date.now());
    return this.db.prepare(`SELECT * FROM consent WHERE id=?`).get(info.lastInsertRowid) as ConsentRecord;
  }
  isAuthorized(scope: string): { ok: boolean; reason?: string } {
    const rec = this.db.prepare(`SELECT * FROM consent WHERE scope=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`).get(scope) as ConsentRecord | undefined;
    if (!rec) return { ok: false, reason: '无授权记录' };
    if (rec.expiresAt > 0 && rec.expiresAt < Date.now()) return { ok: false, reason: '授权已到期' };
    return { ok: true };
  }
  revoke(id: number): void {
    this.db.prepare(`UPDATE consent SET revoked_at=? WHERE id=?`).run(Date.now(), id);
  }
  export(): ConsentRecord[] {
    return this.db.prepare(`SELECT * FROM consent ORDER BY id`).all() as ConsentRecord[];
  }
}

// ── ② AI 生成标注（深度合成办法第二十条）──────────────────
export function aiNotice(component: string): string {
  return `⚠️ AI 生成标注（深度合成办法 第二十条）：「${component}」由 AI 自动生成，使用前请人工复核其内容与影响。`;
}

// ── ③ 审计导出 ──────────────────────────────────────────
export function exportAudit(outDir: string, ledger: ConsentLedger): string {
  const p = join(outDir, 'audit-consent.json');
  writeFileSync(p, JSON.stringify({ exportedAt: Date.now(), records: ledger.export() }, null, 2), 'utf8');
  return p;
}

// ── ④ 许可证扫描（AGPL/BUSL 强传染性 = block）────────────
const BLOCK_LICENSES = [/AGPL|AFFERO/i, /Business Source/i, /BUSL/i, /SSPL/i];
const OK_LICENSES = [/Apache License/i, /MIT License/i, /BSD/i, /ISC/i, /Mozilla|MPL/i];

export function classifyLicense(text: string): 'block' | 'ok' | 'unknown' {
  for (const re of BLOCK_LICENSES) if (re.test(text)) return 'block';
  for (const re of OK_LICENSES) if (re.test(text)) return 'ok';
  return 'unknown';
}

export function scanLicenses(nodeModulesDir: string): Array<{ pkg: string; license: string; risk: 'block' | 'ok' | 'unknown' }> {
  const out: Array<{ pkg: string; license: string; risk: 'block' | 'ok' | 'unknown' }> = [];
  if (!existsSync(nodeModulesDir)) return out;
  try {
    for (const name of readdirSync(nodeModulesDir)) {
      const pkgPath = join(nodeModulesDir, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const lic = String(pkg.license ?? '');
        out.push({ pkg: name, license: lic, risk: classifyLicense(lic) });
      } catch { /* 跳过坏包 */ }
    }
  } catch { /* 忽略 */ }
  return out;
}

// ── ⑤ 自动化护栏（robots + 验证码）──────────────────────
export function checkRobots(robotsTxt: string, path: string): { allowed: boolean; rule?: string } {
  let disallowAll = false;
  let matched: string | undefined;
  for (const line of robotsTxt.split(/\r?\n/)) {
    const m = line.match(/^Disallow:\s*(.*)$/i);
    if (m) {
      const p = m[1].trim();
      if (p === '/') disallowAll = true;
      else if (path.startsWith(p)) matched = p;
    }
  }
  return { allowed: !disallowAll && !matched, rule: matched ?? (disallowAll ? '/' : undefined) };
}

const CAPTCHA_RE = /验证码|人机验证|recaptcha|captcha|请输入.*码/i;
export function detectCaptcha(html: string): 'high' | 'none' {
  return CAPTCHA_RE.test(html) ? 'high' : 'none';
}

export function guardrail(html: string, robotsTxt: string, path: string): { robotsOk: boolean; captchaRisk: 'high' | 'none' } {
  return { robotsOk: checkRobots(robotsTxt, path).allowed, captchaRisk: detectCaptcha(html) };
}
