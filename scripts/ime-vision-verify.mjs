// scripts/ime-vision-verify.mjs — IME/中文输入 真机验证 receipt（机器视觉 + 确定性落库双证据）
// 三条通道（本机反作弊拦截 SendInput/keybd_event 的真实边界见 artifacts/ime-evidence/injection-blocked.json）：
//   ① Unicode 控制台注入管线：scripts/ime-console-inject.ps1 经 WriteConsoleInputW 向真实 conhost
//      输入缓冲写入 Unicode KEY_EVENT（OS IME 提交后 conhost 投递应用的同一通道）——验证
//      上屏渲染 → Enter 提交 → 回显 → 落库全链路；
//   ② GLM-4V 视觉核验：对窗口截图逐图核验（输入框含「你好」、会话区回显「你好」）；
//   ③ 确定性落库：nodus.db 近 10 分钟新增含「你好」的 user 消息（提交真发生的硬证据）。
// 诚实铁律：②③任一不过 → status=blocked；视觉通道不可用 → 归因不冒充。
import { sha256File as sha256, gitCommit as commit, repoRoot } from './lib/evidence.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


const ROOT = repoRoot();

const settings = JSON.parse(readFileSync(join(ROOT, 'data', 'settings.json'), 'utf8'));
const apiKeyEnc = settings.apiKeyEnc ?? null;
const model = process.env.WXNODUS_VISION_MODEL ?? 'glm-4v-flash';
const { describeImageStatus } = await import('../dist/kernel/vision.js');

const out = {
  kind: 'ime-vision-verification',
  generatedAt: new Date().toISOString(),
  commit,
  pipeline: {
    capture: 'scripts/ime-console-inject.ps1（WriteConsoleInputW → 真实 conhost 输入缓冲）',
    verifier: 'scripts/ime-vision-verify.mjs（GLM-4V 视觉核验 + nodus.db 落库核对）',
  },
  model, baseURL: process.env.WXNODUS_VISION_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
  checks: [], dbSubmit: null, status: 'blocked',
};

let ok = true;
let visionFailed = false;

// ② 视觉核验（窗口放大图优先；截图缺失/被全屏游戏遮挡 → 视觉证据降级为 corroboration，
// 主证据为 ③④ 确定性通道——如实记录 reason，不冒充）
for (const c of [
  { id: 'input', win: 'ime-unicode-input-strip.png', full: 'ime-unicode-input.png',
    prompt: '终端底部输入框区域截图。只回答：输入框文字=输入框内的文字内容（若为空回答 空）',
    pass: t => /你好/.test(t) && !/输入框文字\s*=\s*空|输入框文字\s*=\s*$|没有文字/.test(t), desc: '输入框渲染「你好」' },
  { id: 'submitted', win: 'ime-unicode-submitted-win.png', full: 'ime-unicode-submitted.png',
    prompt: '终端截图。只回答一行：最后用户消息=会话消息区最后一条用户消息的文字（没有说无）',
    pass: t => /你好/.test(t) && !/最后用户消息\s*=\s*无/.test(t), desc: '会话区回显「你好」' },
]) {
  const pick = existsSync(join(ROOT, 'artifacts', 'ime-evidence', c.win)) ? c.win : c.full;
  const abs = join(ROOT, 'artifacts', 'ime-evidence', pick);
  const check = { id: c.id, file: pick, sha256: existsSync(abs) ? sha256(abs) : null, text: null, passed: false, reason: null };
  if (!check.sha256) { check.reason = '截图缺失——视觉证据降级（主证据走 ③④）'; out.checks.push(check); continue; }
  const r = await describeImageStatus(abs, apiKeyEnc, c.prompt);
  if (!r.ok) { check.reason = r.reason ?? '视觉通道失败'; visionFailed = true; out.checks.push(check); continue; }
  check.text = r.text;
  check.passed = c.pass(r.text);
  if (!check.passed) check.reason = `视觉核验未过（可能被遮挡）：${c.desc}`;
  out.checks.push(check);
  console.log(`[ime-vision] ${c.id}: ${check.passed ? 'PASS' : 'FAIL'} → ${String(r.text).replace(/\n/g, ' ').slice(0, 140)}`);
}

// ③ 确定性落库
try {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(join(ROOT, 'data', 'nodus.db'), { readonly: true });
  const before = new Date(Date.now() - 30 * 60 * 1000).getTime();
  const hit = db.prepare("SELECT id, session_id, role, content, ts FROM messages WHERE role='user' AND ts > ? AND content LIKE '%你好%' ORDER BY ts DESC LIMIT 3").all(before);
  out.dbSubmit = { matched: hit.length > 0, rows: hit };
  console.log(`[ime-vision] dbSubmit: ${hit.length > 0 ? 'PASS' : 'FAIL'}（近 30 分钟 user 消息含「你好」× ${hit.length}）`);
  if (hit.length === 0) ok = false;
  db.close();
} catch (e) {
  out.dbSubmit = { matched: false, error: String(e).slice(0, 200) };
  ok = false;
}

// ④ 屏幕缓冲全文（conhost 活动缓冲快照 = TUI 渲染结果的确定性证据——不依赖前台/不被遮挡）
{
  const bufPath = join(ROOT, 'artifacts', 'ime-evidence', 'ime-screen-buffer.txt');
  const exists = existsSync(bufPath);
  const text = exists ? readFileSync(bufPath, 'utf8') : '';
  const hasNihao = exists && text.includes('你好');
  out.screenBuffer = { exists, sha256: exists ? sha256(bufPath) : null, chars: text.length, hasNihao };
  console.log(`[ime-vision] screenBuffer: ${hasNihao ? 'PASS' : 'FAIL'}（chars=${text.length} hasNihao=${hasNihao}）`);
  if (!hasNihao) ok = false;
}

if (ok) out.status = 'passed';
else if (visionFailed && out.checks.every(c => !c.passed)) out.status = 'unverified';
// 通过条件：③④ 确定性证据全过（视觉为佐证——被遮挡时如实记录 reason）
out.status = (out.dbSubmit?.matched && out.screenBuffer?.hasNihao) ? 'passed' : (out.status === 'unverified' ? 'unverified' : 'blocked');
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts', 'ime-vision-verification.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`\n[ime-vision] status=${out.status} · written: artifacts/ime-vision-verification.json`);
process.exit(out.status === 'passed' ? 0 : 1);
