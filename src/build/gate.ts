// src/build/gate.ts — L3-1 统一质量门（上线前四门：自测/健康/证据/合规）
// 设计：任何产物必须过门才算完成（合规红线：授权/AI 标注/审计在 L3-3 深度接入）
import { existsSync } from 'node:fs';
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
  ];
  return { gates, pass: gates.every(g => g.ok) };
}
