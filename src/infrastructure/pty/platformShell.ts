// src/infrastructure/pty/platformShell.ts — 平台默认 shell（计划原文）
export function defaultShellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return env.COMSPEC?.toLowerCase().endsWith('cmd.exe') ? 'powershell.exe' : 'powershell.exe';
  if (platform === 'linux') return env.SHELL || '/bin/bash';
  if (platform === 'darwin') return env.SHELL || '/bin/zsh';
  throw new Error('PTY_UNSUPPORTED_PLATFORM');
}
