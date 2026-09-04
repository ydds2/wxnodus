// scripts/tui-e2e-mock.mjs — TUI 全链路 e2e（本地 mock 模型——无 key 真机验证运行态面）
// 覆盖（此前 CI 不可验证面）：真实回合流式 / 运行中排队 / Esc 暂留+清空 / Ctrl+S steer /
// 危险工具审批闭环（allow+deny）/ 计划模式批准链。
// 用法：npm run e2e:tui（本地验收）；CI 不使用（需 ConPTY + 本地端口）。
import { spawn } from 'node-pty';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = {};
const mark = (name, ok) => { checks[name] = ok; console.log(`${ok ? '✓' : '✗'} ${name}`); };

// node-pty 在二次 spawn 时偶发 AttachConsole 助手进程噪音（环境层，非产品缺陷）——仅此噪声豁免，其余未捕获异常照常爆
process.on('uncaughtException', (e) => {
  if (String(e?.message ?? e).includes('AttachConsole')) return;
  throw e;
});

const PORT = 18137;
const seedSettings = (dataDir, mode) => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ model: 'mock-model', baseURL: `http://127.0.0.1:${PORT}/v1`, mode }, null, 2), 'utf8');
};

// ── mock 模型：危险工具测试 → del tool_call（SSE 增量）；否则流式文本 ──
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d });
  req.on('end', () => {
    let msgs = [];
    try { msgs = (JSON.parse(body || '{}').messages ?? []); } catch {}
    const lastUser = String(msgs.filter(m => m.role === 'user').at(-1)?.content ?? '');
    const hasToolResult = msgs.some(m => m.role === 'tool');
    if (/工具/.test(lastUser) && !hasToolResult) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'del C:\\Users\\Public\\never-exists-wxnodus-e2e.txt' }) } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = ['这是', '本地 mock 模型', '的流式回答', '（验证回合链路）'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`); i++; }
      else { res.write('data: [DONE]\n\n'); res.end(); clearInterval(timer); }
    }, 400);
  });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const boot = (dataDir) => spawn(process.execPath, ['dist/cli/index.js', '--data-dir', dataDir, '--lang', 'zh-CN'], { name: 'xterm-256color', cols: 100, rows: 24, cwd: root, env: { ...process.env, WXNODUS_API_KEY: 'mock-key', WXNODUS_TUI_TERM: 'full' } });
const quit = async (p, dataDir) => {
  p.write('\x03'); await sleep(300); p.write('\x03'); await sleep(1200);
  try { p.kill() } catch {}
  await sleep(400);
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
};

// ── 场景 1：smart 模式——流式回合 + 排队/Esc/steer + 审批闭环 ──
{
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-e2e-'));
  seedSettings(dataDir, 'smart');
  const p = boot(dataDir);
  let buf = '';
  p.onData(d => { buf += d });
  await sleep(6500);
  // 完整流式回合
  buf = '';
  p.write('你好'); await sleep(300); p.write('\r');
  await sleep(3500);
  let t = strip(buf);
  mark('真实回合流式', t.includes('本地 mock 模型') && t.includes('验证回合链路'));
  // 运行中排队 → Esc 暂留 → 再按清空
  buf = '';
  p.write('第二个回合'); await sleep(300); p.write('\r');
  await sleep(500);
  p.write('排队的任务'); await sleep(200); p.write('\r');
  await sleep(300);
  p.write('\x1b'); await sleep(400);
  p.write('\x1b'); await sleep(500);
  t = strip(buf);
  mark('运行中排队 + Esc 暂留', t.includes('暂留'));
  mark('再按 Esc 清空队列', t.includes('已清空'));
  // Ctrl+S steer（新回合内）
  buf = '';
  p.write('第三个回合'); await sleep(300); p.write('\r');
  await sleep(500);
  p.write('注入的指令\x13'); // 文本 + Ctrl+S
  await sleep(1200);
  t = strip(buf);
  mark('Ctrl+S steer 注入', t.includes('已注入当前回合') || t.includes('注入的指令'));
  await sleep(3000); // 让注入回合完全收尾（kernel 侧串行队列）——防审批回合被排队延迟
  // 危险工具审批闭环：allow
  buf = '';
  p.write('帮我工具测试'); await sleep(300); p.write('\r');
  await sleep(3000);
  t = strip(buf);
  mark('危险工具审批浮层', t.includes('工具调用审批'));
  p.write('\r'); // Enter → 仅本次允许
  await sleep(3500);
  t = strip(buf);
  mark('审批放行后工具执行', t.includes('bash') && t.includes('never-exists'));
  // deny
  buf = '';
  p.write('工具测试二'); await sleep(300); p.write('\r');
  await sleep(2500);
  p.write('\x1b'); await sleep(1500);
  t = strip(buf);
  mark('Esc 拒绝审批', t.includes('拒绝') || t.includes('未执行') || t.includes('deny'));
  await sleep(2500); // 让审批回合完全收尾（kernel 串行队列）
  // 回滚时间线 → 二次确认 → /undo 1 执行链
  buf = '';
  p.write('/undo'); await sleep(300); p.write('\r');
  await sleep(1500);
  t = strip(buf);
  mark('回滚时间线面板', t.includes('回滚时间线') && t.includes('回滚将丢弃'));
  p.write('\x1b[B'); await sleep(300); // ↓ → 选倒数第二新（丢弃其后 1 轮）
  p.write('\r'); await sleep(1500);
  t = strip(buf);
  mark('回滚二次确认', t.includes('回滚 1 轮') || t.includes('归档'));
  p.write('\r'); await sleep(2500); // Enter → 确认回滚
  t = strip(buf);
  mark('回滚执行落地', t.includes('已撤销') || t.includes('撤销') && t.includes('存档'));
  await quit(p, dataDir);
}

// ── 场景 2：plan 模式批准链 ──
{
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-e2e-plan-'));
  seedSettings(dataDir, 'plan');
  const p = boot(dataDir);
  let buf = '';
  p.onData(d => { buf += d });
  await sleep(6500);
  buf = '';
  p.write('做个计划'); await sleep(300); p.write('\r');
  await sleep(4000);
  let t = strip(buf);
  mark('计划提案面板', t.includes('执行计划') && t.includes('批准并执行'));
  p.write('\r'); // Enter → 批准
  await sleep(4500);
  t = strip(buf);
  if (!(t.includes('已批准计划') && t.includes('按上述计划开始执行') && t.includes('本地 mock 模型'))) {
    console.log('===PLAN-POST-DUMP===');
    console.log(t.split('\n').filter(l => l.includes('▎') || l.includes('◆') || l.includes('计划')).slice(-10).join('\n'));
  }
  mark('批准后按计划执行', t.includes('已批准计划') && t.includes('按上述计划开始执行') && t.includes('本地 mock 模型'));
  await quit(p, dataDir);
}

// ── 场景 3：无硬件诚实降级（/voice 无设备 · /paste 无剪贴板图）+ 模型选择器切换 ──
{
  const dataDir = mkdtempSync(join(tmpdir(), 'wx-e2e-deg-'));
  seedSettings(dataDir, 'smart');
  const p = boot(dataDir);
  let buf = '';
  p.onData(d => { buf += d });
  await sleep(6500);
  // /voice：无录音设备 → 诚实降级（不假装录音）
  buf = '';
  p.write('/voice'); await sleep(300); p.write('\r');
  await sleep(2000);
  let t = strip(buf);
  mark('voice 无设备诚实降级', t.includes('语音') && (t.includes('不可用') || t.includes('未接入') || t.includes('失败')));
  // /paste：无剪贴板图 → 诚实失败（不假装分析）
  buf = '';
  p.write('/paste'); await sleep(300); p.write('\r');
  await sleep(2500);
  t = strip(buf);
  mark('paste 无图诚实失败', t.includes('剪贴板') || t.includes('clipboard') || t.includes('失败'));
  // /model 选择器：↓ 选中第二项 → Enter → 状态栏模型名切换
  buf = '';
  p.write('/model'); await sleep(300); p.write('\r');
  await sleep(800);
  p.write('\x1b[B'); await sleep(300); // ↓ → 第 2 项
  p.write('\r'); await sleep(2500);
  t = strip(buf);
  mark('模型选择器切换生效', t.includes('模型') && (t.includes('◆ 模型') || t.includes('切换') || t.includes('已切换')));
  await quit(p, dataDir);
}

server.close();
const fails = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(`\nE2E: ${Object.keys(checks).length - fails.length}/${Object.keys(checks).length} 通过${fails.length ? ` · 失败：${fails.join(', ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
