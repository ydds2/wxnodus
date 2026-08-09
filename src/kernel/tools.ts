// src/kernel/tools.ts — L2-3 工具表（内核工具 + 危险分级）
// 设计：工具 = { schema(OpenAI function calling 格式), danger, run(args, ctx) }
//      危险工具结果包裹 <untrusted_tool_result>（防提示注入——模型把工具输出当指令）
// 参考：Claude Code tools-reference（15 工具）、aider 工具集、Codex function call
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ToolCtx {
  cwd: string;
  dataDir: string;
  ask?: (q: string, opts?: { danger?: boolean }) => Promise<boolean>;
}

export interface ToolDef {
  schema: {
    type: 'function';
    function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, any>; required?: string[] } };
  };
  danger: boolean;
  run(args: Record<string, any>, ctx: ToolCtx): Promise<string>;
}

const wrapDanger = (s: string) => `<untrusted_tool_result>\n${s.slice(0, 8000)}\n</untrusted_tool_result>`;

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
      try {
        const out = execSync(String(command), { cwd: ctx.cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' ? 'powershell.exe -NoProfile -Command' : '/bin/bash' });
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
      try {
        const out = execSync(`grep -rn "${String(pattern).replace(/"/g, '\\"')}" "${resolve(ctx.cwd, path)}"`, { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
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
    schema: { type: 'function', function: { name: 'scaffold_build', description: '构建可运行项目（概念编译器产物）', parameters: { type: 'object', properties: { spec: { type: 'string', description: '项目规格 JSON' } }, required: ['spec'] } } },
    danger: true,
    async run() { return 'scaffold_build 由 build 模块接管（L3-1）'; },
  };
  const delegate: ToolDef = {
    schema: { type: 'function', function: { name: 'delegate', description: '派生子代理执行独立任务', parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } } },
    danger: true,
    async run() { return 'delegate 由 agent 层接管（L2-4）'; },
  };
  const askUser: ToolDef = {
    schema: { type: 'function', function: { name: 'ask_user', description: '向用户提问', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } },
    danger: false,
    async run({ question }, ctx) {
      const ok = await ctx.ask?.(String(question), { danger: false });
      return ok ? `用户已确认：${question}` : '用户未确认';
    },
  };
  return { fs_read: fsRead, fs_write: fsWrite, fs_edit: fsEdit, bash, ls, grep, http_get: httpGet, memory_write: memoryWrite, scaffold_build: scaffoldBuild, delegate, ask_user: askUser };
}

export function isDangerous(tools: Record<string, ToolDef>, name: string): boolean {
  return tools[name]?.danger ?? false;
}

// 工具集 → OpenAI tools 数组（模型可见）
export function toolsToOpenAI(tools: Record<string, ToolDef>): unknown[] {
  return Object.values(tools).map(t => t.schema);
}
