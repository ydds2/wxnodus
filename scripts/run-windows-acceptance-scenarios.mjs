// scripts/run-windows-acceptance-scenarios.mjs — 真机场景执行驱动（Gate E 场景编排，本机通用档）
// 依次真实执行 tests/acceptance/windows/*.ps1（含 build 场景 harness 流程与 emergency-stop 真实目标进程），
// 结果 JSON + 原始输出附件落入 artifacts/release-evidence/<runId>/scenarios/
// （run-windows-acceptance.mjs --scenario-dir 的输入契约：<dir>/*.json {id,status,attachmentIds} + 附件文件）
// 用法：node scripts/run-windows-acceptance-scenarios.mjs --run <runId> [--tier single-display|full]
//   env：WXNODUS_DATA_DIR（voice 模型目录）、WXNODUS_BUILD_PROJECT（build 场景项目）
// 诚实语义：任一场景真实执行失败/前置缺失 → 该场景记录 blocked（绝不硬编码 passed）
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ACC = join(ROOT, 'tests', 'acceptance', 'windows');
const runId = process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : '';
if (!runId) { console.error('USAGE: node scripts/run-windows-acceptance-scenarios.mjs --run <runId> [--tier single-display]'); process.exit(2); }
const tier = process.argv.includes('--tier') ? process.argv[process.argv.indexOf('--tier') + 1] : 'full';
const outDir = join(ROOT, 'artifacts', 'release-evidence', runId, 'scenarios');
mkdirSync(outDir, { recursive: true });

const ps1 = (file, env = {}, cwd = ACC) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ACC, file)], {
  cwd, env: { ...process.env, WXNODUS_WINDOWS_TIER: tier, ...env }, encoding: 'utf8', timeout: 300000,
});
const record = (id, psResult, extraAttachment = undefined) => {
  const raw = (psResult.stdout ?? '').trim();
  let status = 'blocked'; let detail = {};
  try { detail = JSON.parse(raw); status = detail.status ?? 'blocked'; } catch {}
  // 附件不得以 .json 结尾——loadScenarioResults 会把目录内全部 *.json 当场景结果二次加载
  const attachments = [`${id}.raw.txt`];
  writeFileSync(join(outDir, `${id}.raw.txt`), raw || `{"note":"no output","stderr":${JSON.stringify(psResult.stderr?.slice(0, 500))}}`, 'utf8');
  if (extraAttachment) { writeFileSync(join(outDir, extraAttachment.name), extraAttachment.content, 'utf8'); attachments.push(extraAttachment.name); }
  const result = { id, status, attachmentIds: attachments };
  if (psResult.error) result.error = String(psResult.error);
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(result, null, 2), 'utf8');
  console.log(`[scenario] ${id}: ${status}${result.error ? ` (${result.error})` : ''}`);
  return { result, detail };
};

console.log(`[scenario] tier=${tier} → ${outDir}\n`);

// 1. preflight（真实会话/桌面/OS/DPI/麦克风/SAPI 探测）
record('preflight', ps1('preflight.ps1'));

// 2. computer-multimonitor（single-display 档：单屏真实事实 + PMv2 + 有效 DPI；full 档：负原点矩阵）
record('computer-multimonitor', ps1('computer-multimonitor.ps1'));

// 3. browser（真实 playwright-core：SW 阻断 + 路由先装 + localhost 阻断）
record('browser', ps1('browser.ps1'));

// 4. voice（真实 MMDevice 录音 → WAV 走查 → whisper → SAPI → 第二次运行真实取消）
record('voice', ps1('voice.ps1', {
  WXNODUS_DATA_DIR: process.env.WXNODUS_DATA_DIR ?? join(ROOT, 'data'),
  WXNODUS_VOICE_DEVICE: process.env.WXNODUS_VOICE_DEVICE ?? '麦克风阵列 (Realtek(R) Audio)',
}), undefined);

// 5. build-restart-readback（真实进程树替换 + 端口释放 + 持久化读回）
{
  const proj = process.env.WXNODUS_BUILD_PROJECT;
  if (!proj || !existsSync(join(proj, 'server', 'index.js'))) {
    record('build-restart-readback', { stdout: JSON.stringify({ scenarioId: 'build-restart-readback', status: 'blocked', reason: 'WXNODUS_BUILD_PROJECT missing' }), stderr: '' });
  } else {
    const harness = join(ACC, 'acceptance-build-harness.mjs');
    const port = '45231';
    // 第一实例：harness + 真实 server 进程树（写 pid + 读回标记）
    const first = spawn(process.execPath, [harness], { cwd: proj, env: { ...process.env, WXNODUS_BUILD_PORT: port }, stdio: 'ignore', detached: true });
    await new Promise(r => setTimeout(r, 3000));
    const res = ps1('build-restart-readback.ps1', {
      WXNODUS_BUILD_PROJECT: proj,
      WXNODUS_BUILD_ENTRY: join(ACC, 'acceptance-build-harness.cmd'),
      WXNODUS_BUILD_PORT: port,
    });
    record('build-restart-readback', res);
    // 清理：杀掉场景重启后的第二实例进程树（含 harness + server）
    try { spawnSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { encoding: 'utf8' }); } catch {}
    try {
      const pid2 = readFileSync(join(proj, '.wxnodus-server.pid'), 'utf8').trim();
      if (pid2) spawnSync('taskkill', ['/PID', pid2, '/T', '/F'], { encoding: 'utf8' });
    } catch {}
  }
}

// 6. emergency-stop（真实目标进程树终止）
{
  const target = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const res = ps1('emergency-stop.ps1', { WXNODUS_EMERGENCY_TARGET_PID: String(target.pid) });
  record('emergency-stop', res);
  try { target.kill(); } catch {}
}

// 7. uia（诚实执行：无 runner fixture 驱动会话 → blocked，绝不硬编码）
record('uia', ps1('uia.ps1'));

console.log('\n[scenario] 完成 →', outDir);
process.exit(0);
