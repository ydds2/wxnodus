// scripts/lib/evidence.mjs — 证据脚本公共库（sha256/commit/ANSI 剥离/spawn 包装）
// 消除 eval/ime/benchmark 等脚本的重复样板——同一证据同一分数，公共取数公共口径。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（lib 在 scripts/lib/ 下） */
export const repoRoot = () => resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

export const sha256File = p => createHash('sha256').update(readFileSync(p)).digest('hex');

export const gitCommit = (cwd = repoRoot()) =>
  String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout).trim();

/** ANSI 剥离（判分/断言统一口径——控制序列不参与内容判定） */
export const stripAnsi = s =>
  String(s ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

/** spawnSync 包装：{ exit, out, lastLine }——与 eval-report 原 run() 同构 */
export const runCmd = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot(), encoding: 'utf8',
    timeout: opts.timeout ?? 120000,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return { exit: r.status ?? 1, out, lastLine: out.split('\n').filter(l => l.trim()).pop() ?? '' };
};

export const nowIso = () => new Date().toISOString();
