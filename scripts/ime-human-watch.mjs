// scripts/ime-human-watch.mjs — 真人 IME 验证守望编排（候选窗截图 + 落库核对，全自动采集）
// 背景：TSF 候选窗只能由真人键盘触发（反作弊拦截自动化键注入，见 injection-blocked.json）。
// 本脚本起两个守望者：① ime-capture-candidate.ps1 轮询候选窗（MSCTFIME UI）出现即截图；
// ② 轮询 nodus.db 检测真人输入的「你好」落库（排除电池测试会话）。任一证据到手即落盘
// artifacts/ime-human-evidence.json——之后 record-ime-verification.mjs 只需真人确认声明。
import { sha256File as sha256, gitCommit as commit, repoRoot } from './lib/evidence.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = repoRoot();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tuiPid = Number(process.argv[2] ?? 0);
const tuiHwnd = Number(process.argv[3] ?? 0);
const watchSec = Number(process.argv[4] ?? 300);
if (!tuiHwnd) { console.error('usage: node scripts/ime-human-watch.mjs <tuiPid> <tuiHwnd> [seconds]'); process.exit(2); }

const EVID = join(ROOT, 'artifacts', 'ime-evidence');
const out = {
  kind: 'ime-human-watch',
  generatedAt: new Date().toISOString(),
  commit, tuiPid, tuiHwnd,
  candidate: null, dbSubmit: null, status: 'waiting',
};

// ① 候选窗守望（PowerShell 轮询 MSCTFIME UI）
const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'ime-capture-candidate.ps1'), String(tuiHwnd), String(watchSec)], { cwd: ROOT, windowsHide: true });
let psOut = '';
ps.stdout.on('data', d => { psOut += d; });

// ② 落库守望：真人输入的 你好（排除电池测试会话 s17868923503391 等 msg0/1/2 来源）
let Database = null;
try { Database = (await import('better-sqlite3')).default; } catch {}
const batterySessions = new Set(['s17868923503391', 's17868923130791']);
const startTs = Date.now();

const t0 = Date.now();
while (Date.now() - t0 < watchSec * 1000) {
  if (Database) {
    try {
      const db = new Database(join(ROOT, 'data', 'nodus.db'), { readonly: true });
      const hit = db.prepare("SELECT id, session_id, content, ts FROM messages WHERE role='user' AND ts > ? AND content LIKE '%你好%' ORDER BY ts DESC LIMIT 3").all(startTs);
      db.close();
      const human = hit.filter(r => !batterySessions.has(r.session_id));
      if (human.length) {
        out.dbSubmit = { matched: true, rows: human };
        console.log(`[ime-human] DB 你好 landed: ${JSON.stringify(human)}`);
        break;
      }
    } catch {}
  }
  const candShot = join(EVID, 'ime-candidate-human.png');
  if (!out.candidate && existsSync(candShot)) {
    out.candidate = { file: 'ime-candidate-human.png', sha256: sha256(candShot) };
    console.log('[ime-human] candidate window screenshot captured');
  }
  await sleep(1000);
}

ps.kill();
// 解析 ps 输出
try {
  const j = JSON.parse(String(psOut).slice(String(psOut).indexOf('{'), String(psOut).lastIndexOf('}') + 1));
  if (j.found) out.candidateWatch = j;
} catch {}

const tuiShot = join(EVID, 'ime-candidate-human-tui.png');
if (existsSync(tuiShot)) out.tuiShot = { file: 'ime-candidate-human-tui.png', sha256: sha256(tuiShot) };

out.status = (out.candidate || out.dbSubmit?.matched) ? 'evidence-captured' : 'timeout';
writeFileSync(join(ROOT, 'artifacts', 'ime-human-evidence.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`\n[ime-human] status=${out.status} · candidate=${out.candidate ? 'yes' : 'no'} · dbSubmit=${out.dbSubmit?.matched ? 'yes' : 'no'}`);
console.log(`[ime-human] written: artifacts/ime-human-evidence.json`);
process.exit(out.status === 'evidence-captured' ? 0 : 2);
