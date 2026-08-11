// src/kernel/scripts.ts — 可执行剧本（开放兼容：会话 → 可重放脚本）
// 剧本 = 用户输入序列 + 每轮工具调用序列（跳过 AI 决策，确定性重放）。
// 录制源：bus 'agent.start'（用户输入）+ 'agent.tool'（工具调用）——
// 重放器（agent.runScript）直接执行固定调用序列，输出可经 AI 总结（有 key 时）。
// 文件：<dataDir>/scripts/<name>.json（本地数据，数据不出机红线）
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ScriptStep {
  /** 该轮用户输入（重放时注入消息流） */
  prompt: string;
  /** 该轮工具调用序列（按序执行，跳过 AI 决策） */
  tools: Array<{ name: string; args: Record<string, any> }>;
  /** 回放断言（回放 CI）：每项为该步工具输出「必须包含」的子串——全部命中才算通过 */
  expect?: string[];
}

export interface Script {
  name: string;
  description: string;
  created_at: number;
  steps: ScriptStep[];
  /** 全局断言：任一工具输出须包含（与 step.expect 合并检查） */
  expect?: string[];
}

const scriptDir = (dataDir: string) => join(dataDir, 'scripts');

const scriptFile = (dataDir: string, name: string) => join(scriptDir(dataDir), `${name}.json`);

const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

export function isValidScriptName(name: string): boolean {
  return NAME_RE.test(name);
}

export function listScripts(dataDir: string): Script[] {
  let entries: string[] = [];
  try { entries = readdirSync(scriptDir(dataDir)); } catch { return []; }
  const out: Script[] = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(scriptDir(dataDir), e), 'utf8')) as Script;
      if (j && typeof j.name === 'string' && Array.isArray(j.steps)) out.push(j);
    } catch { /* 损坏剧本跳过 */ }
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

export function loadScript(dataDir: string, name: string): Script | null {
  if (!NAME_RE.test(name)) return null;
  try {
    const j = JSON.parse(readFileSync(scriptFile(dataDir, name), 'utf8')) as Script;
    return j && Array.isArray(j.steps) ? j : null;
  } catch { return null; }
}

export function saveScript(dataDir: string, script: Script): boolean {
  if (!NAME_RE.test(script.name)) return false;
  try {
    mkdirSync(scriptDir(dataDir), { recursive: true });
    writeFileSync(scriptFile(dataDir, script.name), JSON.stringify(script, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

export function deleteScript(dataDir: string, name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  try {
    if (!existsSync(scriptFile(dataDir, name))) return false;
    rmSync(scriptFile(dataDir, name), { force: true });
    return true;
  } catch { return false; }
}

/** 剧本统计（/script list 展示用） */
export function scriptStats(s: Script): { steps: number; tools: number } {
  return {
    steps: s.steps.length,
    tools: s.steps.reduce((a, st) => a + st.tools.length, 0),
  };
}

/** 剧本断言检查（回放 CI 核心）：step.expect + script.expect 与执行输出比对。
 *  输出为步骤内全部工具输出拼接；断言为「必须包含」子串，全部命中才算通过 */
export function checkScriptExpectations(script: Script, outputs: Array<{ step: number; tool: string; out: string }>): Array<{ ok: boolean; label: string; detail?: string }> {
  const results: Array<{ ok: boolean; label: string; detail?: string }> = [];
  const stepOutputs = new Map<number, string>();
  for (const o of outputs) {
    stepOutputs.set(o.step, (stepOutputs.get(o.step) ?? '') + o.out);
  }
  const allOut = outputs.map(o => o.out).join('\n');
  script.steps.forEach((st, i) => {
    for (const exp of st.expect ?? []) {
      const text = stepOutputs.get(i) ?? '';
      results.push({ ok: text.includes(exp), label: `步骤 ${i + 1} 断言「${exp.slice(0, 40)}」`, detail: text.includes(exp) ? undefined : `输出未包含（实际前 120 字：${text.slice(0, 120).replace(/\n/g, ' ')}）` });
    }
  });
  for (const exp of script.expect ?? []) {
    results.push({ ok: allOut.includes(exp), label: `全局断言「${exp.slice(0, 40)}」`, detail: allOut.includes(exp) ? undefined : '全部输出未包含该子串' });
  }
  return results;
}
