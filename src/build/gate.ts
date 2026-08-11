// src/build/gate.ts — L3-1 统一质量门（上线前五门：自测/健康/证据/合规/测试）
// 设计：任何产物必须过门才算完成（合规红线：授权/AI 标注/审计在 L3-3 深度接入）
import { existsSync , readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence, complianceCheck } from './evidence.js';

export interface GateCtx { projectDir: string; dataDir: string }
export interface GateResult { gates: Array<{ name: string; ok: boolean; detail: string }>; pass: boolean }

export async function runGate(ctx: GateCtx): Promise<GateResult> {
  const gates = [
    {
      name: '自测门',
      ok: existsSync(join(ctx.projectDir, 'server', 'index.js')) && existsSync(join(ctx.projectDir, 'package.json')),
      detail: '入口与清单存在',
    },
    {
      name: '健康门',
      ok: existsSync(join(ctx.projectDir, 'healthcheck.js')),
      detail: 'healthcheck 脚本存在（真实探活由 verify 引擎执行）',
    },
    {
      name: '证据门',
      ok: readEvidence(ctx.projectDir) !== null,
      detail: 'evidence.json 存在',
    },
    {
      name: '合规门',
      ok: complianceCheck(ctx.projectDir).ok,
      detail: 'README/证据/清单齐全',
    },
    // 测试门（P2 概念编译器增强）：产物声明 test 脚本则真实执行 npm test——
    // 通过才算完成（无测试脚本则跳过并注明，不误判失败）
    await (async () => {
      try {
        const pkgRaw = readFileSync(join(ctx.projectDir, 'package.json'), 'utf8');
        const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
        const testCmd = pkg.scripts?.test;
        if (!testCmd) return { name: '测试门', ok: true, detail: '无 test 脚本（跳过——建议产物含冒烟测试）' };
        const { execFileSync } = await import('node:child_process');
        const t0 = Date.now();
        // Windows 下 .cmd 无法被 execFileSync 直接创建进程（EINVAL），需经 shell 启动
        execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--silent'], {
          cwd: ctx.projectDir, timeout: 120_000, stdio: 'pipe', windowsHide: true,
          shell: process.platform === 'win32',
        });
        return { name: '测试门', ok: true, detail: `npm test 通过（${((Date.now() - t0) / 1000).toFixed(1)}s）` };
      } catch (e: any) {
        return { name: '测试门', ok: false, detail: `npm test 失败：${String(e?.message ?? e).slice(0, 200)}` };
      }
    })(),
  ];
  return { gates, pass: gates.every(g => g.ok) };
}
