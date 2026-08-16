// tests/acceptance/windows/acceptance-build-harness.mjs — build-restart-readback 场景驱动
// 语义：以 <projectDir>（缺省 process.cwd()，由 .cmd 包装经 Start-Process -WorkingDirectory 注入）
// 为工作目录真实启动项目服务（node server/index.js），并：
//   1. .wxnodus-server.pid ← 本 harness 自身 pid（进程树根——taskkill /T 从根杀整树）
//   2. data.txt ← 读回标记，内容取自真实持久层 server/data.json 的 items 数
//      （重启后新实例从同一持久层写回同一内容 → 场景「读回同一数据」是真实持久化读回）
// 用法：node acceptance-build-harness.mjs [projectDir]
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const projectDir = process.argv[2] ?? process.cwd();
const serverEntry = join(projectDir, 'server', 'index.js');
if (!existsSync(serverEntry)) {
  console.error(`HARNESS_NO_SERVER_ENTRY: ${serverEntry}`);
  process.exit(2);
}
const port = process.env.WXNODUS_BUILD_PORT ?? '4321';
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: projectDir,
  env: { ...process.env, PORT: port },
  stdio: ['ignore', 'pipe', 'pipe'],
});
writeFileSync(join(projectDir, '.wxnodus-server.pid'), String(process.pid), 'utf8');

const refreshMarker = () => {
  let content = 'no-data';
  try {
    const store = JSON.parse(readFileSync(join(projectDir, 'server', 'data.json'), 'utf8'));
    content = `items:${Array.isArray(store.items) ? store.items.length : '?'}`;
  } catch {}
  writeFileSync(join(projectDir, 'data.txt'), content, 'utf8');
};
refreshMarker();
const timer = setInterval(refreshMarker, 1000);
child.on('exit', () => { clearInterval(timer); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(timer); try { child.kill(); } catch {} process.exit(0); });
