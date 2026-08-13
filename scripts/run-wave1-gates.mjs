// scripts/run-wave1-gates.mjs — Wave 1 Gate runner：trusted-kernel 全测 → tests typecheck → build → migration drill
import { spawnSync } from 'node:child_process';
const commands = [
  ['npm.cmd', ['run', 'test:wave1:trusted-kernel']],
  ['npm.cmd', ['run', 'typecheck:tests']],
  ['npm.cmd', ['run', 'build']],
  ['npm.cmd', ['run', 'migration:drill:wave1']],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
