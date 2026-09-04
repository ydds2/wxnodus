import { existsSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rootArg = process.argv.indexOf('--repo-root');
const repoRoot = rootArg === -1 ? workspaceRoot : resolve(process.argv[rootArg + 1]);
const roots = [
  { path: 'tests', required: true },
  { path: 'src', required: true },
  { path: 'packages/vscode-ext', required: false },
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') return [];
    const path = resolve(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function normalized(path) {
  const normalizedPath = relative(repoRoot, path).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

const diskRequiredFiles = [...new Set(roots.flatMap(entry =>
  walk(resolve(repoRoot, entry.path))
    .map(normalized)
    .filter(path => /\.test\.(ts|tsx)$/.test(path))
    .filter(path => !path.startsWith('tests/known-failures/')),
))].sort();
const vitestCli = resolve(workspaceRoot, 'node_modules/vitest/vitest.mjs');
const listed = spawnSync(process.execPath, [
  vitestCli,
  'list',
  '--config', resolve(repoRoot, 'vitest.config.ts'),
  '--filesOnly',
  '--json',
], { cwd: repoRoot, encoding: 'utf8' });

let vitestResolvedFiles = [];
let commandFailed = listed.status !== 0 || Boolean(listed.error);
if (!commandFailed) {
  try {
    const machineList = JSON.parse(listed.stdout);
    if (!Array.isArray(machineList) || machineList.some(row => typeof row?.file !== 'string')) {
      commandFailed = true;
    } else {
      vitestResolvedFiles = [...new Set(machineList.map(row => normalized(resolve(row.file))))].sort();
    }
  } catch {
    commandFailed = true;
  }
}

const required = new Set(diskRequiredFiles);
const resolved = new Set(vitestResolvedFiles);
const missingFiles = diskRequiredFiles.filter(path => !resolved.has(path));
const unexpectedFiles = vitestResolvedFiles.filter(path => !required.has(path));
const excludedRequiredFiles = [...missingFiles];
const missingRequiredRoots = roots
  .filter(entry => entry.required && !diskRequiredFiles.some(path => path.startsWith(`${entry.path}/`)))
  .map(entry => entry.path);
const setMismatch = missingFiles.length > 0 || unexpectedFiles.length > 0 || missingRequiredRoots.length > 0;
const report = {
  roots,
  diskRequiredFiles,
  vitestResolvedFiles,
  missingFiles,
  unexpectedFiles,
  excludedRequiredFiles,
  missingRequiredRoots,
  vitestStderr: commandFailed ? listed.stderr : '',
  errorCode: commandFailed
    ? 'TEST_DISCOVERY_COMMAND_FAILED'
    : setMismatch ? 'TEST_DISCOVERY_SET_MISMATCH' : null,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.errorCode === null ? 0 : 1;
