// src/release/buildChain.ts — W8-18：冻结/复验前的显式构建链（clean + build:ink + tsc）
// 实盘缺陷：本仓库 npm pack 不触发 prepack（dist 不重建）→ 冻结器会冻结陈旧 dist、pack 复验恒 trivial。
// 绝不依赖 npm 的 pack 生命周期——凡需要「当前源码的 dist」的环节一律先显式 npm run build。
import { execFileSync } from 'node:child_process';

const npm = (): string => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

export function runBuildChain(repoRoot: string): { ok: true } | { ok: false; error: string } {
  try {
    execFileSync(npm(), ['run', 'build'], {
      cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32',
      timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true };
  } catch (cause) {
    const message = String((cause as { stderr?: unknown; message?: string })?.stderr ?? (cause as Error)?.message ?? cause);
    return { ok: false, error: message.slice(0, 500) };
  }
}
