// src/kernel/processProbe.ts — 进程存在性/能力探测集中点（W3-11：入口层不直接执行进程）
import { spawnSync } from 'node:child_process';

export function probeProcessAvailable(exe: string, args: string[], timeoutMs = 5000): boolean {
  try {
    return spawnSync(exe, args, { stdio: 'pipe', timeout: timeoutMs, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}
