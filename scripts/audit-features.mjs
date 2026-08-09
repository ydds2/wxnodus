// 全功能落地审计：67 条命令逐一 -p 实测
// 判定标准：输出非空、非「未知命令」、非执行报错（no such table/TypeError/异常）
// 执行前后备份恢复 data（settings/nodus.db）——避免持久化副作用污染测试环境
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'cli', 'index.js');

// ── 数据备份/恢复 ──────────────────────────
const DATA = join(ROOT, 'data');
const BAK = join(tmpdir(), `wxnodus-audit-bak-${process.pid}`);
mkdirSync(BAK, { recursive: true });
for (const f of ['settings.json', 'nodus.db', 'nodus.db-wal', 'nodus.db-shm']) {
  if (existsSync(join(DATA, f))) copyFileSync(join(DATA, f), join(BAK, f));
}
const restore = () => {
  try {
    for (const f of ['settings.json', 'nodus.db', 'nodus.db-wal', 'nodus.db-shm']) {
      if (existsSync(join(BAK, f))) copyFileSync(join(BAK, f), join(DATA, f));
    }
    rmSync(BAK, { recursive: true, force: true });
  } catch { /* 恢复失败静默 */ }
};

// 全部 67 条命令的审计用例（参数按可离线运行设计）
const CASES = [
  // 对话
  ['/help'], ['/help build'], ['/clear'], ['/usage'], ['/sessions'], ['/resume'],
  ['/undo'], ['/context'],
  // 模型
  ['/key'], ['/model'], ['/model deepseek-chat'], ['/status'], ['/doctor'], ['/version'], ['/thinking'],
  // 记忆
  ['/memory'], ['/hole 测试'], ['/compact'], ['/digest'], ['/curator'],
  // 构建
  ['/build'], ['/deploy'], ['/forge demo'], ['/skill demo'], ['/gate'], ['/fdr demo'], ['/evidence'],
  // 安全
  ['/perm'], ['/perm smart'], ['/sandbox'], ['/compliance'], ['/consent'], ['/audit'], ['/encrypt'],
  // 系统
  ['/backup'], ['/export 你好'], ['/theme'], ['/lang'], ['/lang en'], ['/config'], ['/logs'], ['/bench'],
  // 视觉
  ['/vision'], ['/img'], ['/video'], ['/render 你好'], ['/capture'],
  // 网络
  ['/claw'], ['/mcp'], ['/gateway'], ['/proxy'], ['/webhook'], ['/a2a'], ['/acp'],
  // 协作
  ['/swarm'], ['/duo'], ['/cron'], ['/jobs'], ['/delegate 任务'], ['/goal 目标'],
  // 工具
  ['/calc 1+2*3'], ['/hash sha256 abc'], ['/base64 e hello'], ['/uuid'], ['/rand 8'],
  ['/json {"a":1}'], ['/timer 5'], ['/sql SELECT 1'], ['/fs ls .'], ['/units 米 英尺 1'], ['/csv a,b|c,d'],
];

const BAD = ['未知命令', '没有这个命令', 'not implemented', 'no such table', 'TypeError', 'ReferenceError', '异常', '执行失败'];
// 无输出的合法命令：交互专属（pty 场景测试覆盖）/ 无副作用
const SKIP_OUTPUT_EMPTY = new Set(['/quit', '/clear', '/sessions', '/model']);

const results = [];
for (const [cmd, ...rest] of CASES) {
  const full = [cmd, ...rest].join(' ');
  let out = '';
  try {
    out = execSync(`node "${BIN}" -p "${full.replace(/"/g, '\\"')}"`, { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true });
  } catch (e) {
    out = String(e?.stdout ?? e?.message ?? '');
  }
  const clean = out.trim();
  const bad = BAD.find(b => clean.includes(b));
  const ok = bad === undefined && (clean.length > 0 || SKIP_OUTPUT_EMPTY.has(cmd));
  results.push({ cmd: full, ok, evidence: clean.slice(0, 70).replace(/\n/g, '\\n') });
  console.log(`${ok ? '✓' : '✗'}  ${full.padEnd(24)} ${ok ? '' : '→ ' + bad}  ${clean.slice(0, 60)}`);
}

const pass = results.filter(r => r.ok).length;
console.log(`\n===== 功能落地审计：${pass}/${results.length} 命令真实落地 =====`);
const fails = results.filter(r => !r.ok);
if (fails.length) {
  console.log('未落地：');
  fails.forEach(f => console.log(`  ✗ ${f.cmd} → ${f.evidence.slice(0, 80)}`));
}
restore(); // 恢复测试数据
process.exit(fails.length ? 1 : 0);
