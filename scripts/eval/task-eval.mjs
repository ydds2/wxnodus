// scripts/eval/task-eval.mjs — P2-13（2026-08-27）：任务级评测 harness
// 机制参考：aider Exercism polyglot / gemini evals（行为评估）思路——实现原创：
//   ① 任务 = 中文规格（task.md）+ 零模型依赖的评分脚本（verify.mjs 对 solution.mjs 断言）；
//   ② 每任务 × N 轮：真实模型端点（env 供给）经 `wxnodus -p` 在工作区内实现 solution.mjs，
//      评分脚本独立运行 → pass/fail；任何环境缺失/模型失败诚实记录，绝不虚报；
//   ③ 产出：artifacts/task-eval.md + task-eval.json（通过率/逐轮证据/commit+时间戳）。
// 用法：
//   $env:WXNODUS_EVAL_BASE_URL='http://…/v1'; $env:WXNODUS_EVAL_API_KEY='…'; $env:WXNODUS_EVAL_MODEL='deepseek-chat'
//   npm exec -- node scripts/eval/task-eval.mjs [--rounds N] [--tasks t1,t2]
// 未配置端点 → 诚实 skip（exit 2）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'tasks');
const ARTIFACTS = join(ROOT, 'artifacts');
const now = () => new Date().toISOString();

const flag = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const ROUNDS = Math.max(1, Math.min(10, Number(flag('--rounds', '3')) || 3));
const TASK_FILTER = (flag('--tasks', '') || '').split(',').filter(Boolean);

const base = process.env.WXNODUS_EVAL_BASE_URL;
const key = process.env.WXNODUS_EVAL_API_KEY;
const model = process.env.WXNODUS_EVAL_MODEL;
if (!base || !key) {
  console.error('EVAL_SKIP: 未配置真实模型端点（WXNODUS_EVAL_BASE_URL / WXNODUS_EVAL_API_KEY / WXNODUS_EVAL_MODEL）——任务级评测需要真实模型，mock 无法解题。');
  process.exit(2);
}

const CLI = join(ROOT, 'dist', 'cli', 'index.js');
if (!existsSync(CLI)) {
  console.error('EVAL_SKIP: dist/cli/index.js 未构建——先 npm run build');
  process.exit(2);
}

const taskIds = readdirSync(TASKS_DIR).filter(d => existsSync(join(TASKS_DIR, d, 'task.md')) && existsSync(join(TASKS_DIR, d, 'verify.mjs')))
  .filter(d => !TASK_FILTER.length || TASK_FILTER.includes(d))
  .sort();
if (!taskIds.length) { console.error('EVAL_NO_TASKS: 无匹配任务'); process.exit(2); }

/** 单任务单轮：工作区 → agent 实现 → verify 评分（timeout 默认 10min） */
const runRound = (taskId, round) => {
  const ws = mkdtempSync(join(tmpdir(), `wxn-eval-${taskId}-`));
  try {
    writeFileSync(join(ws, 'task.md'), readFileSync(join(TASKS_DIR, taskId, 'task.md'), 'utf8'));
    const prompt = `请阅读 task.md 并完成其中的任务。要求：\n1. 将实现写入当前工作区的 solution.mjs（CommonJS 或 ESM 均可，必须能被 node 直接执行）；\n2. 只输出实现代码与必要说明，不要修改 task.md；\n3. 实现完成后可运行 verify.mjs 自测（node verify.mjs）。`;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [CLI, '--data-dir', join(ws, '.data'), '-p', prompt], {
      cwd: ws, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, WXNODUS_BASE_URL: base, WXNODUS_API_KEY: key, WXNODUS_MODEL: model ?? undefined },
    });
    const agentMs = Date.now() - t0;
    const solutionPath = join(ws, 'solution.mjs');
    if (!existsSync(solutionPath)) {
      return { taskId, round, pass: false, agentExit: r.status, agentMs, error: '未产出 solution.mjs', tail: String(r.stdout ?? '').slice(-300) };
    }
    const v = spawnSync(process.execPath, [join(TASKS_DIR, taskId, 'verify.mjs')], { cwd: ws, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { taskId, round, pass: v.status === 0, agentExit: r.status, agentMs, verifyExit: v.status, verifyOut: String(v.stdout ?? '').trim(), tail: String(r.stdout ?? '').slice(-200) };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
};

const report = { generatedAt: now(), rounds: ROUNDS, model, base, tasks: [] };
const rows = [];
console.log(`任务级评测：${taskIds.length} 任务 × ${ROUNDS} 轮 · 模型 ${model}`);
for (const taskId of taskIds) {
  const spec = readFileSync(join(TASKS_DIR, taskId, 'task.md'), 'utf8').split('\n')[0] ?? taskId;
  const results = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const r = runRound(taskId, i);
    results.push(r);
    rows.push([taskId, String(i), r.pass ? 'PASS' : 'FAIL', `${(r.agentMs / 1000).toFixed(1)}s`, r.error ?? r.verifyOut ?? '']);
    console.log(`  ${taskId} #${i}: ${r.pass ? 'PASS' : 'FAIL'}（agent ${(r.agentMs / 1000).toFixed(1)}s${r.error ? ` · ${r.error}` : ''}）`);
  }
  const pass = results.filter(r => r.pass).length;
  report.tasks.push({ taskId, spec, pass, total: results.length, passRate: pass / results.length, results });
}

mkdirSync(ARTIFACTS, { recursive: true });
const md = [
  '# 任务级评测报告（P2-13 harness）',
  '',
  `- 生成时间：${report.generatedAt}`,
  `- 模型端点：${model} @ ${base}`,
  `- 轮次：每任务 ${ROUNDS} 轮`,
  '',
  '| 任务 | 通过率 | 轮次 |',
  '|---|---|---|',
  ...report.tasks.map(t => `| ${t.taskId}（${t.spec.slice(0, 40)}） | ${t.pass}/${t.total}（${(t.passRate * 100).toFixed(0)}%） | ${t.results.map(r => r.pass ? '✅' : '❌').join(' ')} |`),
  '',
  '## 逐轮证据',
  '',
  '| 任务 | 轮 | 结果 | agent 耗时 | 注记 |',
  '|---|---|---|---|---|',
  ...rows.map(r => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${String(r[4]).replace(/\|/g, '\\|').slice(0, 160)} |`),
  '',
  '## 口径',
  '',
  '- 任务为确定性纯函数规格（零模型依赖评分）：通过 = verify.mjs 对 solution.mjs 全断言绿；',
  '- 任务级通过率是私有化部署的质量硬证据——同一端点换模型即可横向对比（数据不出机）。',
  '',
].join('\n');
writeFileSync(join(ARTIFACTS, 'task-eval.md'), md, 'utf8');
writeFileSync(join(ARTIFACTS, 'task-eval.json'), JSON.stringify(report, null, 2), 'utf8');
const overall = report.tasks.reduce((a, t) => a + t.pass, 0);
const total = report.tasks.reduce((a, t) => a + t.total, 0);
console.log(`\n总通过率：${overall}/${total}（${((overall / total) * 100).toFixed(0)}%）→ artifacts/task-eval.{md,json}`);
process.exit(overall === total ? 0 : 1);
