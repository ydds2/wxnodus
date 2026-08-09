// src/build/evidence.ts — L3-1 证据链（交付可信度核心）
// 设计：项目目录指纹（sha256[:6]）+ 证据 JSON（状态/检查项/端口/时间）
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function fingerprint(projectDir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      try {
        if (statSync(p).isDirectory()) { if (!f.startsWith('.') && f !== 'node_modules') walk(p); }
        else if (f !== 'evidence.json') h.update(readFileSync(p));
      } catch { /* 忽略 */ }
    }
  };
  walk(projectDir);
  return h.digest('hex').slice(0, 6);
}

export interface Evidence {
  status: string;
  checks: string[];
  port: number | null;
  fingerprint: string;
  ts: number;
}

export function writeEvidence(projectDir: string, data: { status: string; checks: string[]; port: number | null }): boolean {
  try {
    const ev: Evidence = { ...data, fingerprint: fingerprint(projectDir), ts: Date.now() };
    writeFileSync(join(projectDir, 'evidence.json'), JSON.stringify(ev, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

export function readEvidence(projectDir: string): Evidence | null {
  try { return JSON.parse(readFileSync(join(projectDir, 'evidence.json'), 'utf8')); }
  catch { return null; }
}

// 合规检查（L3-3 深度接入；此处骨架）
export function complianceCheck(projectDir: string): { ok: boolean; items: string[] } {
  const items: string[] = [];
  if (existsSync(join(projectDir, 'README.md'))) items.push('README 存在');
  if (existsSync(join(projectDir, 'evidence.json'))) items.push('证据链存在');
  if (existsSync(join(projectDir, 'package.json'))) items.push('清单存在');
  return { ok: items.length >= 2, items };
}
