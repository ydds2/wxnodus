// scripts/ime-unicode-inject.mjs — 中文输入管线编排（真实 conhost + WriteConsoleInputW）
// 步骤：① 跑 scripts/ime-console-inject.ps1（起真实 TUI 窗口 → 控制台输入缓冲注入 你好+Enter
// → 屏幕缓冲/截图存证）② 跑 scripts/ime-vision-verify.mjs（GLM-4V 视觉核验 + DB 落库核对）
// ③ 产出 artifacts/ime-unicode-injection.json（含各步骤 exit/证据 hash）。
// 背景：本机反作弊拦截 SendInput/keybd_event（见 artifacts/ime-evidence/injection-blocked.json），
// 跨进程键注入不可用；WriteConsoleInputW 是 OS IME 提交后 conhost 投递应用的同一通道。
import { sha256File as sha256, gitCommit as commit, repoRoot } from './lib/evidence.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = repoRoot();

const out = {
  kind: 'ime-unicode-injection',
  generatedAt: new Date().toISOString(),
  commit,
  pipeline: 'WriteConsoleInputW → 真实 conhost 输入缓冲 → TUI（OS IME 提交后同一投递通道）',
  steps: [],
  status: 'blocked',
};

const runPs = (args, label) => {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'ime-console-inject.ps1'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  const o = (r.stdout ?? '').trim();
  out.steps.push({ label, exit: r.status, out: o.slice(0, 300) });
  console.log(`[ime-unicode] ${label}: exit=${r.status} → ${o.replace(/\n/g, ' ').slice(0, 200)}`);
  return r;
};

const capture = runPs([], 'capture+inject');
const verify = spawnSync(process.execPath, [join(ROOT, 'scripts', 'ime-vision-verify.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
out.steps.push({ label: 'vision-verify+db', exit: verify.status, out: `${verify.stdout ?? ''}${verify.stderr ?? ''}`.slice(0, 300) });

const bufPath = join(ROOT, 'artifacts', 'ime-evidence', 'ime-screen-buffer.txt');
out.evidence = {
  screenBuffer: existsSync(bufPath) ? { file: 'ime-screen-buffer.txt', sha256: sha256(bufPath), hasNihao: readFileSync(bufPath, 'utf8').includes('你好') } : null,
  visionReceipt: existsSync(join(ROOT, 'artifacts', 'ime-vision-verification.json')) ? 'present' : null,
};

let dbHit = null;
try {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(join(ROOT, 'data', 'nodus.db'), { readonly: true });
  const before = new Date(Date.now() - 30 * 60 * 1000).getTime();
  dbHit = db.prepare("SELECT id, role, content, ts FROM messages WHERE role='user' AND ts > ? AND content LIKE '%你好%' ORDER BY ts DESC LIMIT 3").all(before);
  db.close();
} catch (e) { dbHit = { error: String(e).slice(0, 200) }; }
out.dbSubmit = Array.isArray(dbHit) ? { matched: dbHit.length > 0, rows: dbHit } : dbHit;

out.status = out.dbSubmit?.matched && out.evidence.screenBuffer?.hasNihao && verify.status === 0 ? 'passed' : 'blocked';
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts', 'ime-unicode-injection.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`\n[ime-unicode] status=${out.status} · written: artifacts/ime-unicode-injection.json`);
process.exit(out.status === 'passed' ? 0 : 1);
