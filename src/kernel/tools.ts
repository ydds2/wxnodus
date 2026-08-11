// src/kernel/tools.ts — L2-3 工具表（内核工具 + 危险分级）
// 设计：工具 = { schema(OpenAI function calling 格式), danger, run(args, ctx) }
//      危险工具结果包裹 <untrusted_tool_result>（防提示注入——模型把工具输出当指令）
// 参考：Claude Code tools-reference（15 工具）、aider 工具集、Codex function call
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitizedEnv } from './env.js';

export interface ToolCtx {
  cwd: string;
  dataDir: string;
  /** 数据库（cron_create 等持久化工具；未装配时为 undefined） */
  db?: import('../store/db.js').Db;
  ask?: (q: string, opts?: { danger?: boolean }) => Promise<boolean>;
  /** C6：文字提问（clarify 工具）——返回用户文本答案 */
  clarify?: (q: string, choices?: string[]) => Promise<string>;
  /** 派生子代理（只读工具集，独立上下文）——delegate 工具真实执行入口 */
  spawnSubagent?: (goal: string) => Promise<{ ok: boolean; output: string; turns: number }>;
  /** 当前轮次的中止信号（F15：bash 等长时工具可被用户 abort 真中断） */
  signal?: AbortSignal;
  /** 敏感注入通道（P3 安全）：vault=内存保险库；sudoEnabled/secretEnabled=通道开关（/security 控制） */
  secrets?: { vault: import('./secrets.js').SecretVault; sudoEnabled: boolean; secretEnabled: boolean } | null;
  /** 敏感输入请求（用户亲手输入）：kind=sudo 返回密码；kind=secret 返回密钥值；拒绝/不可用返回 null */
  requestSecret?: (kind: 'sudo' | 'secret', prompt: string, name?: string) => Promise<string | null>;
  /** P1-1：工具失败通知（postToolUseFailure hook） */
  hookFailure?: (name: string, err: string) => void;
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
      try {
        const p = resolve(ctx.cwd, path);
        // 影子快照（/undo fs）：覆盖前备份原内容——文件存在才记录
        if (existsSync(p)) {
          try {
            const { snapshotFile } = await import('./undoShadows.js');
            snapshotFile(ctx.dataDir, p, readFileSync(p, 'utf8'));
          } catch { /* 快照失败不影响写入 */ }
        }
        writeFileSync(p, String(content), 'utf8');
        return `已写入 ${path}`;
      }
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
        // 影子快照（/undo fs）：编辑前备份原内容
        try {
          const { snapshotFile } = await import('./undoShadows.js');
          snapshotFile(ctx.dataDir, p, content);
        } catch { /* 快照失败不影响编辑 */ }
        writeFileSync(p, content.slice(0, idx) + String(newText) + content.slice(idx + String(oldText).length), 'utf8');
        return `已替换 ${path} 中 1 处`;
      } catch (e: any) { return `编辑失败：${e.message}`; }
    },
  };
  // ── P0-3 子进程环境净化（env.ts 统一实现：bash/hooks/MCP 共用）──

  const bash: ToolDef = {
    schema: { type: 'function', function: { name: 'bash', description: '执行 shell 命令', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    danger: true,
    async run({ command }, ctx) {
      // F15 修复：spawn 异步执行（非 execSync 阻塞）——abort 信号真中断（kill 子进程），60s 兜底超时
      try {
        let cmd = String(command);
        // P3 安全注入通道（红线：敏感内容仅用户亲手输入、仅内存、通道关闭即清）：
        //  ① `sudo <命令>` → 经 sudo -S 从 stdin 读密码（不进 argv/ps 列表，子进程无泄露面）
        //  ② `$WXNODUS_SECRET_<NAME>` 占位符 → vault 取值；缺失经 requestSecret 请用户输入后缓存
        let stdinSecret: string | null = null;
        const sudoMatch = cmd.match(/^\s*sudo\s+(.+)$/);
        if (sudoMatch) {
          if (!ctx.secrets?.sudoEnabled) {
            return wrapDanger('检测到 sudo 命令但注入通道未开启——请 /security sudo on 开启（密码仅内存使用，关闭通道即清除）');
          }
          let pwd = ctx.secrets.vault.getSudoPassword();
          if (!pwd) {
            pwd = (await ctx.requestSecret?.('sudo', 'bash 工具需要 sudo 密码（仅本次内存使用，不落盘）')) ?? null;
            if (!pwd) return wrapDanger('sudo 需要密码但输入不可用/已拒绝——请确认交互模式后重试');
            ctx.secrets.vault.setSudoPassword(pwd); // 会话内缓存（通道关闭即清）
          }
          cmd = `sudo -S ${sudoMatch[1]}`;
                    stdinSecret = pwd + String.fromCharCode(10);
        } else {
          const secretRefs = [...cmd.matchAll(/\$WXNODUS_SECRET_([A-Z0-9_]+)/g)].map(x => x[1]);
          if (secretRefs.length) {
            if (!ctx.secrets?.secretEnabled) {
              return wrapDanger('命令包含 $WXNODUS_SECRET_* 占位符但注入通道未开启——请 /security secret on 开启（密钥仅内存使用，关闭通道即清除）');
            }
            for (const name of [...new Set(secretRefs)]) {
              let v = ctx.secrets.vault.getSecret(name);
              if (v === undefined) {
                v = (await ctx.requestSecret?.('secret', `环境变量 ${name} 需要密钥（仅内存使用，不落盘）`, name)) ?? undefined;
                if (v === undefined) return wrapDanger(`缺少密钥 ${name}：输入不可用/已拒绝（/security secret on 开启通道）`);
                ctx.secrets.vault.setSecret(name, v);
              }
              cmd = cmd.split(`$WXNODUS_SECRET_${name}`).join(v);
            }
          }
        }
        const timeout = AbortSignal.timeout(60000);
        const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
        const child = spawn(
          process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
          process.platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-c', cmd],
          { cwd: ctx.cwd, signal, stdio: ['pipe', 'pipe', 'pipe'], env: sanitizedEnv() },
        );
        if (stdinSecret) {
          child.stdin?.write(stdinSecret);
          child.stdin?.end();
        }
        let out = '';
        // C12 修复：流式截断——长输出（如 dir /s）在命令结束前无界累积会撑爆内存
        const appendOut = (d: Buffer) => {
          out += d.toString();
          if (out.length > 20000) out = out.slice(0, 20000); // 保留 8000 截断余量
        };
        child.stdout?.on('data', appendOut);
        child.stderr?.on('data', appendOut);
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
        ctx.hookFailure?.('bash', String(e?.message ?? e).slice(0, 500));
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
    schema: { type: 'function', function: { name: 'http_get', description: 'GET 请求（SSRF 防护：内网/IPv6 私网/DNS 重绑定/重定向逐跳拦截）', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    danger: false,
    async run({ url }) {
      // SSRF 三层防护（src/kernel/ssrf.ts）：主机名形态 + DNS 解析校验 + 重定向逐跳
      const { safeFetchText } = await import('./ssrf.js');
      const r = await safeFetchText(String(url));
      if ('error' in r) return r.error;
      return `HTTP ${r.status}\n${r.text.slice(0, 8000)}`;
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
  // C6 修复（clarify 文字回答）：提问并接收文本答案（参考 clarify 工具同款）——
  // 与 ask_user（布尔确认）互补：模型需要用户提供信息时用 clarify 拿到真实答案
  const clarify: ToolDef = {
    schema: { type: 'function', function: { name: 'clarify', description: '向用户提问并获取文字回答（需要信息时使用，如路径/偏好/选择）', parameters: { type: 'object', properties: { question: { type: 'string', description: '问题' }, choices: { type: 'array', items: { type: 'string' }, description: '可选答案（可为空）' } }, required: ['question'] } } },
    danger: false,
    async run({ question, choices }, ctx) {
      if (!ctx.clarify) return `clarify 不可用：当前环境未提供提问能力（请配置交互环境）`;
      const answer = await ctx.clarify(String(question), Array.isArray(choices) ? choices.map(String) : []);
      return answer ? `用户回答：${answer}` : '用户未回答';
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
  // 对比轮 6：todo 工具（参考 SetTodoList 同款）——待办清单持久化 data/todos.json
  const todo: ToolDef = {
    schema: { type: 'function', function: { name: 'todo', description: '管理待办清单（list/add/done/clear）——长期任务跟踪', parameters: { type: 'object', properties: { action: { type: 'string', description: 'list｜add｜done｜clear' }, item: { type: 'string', description: 'add/done 的待办内容' } }, required: ['action'] } } },
    danger: false,
    async run({ action, item }, ctx) {
      const file = join(ctx.dataDir, 'todos.json');
      let todos: string[] = [];
      try { todos = JSON.parse(readFileSync(file, 'utf8')) as string[]; } catch { /* 空列表 */ }
      const act = String(action ?? 'list').toLowerCase();
      if (act === 'add' && item) {
        todos.push(String(item));
        try { writeFileSync(file, JSON.stringify(todos, null, 2), 'utf8'); } catch (e: any) { return `待办写入失败：${e?.message?.slice(0, 100) ?? e}`; }
        return `已添加待办：${String(item).slice(0, 100)}`;
      }
      if (act === 'done' && item) {
        todos = todos.filter(t => t !== String(item));
        try { writeFileSync(file, JSON.stringify(todos, null, 2), 'utf8'); } catch (e: any) { return `待办写入失败：${e?.message?.slice(0, 100) ?? e}`; }
        return `已完成待办：${String(item).slice(0, 100)}`;
      }
      if (act === 'clear') {
        try { writeFileSync(file, '[]', 'utf8'); } catch (e: any) { return `待办写入失败：${e?.message?.slice(0, 100) ?? e}`; }
        return '待办已清空';
      }
      return todos.length ? `待办清单（${todos.length} 项）：\n${todos.map((t, i) => `${i + 1}. ${t.slice(0, 80)}`).join('\n')}` : '待办为空——todo add <内容> 添加';
    },
  };
  // repo_map：仓库地图（aider repo-map 自研版）——动代码前先看项目结构，减少盲目搜索
  const repoMap: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'repo_map',
        description: '扫描工作区生成仓库地图（函数/类/接口符号索引，按 token 预算截断）。写代码前调用可快速了解项目结构与命名约定，避免盲目搜索。',
        parameters: {
          type: 'object',
          properties: { budgetTokens: { type: 'number', description: '地图预算（token，默认 2000）' } },
        },
      },
    },
    danger: false,
    async run(args) {
      const { buildRepoMap } = await import('./repoMap.js');
      const r = buildRepoMap(process.cwd(), { budgetTokens: Number(args?.budgetTokens) || 2000 });
      return `${r.map}\n（扫描 ${r.scanned} 文件，跳过 ${r.skipped}）`;
    },
  };
  // cron_create：模型自主创建定时任务（Claude Code CronCreate 对齐）——
  // 间隔分钟 + 任务文本，写入 cron_jobs 表由 CLI 调度器每分钟派发
  const cronCreate: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'cron_create',
        description: '创建定时任务：每隔 N 分钟自动执行一个动作（如「检查依赖更新」「生成每日报告」「巡检服务状态」）。返回任务 ID（/cron list 查看，/cron del <ID> 删除）。',
        parameters: {
          type: 'object',
          properties: {
            intervalMinutes: { type: 'number', description: '执行间隔（分钟，≥1 的整数）' },
            action: { type: 'string', description: '到点自动执行的任务文本（中文自然语言即可）' },
          },
          required: ['intervalMinutes', 'action'],
        },
      },
    },
    danger: false,
    async run(args, ctx) {
      const interval = Math.floor(Number(args?.intervalMinutes));
      const action = String(args?.action ?? '').trim();
      if (!Number.isFinite(interval) || interval < 1) return '参数错误：intervalMinutes 需为 ≥1 的整数';
      if (!action) return '参数错误：action 不能为空';
      if (!ctx.db) return '定时任务不可用：数据库未装配（非交互环境）';
      try {
        const r = ctx.db.prepare(`INSERT INTO cron_jobs (schedule, action, last_run, enabled) VALUES (?,?,?,1)`)
          .run(`every ${interval}m`, action, Date.now());
        return `定时任务已创建 #${r.lastInsertRowid}：每 ${interval} 分钟执行「${action.slice(0, 60)}」（/cron list 查看，/cron del ${r.lastInsertRowid} 删除）`;
      } catch (e: any) {
        return `定时任务创建失败：${String(e?.message ?? e).slice(0, 120)}`;
      }
    },
  };
  return { fs_read: fsRead, fs_write: fsWrite, fs_edit: fsEdit, bash, ls, grep, http_get: httpGet, memory_write: memoryWrite, scaffold_build: scaffoldBuild, delegate, ask_user: askUser, clarify, todo, skill_load: skillLoad, repo_map: repoMap, cron_create: cronCreate };
}

export function isDangerous(tools: Record<string, ToolDef>, name: string): boolean {
  return tools[name]?.danger ?? false;
}

// 工具集 → OpenAI tools 数组（模型可见）
export function toolsToOpenAI(tools: Record<string, ToolDef>): unknown[] {
  return Object.values(tools).map(t => t.schema);
}
