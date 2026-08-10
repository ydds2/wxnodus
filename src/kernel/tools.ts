// src/kernel/tools.ts — L2-3 工具表（内核工具 + 危险分级）
// 设计：工具 = { schema(OpenAI function calling 格式), danger, run(args, ctx) }
//      危险工具结果包裹 <untrusted_tool_result>（防提示注入——模型把工具输出当指令）
// 参考：Claude Code tools-reference（15 工具）、aider 工具集、Codex function call
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ToolCtx {
  cwd: string;
  dataDir: string;
  ask?: (q: string, opts?: { danger?: boolean }) => Promise<boolean>;
  /** 派生子代理（只读工具集，独立上下文）——delegate 工具真实执行入口 */
  spawnSubagent?: (goal: string) => Promise<{ ok: boolean; output: string; turns: number }>;
  /** 当前轮次的中止信号（F15：bash 等长时工具可被用户 abort 真中断） */
  signal?: AbortSignal;
}

export interface ToolDef {
  schema: {
    type: 'function';
    function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, any>; required?: string[] } };
  };
  danger: boolean;
  run(args: Record<string, any>, ctx: ToolCtx): Promise<string>;
}

export const wrapDanger = (s: string) =>
  // 对比轮 5 修复：defang 内嵌闭标签（hermes 同款）——工具输出含 </untrusted_tool_result> 时
  // 转义为 <\/...>，防止提前闭合包裹边界（提示注入防护）
  `<untrusted_tool_result>\n${s.slice(0, 8000).replace(/<\/untrusted_tool_result>/g, '<\\/untrusted_tool_result>')}\n</untrusted_tool_result>`;

export function coreTools(): Record<string, ToolDef> {
  const fsRead: ToolDef = {
    schema: { type: 'function', function: { name: 'fs_read', description: '读取文件内容', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } } },
    danger: false,
    async run({ path }, ctx) {
      try { return readFileSync(resolve(ctx.cwd, path), 'utf8').slice(0, 20000); }
      catch (e: any) { return `读取失败：${e.message}`; }
    },
  };
  const fsWrite: ToolDef = {
    schema: { type: 'function', function: { name: 'fs_write', description: '写入文件（覆盖）', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    danger: true,
    async run({ path, content }, ctx) {
      try { writeFileSync(resolve(ctx.cwd, path), String(content), 'utf8'); return `已写入 ${path}`; }
      catch (e: any) { return `写入失败：${e.message}`; }
    },
  };
  const fsEdit: ToolDef = {
    schema: { type: 'function', function: { name: 'fs_edit', description: '编辑文件（替换文本）', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] } } },
    danger: true,
    async run({ path, oldText, newText }, ctx) {
      try {
        const p = resolve(ctx.cwd, path);
        const content = readFileSync(p, 'utf8');
        const idx = content.indexOf(String(oldText));
        if (idx < 0) return `未找到要替换的文本：${String(oldText).slice(0, 80)}`;
        writeFileSync(p, content.slice(0, idx) + String(newText) + content.slice(idx + String(oldText).length), 'utf8');
        return `已替换 ${path} 中 1 处`;
      } catch (e: any) { return `编辑失败：${e.message}`; }
    },
  };
  const bash: ToolDef = {
    schema: { type: 'function', function: { name: 'bash', description: '执行 shell 命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    danger: true,
    async run({ command }, ctx) {
      // F15 修复：spawn 异步执行（非 execSync 阻塞）——abort 信号真中断（kill 子进程），60s 兜底超时
      try {
        const cmd = String(command);
        const timeout = AbortSignal.timeout(60000);
        const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
        const child = spawn(
          process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
          process.platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-c', cmd],
          { cwd: ctx.cwd, signal },
        );
        let out = '';
        child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
        await new Promise<void>((resolveP, rejectP) => {
          child.on('error', rejectP);
          child.on('close', (code) => {
            if (ctx.signal?.aborted) return rejectP(new Error('已中断（用户中止）'));
            if (code === 0) return resolveP();
            // 非 0 退出码 → 视为失败（输出附在错误消息中——模型可见且可被失败计数识别）
            return rejectP(new Error(`退出码 ${code}${out.trim() ? `：\n${out.slice(0, 2000)}` : ''}`));
          });
        });
        return wrapDanger(out.slice(0, 8000) || '（无输出）');
      } catch (e: any) {
        return wrapDanger(`命令失败：${e.message?.slice(0, 500)}`);
      }
    },
  };
  const ls: ToolDef = {
    schema: { type: 'function', function: { name: 'ls', description: '列出目录内容', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    danger: false,
    async run({ path = '.' }, ctx) {
      try {
        return readdirSync(resolve(ctx.cwd, path)).map(f => {
          const p = join(resolve(ctx.cwd, path), f);
          try { return statSync(p).isDirectory() ? `${f}/` : f; } catch { return f; }
        }).join('\n');
      } catch (e: any) { return `目录读取失败：${e.message}`; }
    },
  };
  const grep: ToolDef = {
    schema: { type: 'function', function: { name: 'grep', description: '在文件中搜索文本', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
    danger: false,
    async run({ pattern, path = '.' }, ctx) {
      // 修复 F14：execFileSync 参数数组（不经 shell），消除命令注入
      try {
        const out = execFileSync('grep', ['-rn', String(pattern), resolve(ctx.cwd, path)], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
        return out.slice(0, 8000) || '（无匹配）';
      } catch { return '（无匹配）'; }
    },
  };
  const httpGet: ToolDef = {
    schema: { type: 'function', function: { name: 'http_get', description: 'GET 请求（SSRF 防护：内网拦截）', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    danger: false,
    async run({ url }) {
      try {
        const u = new URL(String(url));
        const host = u.hostname;
        const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/.test(host);
        if (isPrivate) return `已拦截：内网地址 ${host}（SSRF 防护）`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        return `HTTP ${resp.status}\n${(await resp.text()).slice(0, 8000)}`;
      } catch (e: any) { return `请求失败：${e.message?.slice(0, 300)}`; }
    },
  };
  const memoryWrite: ToolDef = {
    schema: { type: 'function', function: { name: 'memory_write', description: '写入长期记忆（黑洞引擎 archival）', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
    danger: false,
    async run({ content }, ctx) {
      try { writeFileSync(join(ctx.dataDir, 'memory-notes.md'), String(content) + '\n', { flag: 'a' }); return '已写入记忆'; }
      catch (e: any) { return `记忆写入失败：${e.message}`; }
    },
  };
  const scaffoldBuild: ToolDef = {
    schema: { type: 'function', function: { name: 'scaffold_build', description: '构建可运行项目（概念编译器：规格 → 计划 → 脚手架落地到 data/projects/）', parameters: { type: 'object', properties: { spec: { type: 'string', description: '项目规格 JSON（title/summary/scaffold/acceptance）' } }, required: ['spec'] } } },
    danger: true,
    async run({ spec }, ctx) {
      try {
        const parsed = typeof spec === 'string' ? JSON.parse(spec) : spec;
        if (!parsed?.title || !parsed?.summary) return 'spec 不完整（需要 title/summary）';
        const { makeSpec, validateSpec } = await import('../build/spec.js');
        const { makePlan } = await import('../build/plan.js');
        const { instantiate } = await import('../build/scaffold.js');
        const s = makeSpec(parsed.summary, { key: null });
        if (!validateSpec(s).ok) return `规格校验失败：${validateSpec(s).reason}`;
        const plan = makePlan(parsed.summary, { key: null });
        const dir = join(ctx.dataDir, 'projects', parsed.title);
        const r = instantiate(s, dir, { checkLeftover: false });
        if (!r.ok) return `脚手架失败：${r.reason}`;
        return `项目已生成 → ${dir}\n模块计划：${plan.order.join(' → ')}\n验收：${s.acceptance.join('；')}`;
      } catch (e: any) {
        return `scaffold_build 异常：${e?.message?.slice(0, 300) ?? e}`;
      }
    },
  };
  const delegate: ToolDef = {
    schema: { type: 'function', function: { name: 'delegate', description: '派生子代理执行独立任务（只读工具集，结果返回）', parameters: { type: 'object', properties: { goal: { type: 'string', description: '子代理目标（独立上下文，只读工具）' } }, required: ['goal'] } } },
    danger: true,
    async run({ goal }, ctx) {
      if (!ctx.spawnSubagent) return 'delegate 不可用：当前环境未提供子代理能力';
      try {
        const r = await ctx.spawnSubagent(String(goal ?? '').trim() || '（空任务）');
        const head = r.ok ? '子代理完成' : '子代理未完成';
        return `${head}（${r.turns} 轮）：\n${r.output.slice(0, 4000)}`;
      } catch (e: any) {
        return `子代理执行异常：${e?.message?.slice(0, 300) ?? e}`;
      }
    },
  };
  const askUser: ToolDef = {
    schema: { type: 'function', function: { name: 'ask_user', description: '向用户提问', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } },
    danger: false,
    async run({ question }, ctx) {
      const ok = await ctx.ask?.(String(question), { danger: false });
      return ok ? `用户已确认：${question}` : '用户未确认';
    },
  };
  const skillLoad: ToolDef = {
    schema: { type: 'function', function: { name: 'skill_load', description: '加载本地技能（SKILL.md 工作流）辅助完成任务', parameters: { type: 'object', properties: { name: { type: 'string', description: '技能名（/skill list 查看）' } }, required: ['name'] } } },
    danger: false,
    async run({ name }, ctx) {
      const { skillContentForModel } = await import('./skills.js');
      const content = skillContentForModel(ctx.dataDir, ctx.cwd, String(name ?? ''));
      return content || `未找到技能「${name}」——/skill list 查看已安装技能`;
    },
  };
  return { fs_read: fsRead, fs_write: fsWrite, fs_edit: fsEdit, bash, ls, grep, http_get: httpGet, memory_write: memoryWrite, scaffold_build: scaffoldBuild, delegate, ask_user: askUser, skill_load: skillLoad };
}

export function isDangerous(tools: Record<string, ToolDef>, name: string): boolean {
  return tools[name]?.danger ?? false;
}

// 工具集 → OpenAI tools 数组（模型可见）
export function toolsToOpenAI(tools: Record<string, ToolDef>): unknown[] {
  return Object.values(tools).map(t => t.schema);
}
