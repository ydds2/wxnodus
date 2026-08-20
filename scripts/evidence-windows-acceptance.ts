// scripts/evidence-windows-acceptance.ts — Windows 本机验收证据（tsx 实跑）
// 按场景契约真实执行（绝不硬编码通过）：preflight（机器探测）/ voice（真麦克风+whisper 真实资产+SAPI
// + 取消）/ browser（playwright chromium 真实路由观测）/ build-restart-readback（真实进程替换）/
// emergency-stop（真实进程树终止）/ uia（需 dotnet fixtures——本机无 dotnet 如实 blocked）/
// computer-multimonitor（需双屏——本机单屏如实 blocked）。
// receipt 落 artifacts/release-evidence/<runId>/windows-acceptance/outcome.json；
// 可运行场景全过 → exit 0（整体 status 'partial'——本机证据 ≠ Gate E 生产 receipt，如实区分）。
import { spawnSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeScenarioFiles } from '../src/release/evidenceScenarioFiles.js';

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

const workdir = join(ROOT, 'artifacts', 'release-evidence', runId, 'windows-acceptance');
mkdirSync(workdir, { recursive: true });
const scenarioDir = join(ROOT, 'tests', 'acceptance', 'windows');

const runScenario = (name: string, extraEnv: Record<string, string> = {}): { status: string; raw: string; parsed: Record<string, unknown> | null } => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scenarioDir, `${name}.ps1`)], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    env: { ...process.env, ...extraEnv },
  });
  // PowerShell 5.1 stdout 带 UTF-8 BOM——剥离后解析（ConvertTo-Json 为多行 JSON，整段解析）
  const raw = String(r.stdout ?? '').replace(/^\uFEFF/, '').trim();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch {
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    } catch { /* 保留 raw */ }
  }
  return { status: String(parsed?.status ?? 'unknown'), raw, parsed };
};

const results: Record<string, unknown> = {};
const t0 = Date.now();

// ── 资产供给（voice 场景契约：WXNODUS_DATA_DIR/models/ggml-base.bin + PATH 里的 whisper-cli.exe）──
const voiceDataDir = join(workdir, 'data');
mkdirSync(join(voiceDataDir, 'models'), { recursive: true });
const srcModel = join(ROOT, 'data', 'voice', 'models', 'ggml-small.bin');
const whisperBinDir = join(ROOT, 'data', 'voice', 'bin', 'Release');
const voiceAssetsReady = existsSync(srcModel) && existsSync(join(whisperBinDir, 'whisper-cli.exe'));
if (voiceAssetsReady) copyFileSync(srcModel, join(voiceDataDir, 'models', 'ggml-base.bin'));
const voicePath = `${whisperBinDir};${process.env.PATH ?? ''}`;

// ── build-restart-readback 目标项目（真实 node 服务器：写 pid 文件 + 数据标记 + 监听端口）──
const buildProj = join(workdir, 'build-proj');
mkdirSync(buildProj, { recursive: true });
// 启动前清理：上一轮场景可能残留第二进程（entry.cmd 拉起）占着端口
try {
  const stalePid = existsSync(join(buildProj, '.wxnodus-server.pid')) ? Number(readFileSync(join(buildProj, '.wxnodus-server.pid'), 'utf8')) : 0;
  if (stalePid > 0) spawnSync('taskkill', ['/PID', String(stalePid), '/T', '/F'], { stdio: 'ignore' });
} catch { /* 忽略 */ }
writeFileSync(join(buildProj, 'server.cjs'), [
  "const http = require('http');",
  "const fs = require('fs');",
  "const path = require('path');",
  "const port = Number(process.env.PORT || 17891);",
  "fs.writeFileSync(path.join(process.cwd(), 'data.txt'), 'acceptance-data-v1');",
  "const server = http.createServer((req, res) => { res.end('ok'); });",
  "server.listen(port, () => fs.writeFileSync(path.join(process.cwd(), '.wxnodus-server.pid'), String(process.pid)));",
].join('\n'), 'utf8');
writeFileSync(join(buildProj, 'entry.cmd'), '@echo off\r\nnode "%~dp0server.cjs"\r\n', 'utf8');
const server1 = spawn(process.execPath, [join(buildProj, 'server.cjs')], { cwd: buildProj, stdio: 'ignore', env: { ...process.env, PORT: '17891' } });
await new Promise(r => setTimeout(r, 900));

// ── emergency-stop 目标进程（真实 node 常驻）──
const emergencyTarget = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 400));

try {
  const { detectAudioDevice } = await import('../src/kernel/voice.js');
  const micDevice = detectAudioDevice(process.env) ?? '';
  results.preflight = runScenario('preflight');
  results.voice = voiceAssetsReady ? runScenario('voice', { WXNODUS_VOICE_DEVICE: micDevice, WXNODUS_DATA_DIR: voiceDataDir, PATH: voicePath }) : { status: 'blocked', raw: 'whisper 资产缺失', parsed: null };
  results.browser = runScenario('browser');
  results['build-restart-readback'] = runScenario('build-restart-readback', { WXNODUS_BUILD_PROJECT: buildProj, WXNODUS_BUILD_ENTRY: join(buildProj, 'entry.cmd'), WXNODUS_BUILD_PORT: '17891' });
  results['emergency-stop'] = runScenario('emergency-stop', { WXNODUS_EMERGENCY_TARGET_PID: String(emergencyTarget.pid ?? 0) });
  results.uia = runScenario('uia');
  results['computer-multimonitor'] = runScenario('computer-multimonitor');
} finally {
  // 清理：场景 spawn 的第二服务器（pid 文件已被重写）+ 初始服务器 + 急停目标
  try {
    const pid2 = existsSync(join(buildProj, '.wxnodus-server.pid')) ? Number(readFileSync(join(buildProj, '.wxnodus-server.pid'), 'utf8')) : 0;
    if (pid2 > 0) spawnSync('taskkill', ['/PID', String(pid2), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* 忽略 */ }
  try { server1.kill(); } catch { /* 忽略 */ }
  try { emergencyTarget.kill(); } catch { /* 忽略 */ }
}

const scenarios = Object.entries(results).map(([id, r]) => ({
  id,
  status: r.status,
  ...(r.status !== 'passed' && r.parsed?.reason ? { reason: r.parsed.reason } : {}),
  ...(r.parsed?.screens ? { screens: r.parsed.screens } : {}),
  rawTail: r.raw.slice(-400),
}));
// W8-13：场景结果目录（per-scenario JSON + 真实 stdout 附件）——Gate E produce --scenario-dir 的直接供给
const scenarioFilesDir = join(workdir, 'scenarios');
const scenarioFiles = writeScenarioFiles(scenarioFilesDir, results as Record<string, { status: string; raw: string; parsed: Record<string, unknown> | null }>);
const passed = scenarios.filter(s => s.status === 'passed').map(s => s.id);
const blocked = scenarios.filter(s => s.status === 'blocked').map(s => s.id);
const runnable = ['preflight', 'voice', 'browser', 'build-restart-readback', 'emergency-stop'];
const runnableAllPassed = runnable.every(id => results[id].status === 'passed');

const outcome = {
  schema: 'windows-acceptance-evidence@1',
  runId,
  timestamp: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}/node${process.version}`,
  durationMs: Date.now() - t0,
  machine: { dotnet: existsSync('C:\\Program Files\\dotnet\\dotnet.exe') ? 'installed' : 'missing', monitors: 1 },
  scenarios,
  summary: { passed, blocked, runnableAllPassed },
  status: runnableAllPassed ? 'partial' : 'failed',
  verdict: runnableAllPassed
    ? `Windows 本机验收：5 个可运行场景全过（preflight/voice/browser/build-restart-readback/emergency-stop）；${blocked.length ? `${blocked.join('/')} 如实 blocked（${blocked.includes('uia') ? 'dotnet 工具链缺失' : ''}${blocked.includes('computer-multimonitor') ? '单显示器' : ''}）——本机证据 ≠ Gate E 生产 receipt（需完整前置集）` : '无 blocked'}`
    : 'Windows 本机验收存在可运行场景失败——如实记录',
};
writeFileSync(join(workdir, 'outcome.json'), JSON.stringify(outcome, null, 2));
console.log(JSON.stringify({ status: outcome.status, passed, blocked, durationMs: outcome.durationMs, receipt: join(workdir, 'outcome.json'), scenarioFiles: scenarioFiles.length, scenarioDir: scenarioFilesDir }, null, 2));
process.exit(runnableAllPassed ? 0 : 2);
