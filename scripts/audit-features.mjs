// 全功能落地审计：71 条命令逐一 -p 实测（F3 修复 2026-08-19：全隔离运行）
// 判定标准：输出非空、非「未知命令」、非执行报错（no such table/TypeError/异常）
// F3 事故复盘：旧版备份/恢复 ROOT/data 三元组 + /gateway 阻塞用例 execSync 超时杀不死子进程树
// （孤儿进程持库 → 后续 restore 覆盖活库 → 新开者 NOTADB）——本版每个用例独立临时
// --data-dir（绝不触碰开发数据），服务器型用例 spawn 后 taskkill /F /T 强杀整树。
import { execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'cli', 'index.js');

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
// 阻塞型服务器命令：spawn 4s 后强杀整树（execSync 超时杀不死 node 子进程树——F3 孤儿进程事故根因）
const SERVER_CASES = new Set(['/gateway']);

const runServer = (full, dataDir) => {
  const child = spawn(process.execPath, [BIN, '--data-dir', dataDir, '-p', full], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', c => { out += String(c); });
  child.stderr.on('data', c => { out += String(c); });
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { execSync(`taskkill /F /T /PID ${child.pid}`, { windowsHide: true, stdio: 'ignore' }); } catch { /* 树已清 */ }
  }, 4000).unref();
  return new Promise(resolve => {
    child.on('exit', () => setTimeout(() => resolve(out), 200));
    setTimeout(() => resolve(out), 4600).unref();
  });
};

const results = [];
for (const [cmd, ...rest] of CASES) {
  const full = [cmd, ...rest].join(' ');
  const dataDir = mkdtempSync(join(tmpdir(), 'wxn-audit-'));
  let out = '';
  try {
    out = SERVER_CASES.has(cmd)
      ? await runServer(full, dataDir)
      : execSync(`node "${BIN}" --data-dir "${dataDir}" -p "${full.replace(/"/g, '\\"')}"`, { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true });
  } catch (e) {
    out = String(e?.stdout ?? e?.message ?? '');
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
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
process.exit(fails.length ? 1 : 0);
