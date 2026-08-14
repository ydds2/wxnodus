// src/release/gateHRunner.ts — W6-03：Gate H 发行边界离线证据运行器
// 四步真实证据：① pack 复验（tgz sha256 === candidate.tgzSha256）② 干净安装（workspace 外 + 空 HOME/prefix，
// 离线尝试——网络 blocked 如实记录原因，绝不冒充运行证据）③ airgap installer 全生命周期（package-installer →
// PowerShell install/entry 验证/tamper 拒装/-Uninstall 只删 journal 文件）④ 空 HOME+data-dir 运行
// （--version + 确定性计算）。任一步 blocked → 整体 blocked（绝不把部分通过当完整边界证据）。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OperationResult } from '../protocol/results.js';
import { configError } from '../domain/config/configSchema.js';

export interface GateHAttachment { path: string; sha256: string }
export interface GateHStepResult {
  id: 'pack-verify' | 'clean-install' | 'installer-lifecycle' | 'blank-home-run';
  status: 'passed' | 'blocked';
  reason?: string;
  attachments: GateHAttachment[];
}
export interface GateHOutcome {
  gate: 'H';
  runId: string;
  candidateId: string;
  status: 'passed' | 'blocked';
  steps: GateHStepResult[];
  completedAt: string;
}

export interface GateHStepContext {
  candidateFile: string;
  repoRoot: string;
  evidenceDir: string;
  tgzFile: string;
}

export interface GateHStepOverrides {
  packVerify?: (context: GateHStepContext) => Promise<GateHStepResult>;
  cleanInstall?: (context: GateHStepContext) => Promise<GateHStepResult>;
  installerLifecycle?: (context: GateHStepContext) => Promise<GateHStepResult>;
  blankHomeRun?: (context: GateHStepContext) => Promise<GateHStepResult>;
}

export interface RunGateHOptions {
  repoRoot: string;
  evidenceDir: string;
  runId: string;
  candidateFile: string;
  steps?: GateHStepOverrides;
  now?: () => string;
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const npm = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

const writeAttachment = (evidenceDir: string, name: string, content: string): GateHAttachment => {
  const file = join(evidenceDir, 'attachments', name);
  mkdirSync(join(evidenceDir, 'attachments'), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return { path: file, sha256: sha256(readFileSync(file)) };
};

/** ① pack 复验：真实 npm pack 重算 tgz sha256 === candidate.tgzSha256（漂移即 blocked） */
const defaultPackVerify = async (context: GateHStepContext): Promise<GateHStepResult> => {
  try {
    const candidate = JSON.parse(readFileSync(context.candidateFile, 'utf8')) as { tgzSha256: string };
    const stage = join(context.evidenceDir, 'gate-h-pack');
    mkdirSync(stage, { recursive: true });
    const output = execFileSync(npm(), ['pack', '--json', '--pack-destination', stage], {
      cwd: context.repoRoot, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32', timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
    });
    const tgz = join(stage, (JSON.parse(output) as Array<{ filename: string }>)[0]!.filename);
    const actual = sha256(readFileSync(tgz));
    const attachment = writeAttachment(context.evidenceDir, 'pack-verify.log', `expected=${candidate.tgzSha256}\nactual=${actual}\n`);
    if (actual !== candidate.tgzSha256) {
      return { id: 'pack-verify', status: 'blocked', reason: 'pack sha256 drift', attachments: [attachment] };
    }
    return { id: 'pack-verify', status: 'passed', attachments: [attachment] };
  } catch (cause) {
    return { id: 'pack-verify', status: 'blocked', reason: String((cause as Error)?.message ?? cause).slice(0, 300), attachments: [] };
  }
};

/** ② 干净安装（离线尝试）：空 HOME/prefix + npm install <tgz>；registry 不可达如实 blocked */
const defaultCleanInstall = async (context: GateHStepContext): Promise<GateHStepResult> => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const stage = mkdtempSync(join(tmpdir(), 'wxnodus-gateh-install-'));
  try {
    if (!context.tgzFile || !existsSync(context.tgzFile)) {
      return { id: 'clean-install', status: 'blocked', reason: 'frozen tgz missing (run pack:release first)', attachments: [] };
    }
    const prefix = join(stage, 'prefix');
    const home = join(stage, 'home');
    mkdirSync(prefix, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(stage, 'package.json'), '{"name":"gate-h-clean-install","private":true}\n');
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, WXNODUS_NO_DEBUG: '1', MSYS_NO_PATHCONV: '1',
      npm_config_prefix: prefix, npm_config_cache: join(stage, 'npm-cache'),
    };
    let output: string;
    try {
      output = execFileSync(npm(), ['install', '--no-audit', '--no-fund', '--offline', context.tgzFile], {
        cwd: stage, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32', timeout: 900_000, maxBuffer: 64 * 1024 * 1024, env,
      });
    } catch (cause) {
      const message = String((cause as { stderr?: unknown; message?: string })?.stderr ?? (cause as Error)?.message ?? cause);
      // 诚实：离线安装失败（registry/缓存不可达）→ blocked（绝不把失败冒充运行证据）
      return {
        id: 'clean-install', status: 'blocked', reason: `offline install failed: ${message.slice(0, 300)}`,
        attachments: [writeAttachment(context.evidenceDir, 'clean-install.log', message.slice(0, 4000))],
      };
    }
    return { id: 'clean-install', status: 'passed', attachments: [writeAttachment(context.evidenceDir, 'clean-install.log', output.slice(0, 4000))] };
  } catch (cause) {
    return { id: 'clean-install', status: 'blocked', reason: String((cause as Error)?.message ?? cause).slice(0, 300), attachments: [] };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

/** ③ airgap installer 全生命周期：真实 PowerShell install → entry 验证 → tamper 拒装 → -Uninstall 只删 journal 文件 */
const defaultInstallerLifecycle = async (context: GateHStepContext): Promise<GateHStepResult> => {
  const logs: string[] = [];
  const record = (label: string, text: string) => { logs.push(`== ${label} ==\n${text}`); };
  try {
    const { spawnSync } = await import('node:child_process');
    const tsx = join(context.repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const installerScript = join(context.repoRoot, 'scripts', 'package-installer.ts');
    const zipOut = join(context.evidenceDir, 'installer');
    const packedZip = spawnSync(process.execPath, [tsx, installerScript, '--candidate', context.candidateFile, '--name', 'WxNodusGateH', '--version', '3.0.0', '--out', zipOut], {
      cwd: context.repoRoot, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    });
    record('package', `${packedZip.stdout}\n${packedZip.stderr}`);
    if (packedZip.status !== 0) {
      return { id: 'installer-lifecycle', status: 'blocked', reason: 'installer package failed', attachments: [writeAttachment(context.evidenceDir, 'installer-lifecycle.log', logs.join('\n'))] };
    }
    const { readZip } = await import('../application/release/zipArchive.js');
    const zipPath = join(zipOut, 'WxNodusGateH-3.0.0.zip');
    const zip = readZip(readFileSync(zipPath));
    if (!zip.ok) return { id: 'installer-lifecycle', status: 'blocked', reason: 'zip readback failed', attachments: [] };
    const unpackDir = join(context.evidenceDir, 'installer', 'unpacked');
    for (const [path, content] of zip.value) {
      const full = join(unpackDir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const targetDir = join(context.evidenceDir, 'installer', 'installed');
    const runPs = (script: string, args: string[]) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    const installScript = join(unpackDir, 'install.ps1');
    const installed = runPs(installScript, ['-TargetDir', targetDir]);
    record('install', `${installed.stdout}\n${installed.stderr}`);
    if (installed.status !== 0) {
      return { id: 'installer-lifecycle', status: 'blocked', reason: `install failed: ${installed.stderr?.slice(0, 300)}`, attachments: [writeAttachment(context.evidenceDir, 'installer-lifecycle.log', logs.join('\n'))] };
    }
    const entryFile = join(targetDir, 'dist', 'cli', 'index.js');
    if (!existsSync(entryFile)) {
      return { id: 'installer-lifecycle', status: 'blocked', reason: 'entry missing after install', attachments: [writeAttachment(context.evidenceDir, 'installer-lifecycle.log', logs.join('\n'))] };
    }
    // tamper 拒装：篡改安装包内文件 → 重跑 install 必须 INSTALLER_SHA256_MISMATCH exit 1
    writeFileSync(join(unpackDir, 'dist', 'cli', 'index.js'), 'evil', 'utf8');
    const tampered = runPs(installScript, ['-TargetDir', join(context.evidenceDir, 'installer', 'tampered-target')]);
    record('tamper-reject', `${tampered.stdout}\n${tampered.stderr}`);
    if (tampered.status !== 1 || !`${tampered.stderr}`.includes('INSTALLER_SHA256_MISMATCH')) {
      return { id: 'installer-lifecycle', status: 'blocked', reason: 'tampered install not rejected', attachments: [writeAttachment(context.evidenceDir, 'installer-lifecycle.log', logs.join('\n'))] };
    }
    // -Uninstall 只删 journal 内文件
    const uninstalled = runPs(installScript, ['-TargetDir', targetDir, '-Uninstall']);
    record('uninstall', `${uninstalled.stdout}\n${uninstalled.stderr}`);
    if (uninstalled.status !== 0 || existsSync(join(targetDir, 'dist'))) {
      return { id: 'installer-lifecycle', status: 'blocked', reason: 'uninstall left owned files', attachments: [writeAttachment(context.evidenceDir, 'installer-lifecycle.log', logs.join('\n'))] };
    }
    return {
      id: 'installer-lifecycle', status: 'passed',
      attachments: [writeAttachment(context.evidenceDir, 'installer-lifecycle.log', logs.join('\n'))],
    };
  } catch (cause) {
    return { id: 'installer-lifecycle', status: 'blocked', reason: String((cause as Error)?.message ?? cause).slice(0, 300), attachments: [] };
  }
};

/** ④ 空 HOME+data-dir 运行：--version + 确定性计算（workspace 外，隔离环境） */
const defaultBlankHomeRun = async (context: GateHStepContext): Promise<GateHStepResult> => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const stage = mkdtempSync(join(tmpdir(), 'wxnodus-gateh-run-'));
  try {
    const home = join(stage, 'home');
    const dataDir = join(stage, 'data');
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, WXNODUS_DATA_DIR: dataDir, WXNODUS_NO_DEBUG: '1', MSYS_NO_PATHCONV: '1' };
    const bin = join(context.repoRoot, 'dist', 'cli', 'index.js');
    const version = execFileSync('node', [bin, '--version'], { cwd: stage, encoding: 'utf8', stdio: 'pipe', shell: false, timeout: 60_000, env }).trim();
    const calc = execFileSync('node', [bin, '-p', '算一下 2+3*4'], { cwd: stage, encoding: 'utf8', stdio: 'pipe', shell: false, timeout: 120_000, env }).trim();
    const attachment = writeAttachment(context.evidenceDir, 'blank-home-run.log', `version=${version}\ncalc=${calc}\n`);
    if (!/^wxnodus \d+\.\d+\.\d+$/.test(version) || !calc.includes('14')) {
      return { id: 'blank-home-run', status: 'blocked', reason: 'blank HOME run failed', attachments: [attachment] };
    }
    return { id: 'blank-home-run', status: 'passed', attachments: [attachment] };
  } catch (cause) {
    return { id: 'blank-home-run', status: 'blocked', reason: String((cause as Error)?.message ?? cause).slice(0, 300), attachments: [] };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

export async function runGateH(options: RunGateHOptions): Promise<OperationResult<GateHOutcome>> {
  const { evidenceDir, runId, candidateFile, repoRoot } = options;
  let candidate: { candidateId: string; tgzSha256: string };
  try {
    candidate = JSON.parse(readFileSync(candidateFile, 'utf8')) as { candidateId: string; tgzSha256: string };
  } catch {
    return { ok: false, error: configError('GATE_H_CANDIDATE_MISSING', 'gateH.candidate.missing', { candidateFile }) };
  }
  if (!/^[a-f0-9]{64}$/.test(candidate.tgzSha256) || typeof candidate.candidateId !== 'string') {
    return { ok: false, error: configError('GATE_H_CANDIDATE_INVALID', 'gateH.candidate.invalid') };
  }
  const tgzFile = readdirSync(dirname(candidateFile)).map(name => join(dirname(candidateFile), name)).find(file => file.endsWith('.tgz')) ?? '';
  mkdirSync(evidenceDir, { recursive: true });
  const context: GateHStepContext = { candidateFile, repoRoot, evidenceDir, tgzFile };
  const steps: GateHStepResult[] = [];
  steps.push(await (options.steps?.packVerify ?? defaultPackVerify)(context));
  steps.push(await (options.steps?.cleanInstall ?? defaultCleanInstall)(context));
  steps.push(await (options.steps?.installerLifecycle ?? defaultInstallerLifecycle)(context));
  steps.push(await (options.steps?.blankHomeRun ?? defaultBlankHomeRun)(context));
  const outcome: GateHOutcome = {
    gate: 'H', runId, candidateId: candidate.candidateId,
    status: steps.every(step => step.status === 'passed') ? 'passed' : 'blocked',
    steps, completedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  const body = `${JSON.stringify(outcome, null, 2)}\n`;
  const target = join(evidenceDir, 'outcome.json');
  writeFileSync(`${target}.tmp`, body, 'utf8');
  renameSync(`${target}.tmp`, target);
  return { ok: true, value: outcome };
}
