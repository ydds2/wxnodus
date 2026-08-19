// src/build/generate.ts — Spec v2 逐模块生成引擎（2026-08-19 复杂需求构造能力）
// 动机：模具模板只有 5 种固定形态——跨域/多子系统需求全部坍缩进单模板，无法支撑大型项目。
// 设计（有界多轮生成——突破单次 LLM 输出的构造上限）：
//   规格分解（Spec.modules DAG）→ 拓扑序逐模块一次 LLM 调用生成该模块全部文件
//   → 路径白名单/尺寸上限/入口契约三重校验 → 落盘 → 下一模块携带已生成模块上下文。
// 诚实边界：生成失败（网络/解析/校验/入口缺失）如实报错，绝不伪造文件或静默降级回模板。
// 路径安全：生成路径必须命中白名单正则（相对、无 ..、无绝对）——LLM 输出不可信，逐文件校验。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Spec, SpecModule } from './spec.js';
import type { BuildPlan } from './plan.js';
import { checkLeftover } from './scaffold.js';

export interface GenerateDeps { baseURL: string; model: string; key: string }

export interface GeneratedFile { path: string; content: string }

export interface GenerateProjectResult { ok: boolean; reason?: string; files?: GeneratedFile[]; moduleCount?: number }

// ── 生成输出三重校验（纯函数——单测直接覆盖）────────────────────────

const FILE_PATH_RE = /^[a-z0-9][a-z0-9-_]*(\/[a-z0-9][a-z0-9-_]*)*\.[a-z0-9]{1,10}$/;
const MAX_FILES = 12;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 192 * 1024;

export function validateGeneratedFiles(files: unknown): { ok: true; files: GeneratedFile[] } | { ok: false; error: string } {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, error: '生成输出缺 files 数组' };
  if (files.length > MAX_FILES) return { ok: false, error: `文件数 ${files.length} 超上限 ${MAX_FILES}` };
  const out: GeneratedFile[] = [];
  let total = 0;
  for (const f of files) {
    const path = String((f as any)?.path ?? '').trim();
    const content = String((f as any)?.content ?? '');
    if (!FILE_PATH_RE.test(path)) return { ok: false, error: `路径非法：${path || '(空)'}（相对路径，禁止 .. 与绝对路径）` };
    if (out.some(o => o.path === path)) return { ok: false, error: `路径重复：${path}` };
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) return { ok: false, error: `文件超限：${path}（${bytes}B > ${MAX_FILE_BYTES}B）` };
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: `模块总输出超限（>${MAX_TOTAL_BYTES}B）` };
    out.push({ path, content });
  }
  return { ok: true, files: out };
}

// ── 逐模块生成 ─────────────────────────────────────────────────────

const GENERATE_SYSTEM = `你是 WxNodus 的代码生成器。给定总规格、本模块职责与文件清单、以及已生成模块的文件路径列表，输出本模块全部文件的完整代码。
严格只输出 JSON：{"files":[{"path":"相对路径","content":"文件完整内容"}]}
约束：
- path 使用小写字母/数字/-/_，相对路径，禁止 .. 与绝对路径；每个文件 content 是完整可运行代码（不含省略号/伪代码）
- 模块间互连用相对 require（已生成模块文件路径会提供；入口模块写 server/index.js 时只依赖 node:http 等内置模块）
- 服务端用 Node 内置模块（node:http/node:fs 等），不引入需要 npm install 的依赖
- 含入口 server/index.js 的模块：server 监听 PORT 环境变量（缺省 4321），提供 GET /api/health 返回 {"ok":true}
- 代码注释可用中文，但代码本身必须语法正确`;

/** 单模块生成：一次 LLM 调用 → JSON 文件批 → 三重校验 */
export async function generateModule(
  spec: Spec,
  module: SpecModule,
  priorModules: string[],
  deps: GenerateDeps
): Promise<{ ok: true; files: GeneratedFile[] } | { ok: false; error: string }> {
  const { callModelOnce, extractJson } = await import('../kernel/llmOnce.js');
  const prior = priorModules.length
    ? `已生成模块与文件（用相对 require 引用它们的接口）：\n${priorModules.join('\n')}`
    : '这是第一个模块（依赖为零或依赖尚未生成的模块可自行提供降级）。';
  const user = `总规格：${spec.title}——${spec.summary}
验收：${spec.acceptance.join('；')}
本模块：${module.name}——${module.desc}
产出文件清单：
${module.files.map(f => `- ${f.path}：${f.desc}`).join('\n')}
${prior}`;
  const r = await callModelOnce({
    baseURL: deps.baseURL,
    model: deps.model,
    key: deps.key,
    messages: [
      { role: 'system', content: GENERATE_SYSTEM },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    responseFormat: 'json_object',
  });
  if (!r.ok) return { ok: false, error: r.error };
  const parsed = extractJson(r.content);
  if (!parsed) return { ok: false, error: '生成输出 JSON 解析失败' };
  const validated = validateGeneratedFiles(parsed.files);
  if (!validated.ok) return { ok: false, error: validated.error };
  return { ok: true, files: validated.files };
}

/** 全项目生成：拓扑序逐模块 → 落盘 → 入口契约 → 项目脚手架文件（healthcheck/package/plan/README） */
export async function generateProject(input: {
  spec: Spec;
  plan: BuildPlan;
  projectDir: string;
  deps: GenerateDeps;
  progress?: (stage: string) => void;
}): Promise<GenerateProjectResult> {
  const { spec, plan, projectDir, deps, progress } = input;
  const order = plan.order.length ? plan.order : spec.modules!.map(m => m.name);
  const byName = new Map(spec.modules!.map(m => [m.name, m]));
  const allFiles: GeneratedFile[] = [];
  const prior: string[] = [];
  const notice = (stage: string) => { try { progress?.(stage); } catch { /* 进度失败不阻断 */ } };
  try {
    for (let i = 0; i < order.length; i++) {
      const mod = byName.get(order[i]!);
      if (!mod) return { ok: false, reason: `计划含未知模块：${order[i]}` };
      notice(`生成模块 ${mod.name}（${i + 1}/${order.length}）`);
      const r = await generateModule(spec, mod, prior, deps);
      if (!r.ok) return { ok: false, reason: `模块 ${mod.name} 生成失败：${r.error}` };
      for (const f of r.files) {
        const abs = join(projectDir, f.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content, 'utf8');
      }
      allFiles.push(...r.files);
      prior.push(`${mod.name}/：${r.files.map(f => f.path).join('、')}`);
    }
  } catch (e: any) {
    return { ok: false, reason: `生成落盘失败：${String(e?.message ?? e)}` };
  }

  // 入口契约：verifyProject 探活依赖 server/index.js + healthcheck.js——缺失如实失败（绝不假交付）
  if (!existsSync(join(projectDir, 'server', 'index.js'))) {
    return { ok: false, reason: '生成结果缺入口 server/index.js（启动契约不满足——AI 分解未产出可运行入口）', files: allFiles, moduleCount: order.length };
  }
  // 项目脚手架文件（与模具路径同一形态——healthcheck 探活、npm test 冒烟、plan 落盘）
  writeFileSync(join(projectDir, 'healthcheck.js'), `// healthcheck：启动→探活→读回\nconst http = require('node:http');\nhttp.get('http://127.0.0.1:' + (process.env.PORT || 4321) + '/api/health', r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ console.log(b); process.exit(r.statusCode===200?0:1); }); }).on('error', () => process.exit(1));\n`, 'utf8');
  const pkg = JSON.stringify({
    name: `wxnodus-gen-${spec.title.slice(0, 20).replace(/[^\w-]+/g, '-').toLowerCase() || 'app'}`,
    version: '1.0.0',
    description: spec.summary.slice(0, 100),
    scripts: { start: 'node server/index.js', test: 'node --test server/*.test.js' },
  }, null, 2);
  writeFileSync(join(projectDir, 'package.json'), pkg + '\n', 'utf8');
  writeFileSync(join(projectDir, 'plan.json'), JSON.stringify({ modules: plan.modules, order, generated: 'Spec v2 逐模块生成' }, null, 2), 'utf8');
  writeFileSync(join(projectDir, 'README.md'), `# ${spec.title}\n\n${spec.summary}\n\n## 模块\n${order.map((m, i) => `${i + 1}. ${m} — ${byName.get(m)?.desc ?? ''}`).join('\n')}\n\n## 验收\n${spec.acceptance.map(a => `- ${a}`).join('\n')}\n\n## 启动\n- \`npm start\`（node:http 零依赖）\n- \`npm test\`（node:test 冒烟）\n`, 'utf8');
  if (!checkLeftover(projectDir)) return { ok: false, reason: '残留槽位（LEFTOVER）未替换', files: allFiles, moduleCount: order.length };
  return { ok: true, files: allFiles, moduleCount: order.length };
}
