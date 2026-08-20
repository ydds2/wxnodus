// scripts/evidence-memory-capacity.ts — W8-04：「百万字级记忆库」容量证据（tsx 实跑）
// 契约：黑洞引擎 archival/recall 不设上限——本脚本向单会话真实写入 ≥1,000,000 token
// 估算量的消息后验证：吸附正常（working 有界）/ recall 全量 / 深历史 FTS 召回命中 /
// compactSmart 可用。证据落 artifacts/release-evidence/<runId>/memory-capacity/outcome.json。
// 诚实边界：embedding 关闭（WXNODUS_EMBED=off）走纯 FTS 路径——向量召回路径由
// tests/kernel-memory.test.ts 小规模真实覆盖；本脚本只背书「容量」，不宣称「模型窗口」。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const runId = flag('run');
if (!runId) {
  console.error('EVIDENCE_USAGE: --run <runId>');
  process.exit(2);
}

const TARGET_TOKENS = 1_000_000;
const MAX_MESSAGES = 60_000; // 安全上限：超限未达 1M token 即诚实失败（绝不谎报）
const WORKING_LIMIT = 20; // 生产默认
const NEEDLE = '黑洞针点七曜九三二'; // 深历史唯一标记（第 5 条消息植入）

const { openDB, closeDB } = await import('../src/store/db.js');
const { createMemory, estimateMessagesTokens } = await import('../src/kernel/memory.js');

// 纯 FTS 确定性路径（向量路径由 suite 覆盖——本脚本是容量背书不是向量背书）
process.env.WXNODUS_EMBED = 'off';

const dir = mkdtempSync(join(tmpdir(), 'wxn-cap-'));
const db = openDB(dir);
const mem = createMemory(db, { workingLimit: WORKING_LIMIT });
const sessionId = 'cap-1m';

const pad = (n: number): string => String(n).padStart(6, '0');
// 每条 ~100 字 CJK（≈100 token）：叙述性长文本，含计数序号防 A21 去重合并
const msg = (n: number, role: 'user' | 'assistant'): string => {
  const base = role === 'user'
    ? `第${pad(n)}轮用户输入：关于本地优先的智能体设计，我们需要讨论工作区边界、下载框架的原子落盘、黑洞引擎的三层记忆结构与自动吸附阈值。`
    : `第${pad(n)}轮助手回复：已记录。工作区根采用用户动态指定，下载采用临时文件加原子改名，记忆采用工作窗口有界而归档与全量召回不受限的设计，并对系统目录接触强制专属确认。`;
  return n === 5 && role === 'user' ? `${base}（${NEEDLE}）` : base;
};

const t0 = Date.now();
let totalTokens = 0;
let total = 0;
for (let n = 1; n <= MAX_MESSAGES; n += 2) {
  mem.append(sessionId, 'user', msg(n, 'user'));
  mem.append(sessionId, 'assistant', msg(n, 'assistant'));
  total += 2;
  if (n % 100 === 1) {
    totalTokens = estimateMessagesTokens(mem.recall(sessionId));
    if (totalTokens >= TARGET_TOKENS) break;
  }
}
const insertMs = Date.now() - t0;
totalTokens = estimateMessagesTokens(mem.recall(sessionId));

const working = mem.working(sessionId);
const recall = mem.recall(sessionId);
const absorb = mem.absorbCount(sessionId);

const t1 = Date.now();
const needleHits = await mem.recallHybrid(NEEDLE, { limit: 3, sessionId });
const genericHits = await mem.recallHybrid('本地优先', { limit: 10, sessionId });
const recallMs = Date.now() - t1;

let compactOk = false;
let workingAfter = -1;
try {
  await mem.compactSmart(sessionId, async () => '摘要：本地优先智能体的设计与实现进展。');
  compactOk = true;
  workingAfter = mem.working(sessionId).length;
} catch { /* compactSmart 失败即如实记录 */ }

const checks = {
  targetReached: totalTokens >= TARGET_TOKENS,
  workingBounded: working.length <= WORKING_LIMIT,
  recallComplete: recall.length === total,
  absorbActive: absorb > 0,
  needleRecall: needleHits.length > 0 && needleHits.some(h => h.content.includes(NEEDLE)),
  genericRecall: genericHits.length > 0,
  compactWorks: compactOk && workingAfter >= 0 && workingAfter <= WORKING_LIMIT,
};
const passed = Object.values(checks).every(Boolean);

const outcome = {
  schema: 'memory-capacity-evidence@1',
  runId,
  timestamp: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}/node${process.version}`,
  targetTokens: TARGET_TOKENS,
  totalMessages: total,
  totalTokens,
  workingLimit: WORKING_LIMIT,
  workingSize: working.length,
  absorbCount: absorb,
  embedPath: 'off（纯 FTS；向量路径由 tests/kernel-memory.test.ts 小规模真实覆盖）',
  needle: { value: NEEDLE, hits: needleHits.length },
  genericRecallHits: genericHits.length,
  compactSmart: { ok: compactOk, workingAfter },
  insertMs,
  recallHybridMs: recallMs,
  checks,
  status: passed ? 'passed' : 'failed',
  verdict: passed
    ? '记忆容量（存储/召回）在百万字级保持可用；模型每轮上下文窗口仍受 64k 上限约束（超压自动压缩）——「百万字级记忆库」表述背书成立'
    : '容量证据未达标——表述背书不成立，如实 blocked',
};
const outDir = join(ROOT, 'artifacts', 'release-evidence', runId, 'memory-capacity');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'outcome.json'), JSON.stringify(outcome, null, 2));
console.log(JSON.stringify({ status: outcome.status, totalMessages: total, totalTokens, workingSize: working.length, absorbCount: absorb, needleHits: needleHits.length, insertMs, recallHybridMs: recallMs, receipt: join(outDir, 'outcome.json') }, null, 2));

closeDB(db);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不阻断 */ }
process.exit(passed ? 0 : 2);
