// scripts/evidence-b1-b3-governance.mjs — B1/B3 真机验收（可重复执行的证据脚本）
// 用法：npm run build 后 node scripts/evidence-b1-b3-governance.mjs（全绿 exit 0，输出 10 项断言 JSON）
// 场景复现 8/30 事故 + B3 进程治理：临时 dataDir 零污染用户数据。
// 断言链：
//   B1a 心跳默认开启（TUI 进程向 logs/heartbeat-<日期>.log 每 2s 写 alive pid=<pid>）
//   B1b /doctor 检出「孤儿进程」（tmp-n9-probe 模拟孤儿，非 doctor 祖先）与「心跳断档」（孤儿 pid 存活但心跳陈旧）
//   B3a /mcp list 在线状态列（真实 initialize 连接）+ 内存列（真实进程工作集）
//   B3b /mcp idle on 30 → 30s 后闲置 server 进程被真实回收（pid 消亡）+ /mcp list 转未连接
import { spawn } from 'node-pty';
import { spawn as spawnProc, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
const norm = s => stripAnsi(s).replace(/\s+/g, ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = {};
const fail = (msg) => { console.error('VERIFY_FAIL: ' + msg); process.exit(1); };
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── ① B1b：孤儿夹具（独立进程树 + 特征命令行——8/30 tmp-n2 同款命名）──
const orphan = spawnProc(process.execPath, ['-e', `const marker='tmp-n9-probe-demo'; setInterval(()=>{}, 1000);`], {
  detached: true, stdio: 'ignore', windowsHide: true,
});
orphan.unref();
await sleep(500);

// ── ② B1b：doctor CLI 子命令真实检出（独立 dataDir；孤儿心跳夹具 120s 前）──
const docDir = mkdtempSync(join(tmpdir(), 'wxnodus-b1b-'));
mkdirSync(join(docDir, 'logs'), { recursive: true });
const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(docDir, 'logs', `heartbeat-${today}.log`), `${new Date(Date.now() - 120_000).toISOString()} alive pid=${orphan.pid}\n`);
const doctorOut = execFileSync(process.execPath, [join(root, 'dist/cli/index.js'), 'doctor', 'local', '--data-dir', docDir], {
  encoding: 'utf8', windowsHide: true, timeout: 120_000,
  env: { ...process.env, WXNODUS_NO_HEARTBEAT: '1' },
});
checks['B1b 孤儿进程检出'] = doctorOut.includes('孤儿进程') && doctorOut.includes(String(orphan.pid)) && doctorOut.includes('疑似遗留');
checks['B1b 心跳断档定位'] = doctorOut.includes('心跳探针') && doctorOut.includes(String(orphan.pid)) && doctorOut.includes('断档');
try { process.kill(orphan.pid); } catch { /* 已回收 */ }
rmSync(docDir, { recursive: true, force: true });
if (!checks['B1b 孤儿进程检出'] || !checks['B1b 心跳断档定位']) {
  console.error('--- doctor stdout ---\n' + doctorOut);
  fail('B1b 未检出');
}

// ── ③ mock stdio MCP server（initialize/tools/list 真应答）──
const dataDir = mkdtempSync(join(tmpdir(), 'wxnodus-b1b3-'));
const serverJs = join(dataDir, 'demo-server.js');
writeFileSync(serverJs, `
const fs = require('node:fs');
const MARK = ${JSON.stringify(join(dataDir, 'demo-exit.log'))};
process.stdin.on('end', () => { fs.appendFileSync(MARK, 'stdin-end ' + Date.now() + '\\n'); process.exit(0); });
process.on('exit', () => { try { fs.appendFileSync(MARK, 'exit ' + Date.now() + '\\n'); } catch {} });
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'demo', version: '1.0.0' } } }));
  } else if (msg.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'add', description: '加法', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
    ] } }));
  }
});
`);
writeFileSync(join(dataDir, 'mcp.json'), JSON.stringify([{ name: 'demo', command: process.execPath, args: [serverJs] }]));

// ── ④ 启动真实 TUI（dist 产物——wxnodus 命令实际运行面）──
const p = spawn(process.execPath, [join(root, 'dist/cli/index.js'), '--data-dir', dataDir, '--lang', 'zh-CN'], {
  name: 'xterm-256color', cols: 100, rows: 30, cwd: root,
  env: { ...process.env, WXNODUS_TUI_TERM: 'full', WXNODUS_UPDATE_FEED: '', NO_COLOR: '' },
});
let buf = '';
p.onData(d => { buf += d; });
let booted = false;
const deadline = Date.now() + 60_000;
while (!booted && Date.now() < deadline) {
  await sleep(250);
  const t = stripAnsi(buf);
  if (t.includes('WXNODUS') && (t.includes('Enter 发送') || t.includes('Enter 排队'))) booted = true;
}
if (!booted) { p.kill(); rmSync(dataDir, { recursive: true, force: true }); fail('60s 未完成 TUI 启动'); }
const send = async (text, settleMs = 1500) => { p.write(text); await sleep(settleMs); };
const tuiPid = p.pid;

// ── ⑤ B1a：心跳默认开启（等 2 拍以上后读日志）──
const hbFile = join(dataDir, 'logs', `heartbeat-${today}.log`);
await sleep(5200);
const hbNow = existsSync(hbFile) ? readFileSync(hbFile, 'utf8') : '';
checks['B1a 心跳默认开启(pid 行)'] = hbNow.includes(`alive pid=${tuiPid}`);

// ── ⑥ B3a：/mcp list 在线 + 内存列 ──
await send('/mcp list', 800); await send('\r', 6000);
{
  const zone = norm(buf.slice(buf.lastIndexOf('/mcp list')));
  checks['B3a 在线列'] = zone.includes('demo') && zone.includes('在线') && zone.includes('2 工具');
  const memM = zone.match(/内存[▎│ \u2502]*([\d.]+)MB/);
  checks['B3a 内存列(真实工作集)'] = Boolean(memM && Number(memM[1]) > 0);
  const pidM = zone.match(/pid (\d+)/);
  if (!pidM || !checks['B3a 在线列']) {
    console.error('--- B3a zone ---\n' + zone.slice(-1500));
    fail('B3a 未达标');
  }
  if (!checks['B3a 内存列(真实工作集)']) {
    const i = zone.indexOf('内存');
    console.error('--- B3a 内存列未达标 zone ---\n' + zone.slice(-1500));
    console.error('--- 内存 区域 codepoints ---', JSON.stringify([...zone.slice(i, i + 12)].map(c => c.codePointAt(0).toString(16))));
  }
  globalThis.demoPid = Number(pidM[1]);
}

// ── ⑦ B3b：/mcp idle on 30 → 闲置回收 ──
await send('/mcp idle on 30', 800); await send('\r', 2000);
{
  const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
  checks['B3b 开关落盘'] = settings?.mcpIdleTeardown?.enabled === true && settings?.mcpIdleTeardown?.idleSeconds === 30;
}
checks['B3b 闲置前 demo 存活'] = alivePid(globalThis.demoPid);
// 阈值 30s + 清扫周期 15s → 等 50s 兜底
let reclaimed = false;
for (let i = 0; i < 25; i++) {
  await sleep(2000);
  if (!alivePid(globalThis.demoPid)) { reclaimed = true; break; }
}
checks['B3b 闲置回收(进程消亡)'] = reclaimed;
if (!reclaimed) {
  const errLog = join(dataDir, 'logs', `error-${today}.log`);
  console.error('--- demo-exit.log ---\n' + (existsSync(join(dataDir, 'demo-exit.log')) ? readFileSync(join(dataDir, 'demo-exit.log'), 'utf8') : '(无——demo server 从未收到 stdin end)'));
  console.error('--- TUI error 日志（全文） ---\n' + (existsSync(errLog) ? readFileSync(errLog, 'utf8') : '(无 error 日志)'));
  console.error('--- TUI 缓冲内 idle-teardown 诊断 ---\n' + buf.split('mcp-idle-teardown').slice(-2).join('mcp-idle-teardown').slice(-400));
  console.error('--- demo 进程仍存活：pid ' + globalThis.demoPid);
} else {
  console.error('--- demo-exit.log（回收证据）---\n' + (existsSync(join(dataDir, 'demo-exit.log')) ? readFileSync(join(dataDir, 'demo-exit.log'), 'utf8') : '(无)'));
}
await send('/mcp list', 800); await send('\r', 6000);
{
  const zone = norm(buf.slice(buf.lastIndexOf('/mcp list')));
  checks['B3b 回收后转未连接'] = zone.includes('demo') && zone.includes('未连接');
  if (!checks['B3b 回收后转未连接']) console.error('--- B3b 回收后 zone ---\n' + zone.slice(-1500));
}

// ── 清理 ──
p.write('\x03'); await sleep(400); p.write('\x03'); await sleep(1500);
try { p.kill(); } catch { /* 已退出 */ }
rmSync(dataDir, { recursive: true, force: true });

console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), tuiPid, orphanPid: orphan.pid, demoPid: globalThis.demoPid, ...checks }, null, 2));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
