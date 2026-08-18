// scripts/elevated-probe.mjs — 3.2 双态沙盒提权分支实测（supremacy 3.6 收尾证据，2026-08-18）
// 在【管理员】终端运行（先 npm run build；scripts/probe-elevated.cmd 一键封装）。
// 实测内容（全部真实执行，输出落盘 elevated-probe-result.txt 供复算取证）：
//   1) 双态探测（probe force）：OK-ELEVATED（受限令牌构建真实成功）/ OK-STANDARD（本机未提权）
//   2) L0 沙盒写测试：受限令牌 + Low IL 下写文件——预期「拒绝访问」（=只读语义实测）
//   3) L1 沙盒写测试：受限令牌（Medium IL）下写文件——预期成功（=可写+断网语义实测）
// 诚实口径：仅当 PROBE=OK-ELEVATED 且两项写测试符合预期时，⑥ 才复算 9→10。
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeWinSandbox, trySandboxLaunch } from '../dist/kernel/winSandbox.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
const outFile = join(root, 'elevated-probe-result.txt');
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

log(`=== wxnodus 双态沙盒提权实测（${new Date().toLocaleString('zh-CN', { hour12: false })}）===`);
log(`Node ${process.version} · platform ${process.platform} · cwd ${root}`);

// 1) 双态探测（强制重探——跑真实 runner）
const probe = await probeWinSandbox(dataDir, true);
log(`PROBE: ${probe.ok ? 'OK' : 'FAIL'} · ${probe.detail}`);

// 2/3) L0 / L1 沙盒执行实测（探测可用时才执行——不可用则如实记录不编造）
const runProfile = async (profile, label) => {
  const writeCmd = `Set-Content -Path '${join(root, 'sbx-write-test.txt').replace(/'/g, "''")}' -Value 'SBX_WRITE_OK' -ErrorAction SilentlyContinue; if (Test-Path '${join(root, 'sbx-write-test.txt').replace(/'/g, "''")}') { Write-Output 'SBX_WRITE_OK' } else { Write-Output 'SBX_WRITE_DENIED' }`;
  const r = await trySandboxLaunch({
    settings: { sandbox: { profile } },
    dataDir,
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-Command', writeCmd],
    cwd: root,
    timeoutMs: 30_000,
  });
  if (!r.result) { log(`${label}: 未执行（${r.reason ?? '?'}${r.note ? '——' + r.note : ''}）`); return; }
  const out = (() => { try { return readFileSync(r.result.outPath, 'utf8').slice(0, 400); } catch { return ''; } })();
  log(`${label}: exit=${r.result.code} · ${out.trim() || '(无输出)'}`);
};

if (probe.ok) {
  await runProfile('L0', 'L0-WRITE');
  await runProfile('L1', 'L1-WRITE');
} else {
  log('L0/L1 实测跳过（探测不可用——绝不假装沙盒）');
}

writeFileSync(outFile, lines.join('\n'), 'utf8');
log(`=== 结果已保存：${outFile}（贴回 ZCode 会话即可复算）===`);
