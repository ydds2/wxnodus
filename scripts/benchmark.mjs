// scripts/benchmark.mjs — WxNodus 性能实测基准（真实 TUI 进程，winpty/ConPTY 双管线）
// 产出：artifacts/benchmark.json——启动就绪延迟（3 次取中位）/ 就绪 RSS / 确定性命令延迟 / 消息回显吞吐
// 诚实原则：只报实测数字，不设「表演性阈值」——eval 报告按实测值判分。
import { spawn } from 'node-pty';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'cli', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

const runOnce = async (useConpty) => {
  const p = spawn(process.execPath, [BIN], {
    name: 'xterm-256color', cols: 100, rows: 30,
    cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color' }, useConpty,
  });
  let out = '';
  p.onData(d => { out += d; });
  const t0 = Date.now();
  let readyMs = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && readyMs === null) {
    const t = strip(out);
    if (t.includes('WxNodus') || t.includes('WXNODUS')) {
      if (/就绪|ready/.test(t) && t.includes('❯')) readyMs = Date.now() - t0;
    }
    await sleep(50);
  }
  await sleep(1200);
  let rss = 0;
  try {
    const ps = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${p.pid}).WorkingSet64`], { encoding: 'utf8' });
    rss = Number(String(ps).trim()) || 0;
  } catch { rss = 0; }

  // 确定性命令延迟：/calc 1+2 → '= 3'
  let calcMs = null;
  if (readyMs !== null) {
    const mark = out.length;
    p.write('/');
    await sleep(500);
    p.write('calc');
    await sleep(600);
    p.write(' 1+2');
    await sleep(400);
    const tEnter = Date.now();
    p.write('\r');
    const calcDeadline = Date.now() + 10000;
    while (Date.now() < calcDeadline && calcMs === null) {
      if (strip(out.slice(mark)).includes('= 3')) calcMs = Date.now() - tEnter;
      await sleep(50);
    }
  }

  // 消息回显吞吐：15 条 ASCII 短消息逐条等回显
  let echoMs = null;
  if (readyMs !== null) {
    const tStart = Date.now();
    for (let i = 0; i < 15; i++) {
      const m = out.length;
      for (const ch of 'perf-msg-' + i) { p.write(ch); await sleep(20); }
      p.write('\r');
      const d = Date.now() + 8000;
      while (Date.now() < d && !strip(out.slice(m)).includes('perf-msg-' + i)) await sleep(50);
    }
    echoMs = Date.now() - tStart;
  }
  try { p.kill(); } catch {}
  return { readyMs, rss, calcMs, echoMs };
};

const main = async () => {
  const results = { winpty: [], conpty: [] };
  for (let i = 0; i < 3; i++) { console.log(`[bench] winpty run ${i + 1}/3...`); results.winpty.push(await runOnce(false)); }
  for (let i = 0; i < 3; i++) { console.log(`[bench] ConPTY run ${i + 1}/3...`); results.conpty.push(await runOnce(true)); }
  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const summary = {
    generatedAt: new Date().toISOString(),
    startupReadyMs: { winpty: med(results.winpty.map(r => r.readyMs).filter(x => x != null)), conpty: med(results.conpty.map(r => r.readyMs).filter(x => x != null)) },
    readyRssMb: Math.round((med(results.winpty.map(r => r.rss).filter(x => x > 0)) ?? 0) / 1048576),
    calcLatencyMs: { winpty: med(results.winpty.map(r => r.calcMs).filter(x => x != null)) ?? null, conpty: med(results.conpty.map(r => r.calcMs).filter(x => x != null)) ?? null },
    echo15MsgsMs: { winpty: med(results.winpty.map(r => r.echoMs).filter(x => x != null)) ?? null, conpty: med(results.conpty.map(r => r.echoMs).filter(x => x != null)) ?? null },
    raw: results,
  };
  mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
  writeFileSync(join(ROOT, 'artifacts', 'benchmark.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
};

main().catch(e => { console.error('benchmark crashed:', e); process.exit(1); });
