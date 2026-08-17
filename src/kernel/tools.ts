// src/kernel/tools.ts — L2-3 工具表（内核工具 + 危险分级）
// 设计：工具 = { schema(OpenAI function calling 格式), danger, run(args, ctx) }
//      危险工具结果包裹 <untrusted_tool_result>（防提示注入——模型把工具输出当指令）
// 参考：Claude Code tools-reference（15 工具）、aider 工具集、Codex function call
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { sanitizedEnv } from './env.js';
import { probeProcessAvailable } from './processProbe.js';
import { labelTruncate, capNote } from './truncate.js';
import { UNTRUSTED_WRAP_LIMIT_DEFAULT, clampInt } from './toolOutput.js';

/** A25：grep 存在性探测（Windows 默认无 grep——缺失时工具诚实报错而非假阴性）
 * W3-11：进程探测集中到 kernel/processProbe（入口层不直接执行进程） */
let grepChecked: boolean | null = null;
function hasGrep(): boolean {
  if (grepChecked !== null) return grepChecked;
  grepChecked = probeProcessAvailable('grep', ['--version'], 5000);
  return grepChecked;
}

/** fs_edit 多处出现反馈的行号换算（O(n + k·log n)；纯函数可单测）
 * 原 `positions.map(i => content.slice(0, i).split('\n').length)` 为 O(k×n)——大文件多处出现时明显卡顿 */
export function lineNumbersOf(content: string, indexes: number[]): number[] {
  const starts: number[] = [0];
  for (let j = 0; j < content.length; j++) {
    if (content.charCodeAt(j) === 10) starts.push(j + 1);
  }
  const lineOf = (i: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= i) lo = mid; else hi = mid - 1;
    }
    return lo + 1; // 1-based
  };
  return indexes.map(lineOf);
}

// ── 授权存证（审查接线：ConsentLedger 此前零实例化）──
// 外部访问（http_get/browser_navigate）成功时自动留痕：scope=目标 host、method=工具名、
// grantor=system（系统代记）；显式授权走 /consent grant。/consent list 可查全簿。
const consentLedgers = new WeakMap<object, any>();
async function recordConsent(db: any, scope: string, method: string): Promise<void> {
  try {
    if (!db) return;
    let ledger = consentLedgers.get(db);
    if (!ledger) {
      const { ConsentLedger } = await import('../compliance/compliance.js');
      ledger = new ConsentLedger(db);
      consentLedgers.set(db, ledger);
    }
    ledger.grant({ grantor: 'system', scope, purpose: `工具 ${method} 外部访问`, method, expiresAt: 0, evidenceRef: '' });
  } catch { /* 存证失败静默（不阻断访问） */ }
}
function hostOf(url: string): string {
  try { return new URL(String(url ?? '')).host || String(url ?? '').slice(0, 80); } catch { return String(url ?? '').slice(0, 80); }
}

export interface ToolCtx {
  cwd: string;
  dataDir: string;
  /** W3 Memory：可信会话 id（agent 内部状态注入——memory_* 工具的 scope 唯一来源，参数不可伪造） */
  sessionId?: string;
  /** 数据库（cron_create 等持久化工具；未装配时为 undefined） */
  db?: import('../store/db.js').Db;
  /** 事件总线（notify 等通知工具；未装配时为 undefined） */
  bus?: import('./events.js').EventBus;
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
  /** 动态内容表（多字段敏感输入）：CLI 弹表单，用户逐字段输入；值仅内存；取消/不可用返回 null */
  requestForm?: (fields: Array<{ name: string; label?: string; kind: 'text' | 'password' | 'key' }>, prompt?: string) => Promise<Record<string, string> | null>;
  /** P1-1：工具失败通知（postToolUseFailure hook） */
  hookFailure?: (name: string, err: string) => void;
  /** 开放通道 settings（视觉端点/本地开关等）——agent 装配时提供，缺省 undefined */
  getSettings?: () => Record<string, any> | undefined;
  /** AI 自主调用通道（wx_cmd 工具）：执行斜杠命令并返回文本输出（cli 装配 bus.execute 包装） */
  runCommand?: (input: string) => Promise<string>;
}

export interface ToolDef {
  schema: {
    type: 'function';
    function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, any>; required?: string[] } };
  };
  danger: boolean;
  /** 演示工具标记（插件脚手架）：对模型隐藏（不注入 schema、不可调用）——见 agent.ts 过滤 */
  demo?: boolean;
  run(args: Record<string, any>, ctx: ToolCtx): Promise<string>;
}

export const wrapDanger = (s: string, limit: number = UNTRUSTED_WRAP_LIMIT_DEFAULT) =>
  // 对比轮 5 修复：defang 内嵌闭标签（hermes 同款）——工具输出含 </untrusted_tool_result> 时
  // 转义为 <\/...>，防止提前闭合包裹边界（提示注入防护）
  // gap 硬编码修复（2026-08-18）：8000 不再写死——settings.untrustedWrapLimit 可调，
  // 超限走 offload 落盘（agent.executeTool 装配），此处 limit 仅作包裹面护栏
  `<untrusted_tool_result>\n${s.slice(0, limit).replace(/<\/untrusted_tool_result>/g, '<\\/untrusted_tool_result>')}\n</untrusted_tool_result>`;

// 工具调用最小间隔（纯函数可单测）：返回需等待的毫秒数（0 = 无需等待）——
// 防模型连发搜索/抓取触发引擎 429 或封禁的自保护护栏
export function minIntervalSince(lastTs: number, minMs: number, now: number = Date.now()): number {
  return Math.max(0, minMs - (now - lastTs));
}
let lastSearchTs = 0;
let lastHttpGetTs = 0;

export function coreTools(): Record<string, ToolDef> {
  // 安全审查修复：fs_read 工作区边界——realpath 校验目标必须在 cwd 内（拒绝 ../ 逃逸与
  // 任意系统文件路径被静默读进模型上下文；fs_read 是 danger:false 无确认的）。
  // 写路径不设此守卫：fs_write/fs_edit 走审批链（工作区外弹审批、批准即生效——既有契约），
  // 凭据/配置类文件由 SENSITIVE_WRITE 硬红线兜底（permissions.ts）
  const withinWorkspace = (cwd: string, p: string): string | null => {
    try {
      const root = realpathSync(cwd);
      const target = realpathSync(p);
      const rel = relative(root, target);
      if (rel === '..' || rel.startsWith(`..${sep}`)) return `路径超出工作区：${target}`;
      if (/^[a-zA-Z]:/.test(rel)) return `路径超出工作区：${target}`; // Windows 跨盘
      return null;
    } catch {
      // realpath 失败（目标不存在——写入场景）——回退 resolve 相对校验
      const rootAbs = resolve(cwd);
      const abs = resolve(p);
      const rel2 = relative(rootAbs, abs);
      if (rel2 === '..' || rel2.startsWith(`..${sep}`)) return `路径超出工作区：${abs}`;
      if (/^[a-zA-Z]:/.test(rel2)) return `路径超出工作区：${abs}`;
      return null;
    }
  };

  const fsRead: ToolDef = {
    schema: { type: 'function', function: { name: 'fs_read', description: '读取文件内容（可按行分页：offset 起始行 / limit 行数——超长文件用分页续读，勿一次性读全部）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径（工作区内）' }, offset: { type: 'number', description: '起始行（从 0 开始，缺省 0）' }, limit: { type: 'number', description: '读取行数（缺省读全文，最多 20000 字）' } }, required: ['path'] } } },
    danger: false,
    async run({ path, offset, limit }, ctx) {
      try {
        const p = resolve(ctx.cwd, path);
        const guard = withinWorkspace(ctx.cwd, p);
        if (guard) return guard;
        const full = readFileSync(p, 'utf8');
        // 分页模式（offset/limit 任一提供）：按行切片——截断文件可精确续读
        const wantPage = offset != null || limit != null;
        if (wantPage) {
          const lines = full.split('\n');
          const start = Math.max(0, Math.floor(Number(offset) || 0));
          const end = limit != null && Number(limit) > 0 ? start + Math.floor(Number(limit)) : undefined;
          const page = lines.slice(start, end);
          const pageText = page.join('\n');
          return `${pageText}${end != null && end < lines.length ? `\n…[共 ${lines.length} 行，已读第 ${start}-${end - 1} 行——offset=${end} 续读]` : ''}`;
        }
        // 诚实截断：超长文件只给头部 N 字并显式标注——模型知道后面还有内容
        // （避免「读完整文件」假象；续读用 offset 分页或 bash tail）
        // gap 深化（2026-08-18）：N 不再写死 20000——settings.fsReadLimit（2k..1M 夹取）
        const fsLimit = clampInt(ctx.getSettings?.()?.fsReadLimit, 20000, 2000, 1_000_000);
        return full.length > fsLimit
          ? `${full.slice(0, fsLimit)}\n…[文件过长已截断（共 ${full.length} 字，剩余 ${full.length - fsLimit} 字未读）——用 offset/limit 分页或 bash tail/sed 续看]`
          : full;
      }
      catch (e: any) { return `读取失败：${e.message}`; }
    },
  };
  const fsWrite: ToolDef = {
    schema: { type: 'function', function: { name: 'fs_write', description: '写入文件（整体覆盖——path 已有内容会被完全替换）。新建文件或整体重写时用本工具；只改文件局部用 fs_edit（更安全）。不确定当前内容先 fs_read。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径（工作区内）' }, content: { type: 'string', description: '完整新内容（覆盖旧内容）' } }, required: ['path', 'content'] } } },
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
    schema: { type: 'function', function: { name: 'fs_edit', description: '编辑文件（替换文本）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径（工作区内）' }, oldText: { type: 'string', description: '要替换的原文（需与文件内容完全一致且唯一）' }, newText: { type: 'string', description: '替换后的新文本' } }, required: ['path', 'oldText', 'newText'] } } },
    danger: true,
    async run({ path, oldText, newText }, ctx) {
      try {
        const p = resolve(ctx.cwd, path);
        const content = readFileSync(p, 'utf8');
        const needle = String(oldText);
        // 审查修复（P2）：空 oldText 使 indexOf('') 恒 0 且 from 不前进——无限循环 OOM 挂死
        if (!needle) return 'oldText 不能为空（模型输出不规范——用 fs_write 整文件重写或重试）';
        // 深度：唯一性校验（Aider SearchReplace 对齐）——出现多处时反馈位置列表，
        // 模型据此精化 oldText（避免替换错位置）；缺省只替换第一处并注明
        const positions: number[] = [];
        let from = 0;
        while (true) {
          const i = content.indexOf(needle, from);
          if (i < 0) break;
          positions.push(i);
          from = i + needle.length;
        }
        if (!positions.length) {
          // 失败反馈带上下文（模型可据此修正 oldText）
          const ctxStart = Math.max(0, content.indexOf(needle.slice(0, 20)) - 30);
          return `未找到要替换的文本：${needle.slice(0, 60)}${ctxStart >= 0 ? `\n附近内容：…${content.slice(ctxStart, ctxStart + 80).replace(/\n/g, ' ')}…` : ''}`;
        }
        if (positions.length > 1) {
          return `「${needle.slice(0, 40)}」出现 ${positions.length} 处（行 ${lineNumbersOf(content, positions).join('、')}）——oldText 需更精确（包含更多上下文）或指定唯一片段`;
        }
        // 影子快照（/undo fs）：编辑前备份原内容
        try {
          const { snapshotFile } = await import('./undoShadows.js');
          snapshotFile(ctx.dataDir, p, content);
        } catch { /* 快照失败不影响编辑 */ }
        const idx = positions[0]!;
        writeFileSync(p, content.slice(0, idx) + String(newText) + content.slice(idx + needle.length), 'utf8');
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
        // gap P0-4/P0-1 落地（2026-08-18）：
        // ① OS 内核沙盒（winSandbox）：settings.sandbox.profile 开启时命令经
        //    受限令牌 + Job Object + 断网限速执行；探测失败/非 Windows → 诚实提示后
        //    按普通方式执行（绝不把未沙盒当沙盒）
        // ② 流式落盘：完整输出写 truncations/tmp（内存封顶 20000 字防 OOM），
        //    超限时接管为正式 offload 文件——预览 + 续读路径（不再丢尾）
        const sSettings = ctx.getSettings?.() as Record<string, any> | undefined;
        const { trySandboxLaunch, resolveSandboxProfile } = await import('./winSandbox.js');
        const sandboxProfile = resolveSandboxProfile(sSettings);
        const sandbox = await trySandboxLaunch({
          settings: sSettings,
          dataDir: ctx.dataDir,
          cmd: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
          args: process.platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-c', cmd],
          cwd: ctx.cwd,
          stdin: stdinSecret ?? undefined,
          timeoutMs: 60_000,
          signal: ctx.signal,
        });
        if (sandbox.note) ctx.bus?.emit?.('system.notice', { text: sandbox.note });
        let out = '';
        let truncated = false;
        let fullPath: string | null = null; // 完整输出落盘路径（接管为 offload 用）
        let exitCode: number | null = null;
        // gap 深化（2026-08-18）：内存封顶不再写死 20000——settings.bashOutputCap（2k..1M 夹取）
        const outCap = clampInt(sSettings?.bashOutputCap, 20000, 2000, 1_000_000);
        if (sandbox.result) {
          // 沙盒路径：输出由助手落盘文件（受限子进程 stdout/stderr 重定向），
          // 头尾有界读取进内存；超限文件接管为正式 offload
          const { readHeadTail, promoteOffloadFile } = await import('./toolOutput.js');
          const { readFileSync: rf, appendFileSync, rmSync } = await import('node:fs');
          const outHt = readHeadTail(sandbox.result.outPath, outCap, 0);
          const errHt = readHeadTail(sandbox.result.errPath, 2_000, 0);
          const outText = outHt?.head ?? '';
          const errText = errHt?.head ?? '';
          out = `${outText}${errText ? `${outText ? '\n' : ''}${errText}` : ''}`;
          const outOver = (outHt?.total ?? 0) > outText.length;
          const errOver = (errHt?.total ?? 0) > errText.length;
          truncated = outOver || errOver;
          exitCode = sandbox.result.code;
          if (truncated) {
            try {
              if (errOver) appendFileSync(sandbox.result.outPath, rf(sandbox.result.errPath).slice(0, 1_000_000));
              const promoted = promoteOffloadFile({ srcPath: sandbox.result.outPath, tool: 'bash', dataDir: ctx.dataDir, sessionId: ctx.sessionId });
              fullPath = promoted?.path ?? null;
              if (!promoted) fullPath = null;
            } catch {
              fullPath = null;
              try { rmSync(sandbox.result.outPath, { force: true }); } catch { /* 清理失败静默 */ }
            }
            try { rmSync(sandbox.result.errPath, { force: true }); } catch { /* 清理失败静默 */ }
          } else {
            try { rmSync(sandbox.result.outPath, { force: true }); rmSync(sandbox.result.errPath, { force: true }); } catch { /* 清理失败静默 */ }
          }
          ctx.bus?.emit?.('system.notice', { text: `命令已在 OS 沙盒内执行（${sandboxProfile}）——受限令牌 + Job 遏制${sandboxProfile === 'L0' || sandboxProfile === 'L1' ? ' + 断网' : sandboxProfile === 'L2' ? ' + 限速 10KB/s' : ''}${sandboxProfile === 'L0' ? ' + 只读' : ''}` });
        } else {
          // 普通路径（沙盒未开启/不适用）：spawn + 流式落盘（sink 保证完整输出可续读）
          const timeout = AbortSignal.timeout(60000);
          const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
          let sinkPath: string | null = null;
          let sinkFd: number | null = null;
          try {
            const { mkdirSync, openSync } = await import('node:fs');
            const tmpDir = join(ctx.dataDir, 'truncations', 'tmp');
            mkdirSync(tmpDir, { recursive: true });
            sinkPath = join(tmpDir, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.log`);
            sinkFd = openSync(sinkPath, 'w');
          } catch { sinkPath = null; }
          const child = spawn(
            process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
            process.platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-c', cmd],
            { cwd: ctx.cwd, signal, stdio: ['pipe', 'pipe', 'pipe'], env: sanitizedEnv() },
          );
          if (stdinSecret) {
            child.stdin?.write(stdinSecret);
            child.stdin?.end();
          }
          // C12 修复：流式截断——内存封顶 20000 字（完整输出已同步写 sink 文件）
          const { writeSync, closeSync, rmSync } = await import('node:fs');
          const appendOut = (d: Buffer) => {
            if (sinkFd !== null) { try { writeSync(sinkFd, d); } catch { /* sink 失败不影响执行 */ } }
            if (out.length >= outCap) { truncated = true; return; }
            out += d.toString();
            if (out.length > outCap) { out = out.slice(0, outCap); truncated = true; }
          };
          child.stdout?.on('data', appendOut);
          child.stderr?.on('data', appendOut);
          try {
            await new Promise<void>((resolveP, rejectP) => {
              child.on('error', rejectP);
              child.on('close', (code) => {
                if (sinkFd !== null) { try { closeSync(sinkFd); } catch { /* 忽略 */ } sinkFd = null; }
                if (ctx.signal?.aborted) return rejectP(new Error('已中断（用户中止）'));
                if (code === 0) return resolveP();
                exitCode = code;
                // 非 0 退出码 → 视为失败（输出附在错误消息中——模型可见且可被失败计数识别）
                return rejectP(new Error(`退出码 ${code}${out.trim() ? `：\n${out.slice(0, 2000)}` : ''}`));
              });
            });
          } finally {
            if (sinkFd !== null) { try { closeSync(sinkFd); } catch { /* 忽略 */ } }
            if (sinkPath) {
              if (truncated) fullPath = sinkPath; else { try { rmSync(sinkPath, { force: true }); } catch { /* 忽略 */ } }
            }
          }
        }
        // 截断诚实标注（绝不静默）：超限时完整输出已落盘 offload，附续读路径；
        // 否则提示分段获取。包裹面 8000 护栏不变（executeTool 侧大输出另有 offload）。
        // 8000–20000 区间（未触发流式截断但超包裹面）同样显式标注——修复历史静默截断缺陷
        const body = out || '（无输出）';
        let note = '';
        if (truncated) {
          if (fullPath) {
            note = `\n…[输出已截断——完整输出已落盘：${fullPath}——用 bash cat/sed/tail 分段读取，或重定向到工作区文件后用 fs_read 分页]`;
          } else {
            note = `\n…[输出已截断（共 ${body.length} 字预览）——用更精确的命令分段获取（重定向到文件/sed/tail）]`;
          }
        } else if (body.length > 8000) {
          note = `\n…[输出已截断（共 ${body.length} 字，剩余 ${body.length - 8000} 字未读）——用更精确的命令分段获取（重定向到文件/sed/tail）]`;
        }
        const wrapped = wrapDanger(body.length > 8000 ? body.slice(0, 8000) : body);
        if (exitCode !== null && exitCode !== 0) {
          return `${wrapped}\n命令退出码 ${exitCode}（失败）${out.trim() ? `\n${out.slice(0, 2000)}` : ''}`;
        }
        return note ? `${wrapped}${note}` : wrapped;
      } catch (e: any) {
        ctx.hookFailure?.('bash', String(e?.message ?? e).slice(0, 500));
        return wrapDanger(`命令失败：${e.message?.slice(0, 500)}`);
      }
    },
  };
  const findFiles: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'find_files',
        description: '按文件名/glob 搜索文件（递归，跳过 node_modules/.git/dist 等）。需要定位某文件（如修改哪个文件、找配置）时调用，比逐目录 ls 高效。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '文件名或 glob（如 "*.test.ts"、"config.json"、"src/**/hooks/*"）' },
            max: { type: 'number', description: '最多返回条数（默认 30）' },
            max_depth: { type: 'number', description: '最大递归深度（默认 12；大目录可调小提速）' },
          },
          required: ['pattern'],
        },
      },
    },
    danger: false,
    async run(args, ctx) {
      const pattern = String(args?.pattern ?? '').trim();
      if (!pattern) return '参数错误：pattern 不能为空';
      const max = Math.min(Math.max(Number(args?.max) || 30, 1), 100);
      // A21：限深参数（默认 12 层——防大目录递归爆炸）
      const maxDepth = Math.min(Math.max(Number(args?.max_depth) || 12, 1), 20);
      try {
        const { readdirSync } = await import('node:fs');
        const { join, relative, sep } = await import('node:path');
        const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', 'out', '.next', '.venv', '__pycache__', '.wxnodus', '.zcode']);
        // 简单 glob 转正则：** → 任意多层，* → 单层段，? → 单字符
        const toRe = (g: string): RegExp => {
          const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
          return new RegExp('^' + esc.replace(/\*\*/g, '__DOUBLE__').replace(/\*/g, '[^/]*').replace(/__DOUBLE__/g, '.*') + '$');
        };
        const re = toRe(pattern);
        const out: string[] = [];
        const walk = (dir: string, depth: number): void => {
          if (depth > maxDepth) return;
          let entries: Array<{ name: string; isDir: boolean }> = [];
          try {
            entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }));
          } catch { return; }
          for (const e of entries) {
            if (e.isDir && SKIP.has(e.name)) continue;
            const abs = join(dir, e.name);
            if (e.isDir) { walk(abs, depth + 1); continue; }
            const rel = relative(ctx.cwd, abs).split(sep).join('/');
            if (re.test(e.name) || re.test(rel)) out.push(rel);
            if (out.length >= max) return;
          }
        };
        walk(ctx.cwd, 0);
        if (!out.length) return `未找到匹配「${pattern}」的文件（跳过 node_modules/.git/dist 等）`;
        return `找到 ${out.length} 个文件：\n${out.map(f => '  ' + f).join('\n')}`;
      } catch (e: any) {
        return `搜索失败：${String(e?.message ?? e).slice(0, 120)}`;
      }
    },
  };
  const ls: ToolDef = {
    schema: { type: 'function', function: { name: 'ls', description: '列出目录内容（head 限制条目数——大目录分段查看）', parameters: { type: 'object', properties: { path: { type: 'string' }, head: { type: 'number', description: '最多返回条目数（缺省 200）' } }, required: [] } } },
    danger: false,
    async run({ path = '.', head }, ctx) {
      try {
        const entries = readdirSync(resolve(ctx.cwd, path)).map(f => {
          const p = join(resolve(ctx.cwd, path), f);
          try { return statSync(p).isDirectory() ? `${f}/` : f; } catch { return f; }
        });
        const cap = Math.max(1, Math.floor(Number(head) || 200));
        // 诚实截断：大目录显式标注（模型知道还有条目——加 head 或子目录分段查看）
        return entries.length > cap
          ? `${entries.slice(0, cap).join('\n')}\n…[共 ${entries.length} 个条目，已截断（前 ${cap} 个）——加 head 参数或按子目录分段查看]`
          : entries.join('\n');
      } catch (e: any) { return `目录读取失败：${e.message}`; }
    },
  };
  const grep: ToolDef = {
    schema: { type: 'function', function: { name: 'grep', description: '在文件中搜索文本（head 限制结果行数——命中过多时收窄或加 head）', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, head: { type: 'number', description: '最多返回行数（缺省 200）' } }, required: ['pattern'] } } },
    danger: false,
    async run({ pattern, path = '.', head }, ctx) {
      // 修复 F14：execFileSync 参数数组（不经 shell），消除命令注入
      // A25：Windows 无 grep 时诚实报错——此前 ENOENT 被 catch 成「（无匹配）」，
      // 模型拿到假阴性结论（工具假装可用）
      if (!hasGrep()) {
        return 'grep 工具不可用：未找到 grep 二进制（Windows 请安装 Git for Windows 或配置 PATH；或改用 find_files）';
      }
      try {
        const out = execFileSync('grep', ['-rn', String(pattern), resolve(ctx.cwd, path)], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
        const lines = out.split('\n').filter(l => l.trim());
        const cap = Math.max(1, Math.floor(Number(head) || 200));
        // 诚实截断：超行数结果显式标注（模型知道后面还有匹配——收窄 pattern/限定 path/加 head 续查）
        if (lines.length > cap) {
          return `${lines.slice(0, cap).join('\n')}\n…[匹配 ${lines.length} 行，已截断（前 ${cap} 行）——收窄搜索词或限定目录续查]`;
        }
        return out.trim() || '（无匹配）';
      } catch (e: any) {
        // 退出码 1 = 无匹配（grep 语义）；其余（如 2=文件错误）如实报错
        const code = (e as NodeJS.ErrnoException & { status?: number })?.status;
        if (code === 1) return '（无匹配）';
        const msg = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? 'grep 工具不可用：未找到 grep 二进制（Windows 请安装 Git for Windows 或配置 PATH）'
          : `grep 失败：${String(e?.message ?? e).slice(0, 120)}`;
        return msg;
      }
    },
  };
  const httpGet: ToolDef = {
    schema: { type: 'function', function: { name: 'http_get', description: 'GET 请求（SSRF 防护：内网/IPv6 私网/DNS 重绑定/重定向逐跳拦截）。HTML 页面自动提取正文文本；API/JSON 响应返回原始内容。', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    danger: true, // 外联/写库/调度/敏感输入——需确认
    async run({ url }, ctx) {
      // 最小间隔节流（800ms）：与 web_search 同款自保护——连发抓取不触发站点限流
      const wait = minIntervalSince(lastHttpGetTs, 800);
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
      lastHttpGetTs = Date.now();
      // SSRF 三层防护（src/kernel/ssrf.ts）：主机名形态 + DNS 解析校验 + 重定向逐跳
      const { safeFetchText } = await import('./ssrf.js');
      const { htmlToText, extractMainText, looksLikeHtml } = await import('./html.js');
      const r = await safeFetchText(String(url));
      if ('error' in r) return r.error;
      // 审查接线（授权存证）：外部访问自动留痕——scope=host，/consent list 可查
      try { await recordConsent(ctx.db, hostOf(String(url)), 'http_get'); } catch { /* 存证失败静默 */ }
      // 审查接线（自动化护栏）：robots.txt 禁止路径拦截 + 验证码页面提示
      const { robotsGuard } = await import('./robotsGuard.js');
      const guard = await robotsGuard(String(url), r.text);
      if (guard.block) return guard.block;
      // 状态码归因：4xx/5xx 正文不当作有效内容（404 页误导）
      if (r.status >= 400) return `请求失败：HTTP ${r.status}（页面不可用或反爬拦截）`;
      // HTML 页面 → 正文文本（readability 式启发优先——导航/页脚噪声不入结果；空则全量剥标签兜底）
      if (looksLikeHtml(r.text)) {
        const body = extractMainText(r.text, 8000) || htmlToText(r.text, 8000);
        return `HTTP ${r.status}｜页面正文${guard.captcha ? '\n⚠ 检测到验证码页面（站点反爬——内容可能不可用）' : ''}\n${body || '（页面无可提取文本，可能是 JS 渲染）'}`;
      }
      return `HTTP ${r.status}\n${labelTruncate(r.text, 8000, '/claw <url> 或分段抓取续看')}`;
    },
  };
  // web_search：AI 主动联网搜索（DDG/Bing 双引擎自动回退）——「查」的主动工具。
  // 模型需要实时信息/最新资料时调用，返回结构化标题/URL/摘要，配合 http_get 读正文、
  // memory_write 存档，形成「搜索→抓取→沉淀」的自主联网闭环。
  const webSearch: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索（DuckDuckGo/Bing 双引擎自动回退，SSRF 防护）。需要实时信息、最新资料、外部数据、或用户问题涉及网络内容时调用——比凭空编造更可靠。返回结构化结果（标题/URL/摘要），再配合 http_get 抓取正文。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索查询词（中文/英文均可，建议具体）' },
            max_results: { type: 'number', description: '返回条数（默认 5，最大 8）' },
            engine: { type: 'string', enum: ['auto', 'duckduckgo', 'bing'], description: '搜索引擎（默认 auto：DDG 优先失败回退 Bing；可指定）' },
          },
          required: ['query'],
        },
      },
    },
    danger: true, // 外联——需确认
    async run({ query, max_results, engine }) {
      const { searchWeb } = await import('./search.js');
      const q = String(query ?? '').trim();
      if (!q) return '搜索词为空';
      const max = Math.min(Math.max(Number(max_results) || 5, 1), 8);
      const eng = (engine === 'duckduckgo' || engine === 'bing') ? engine : 'auto';
      // 最小间隔节流（1.5s）：防止模型连发搜索触发引擎 429/封禁——自保护护栏
      const wait = minIntervalSince(lastSearchTs, 1500);
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
      lastSearchTs = Date.now();
      const r = await searchWeb(q, { maxResults: max, engine: eng });
      if (!r.ok) return `搜索失败：${r.error}`;
      if (!r.results.length) return '搜索无结果（可换关键词重试）';
      return `引擎：${r.engine}｜共 ${r.results.length} 条\n` +
        r.results
          .map((x, i) => `${i + 1}. ${x.title}\n   链接：${x.url}${x.snippet ? `\n   摘要：${x.snippet}` : ''}`)
          .join('\n');
    },
  };
  // A21：http_request——多方法 HTTP（POST/PUT/DELETE/PATCH），SSRF 防护复用（方法无关）
  const httpRequest: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'http_request',
        description:
          'HTTP 请求（POST/PUT/DELETE/PATCH/GET）——调用需要鉴权的 REST API、提交数据等。SSRF 三层防护（内网/重绑定/重定向拦截）+ 响应体 1MB 上限。body 传对象自动 JSON 序列化。',
        parameters: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP 方法（默认 GET）' },
            url: { type: 'string', description: '请求 URL（http/https，内网被拦截）' },
            body: { description: '请求体：JSON 对象自动序列化，或原始字符串', oneOf: [{ type: 'object' }, { type: 'string' }] },
            headers: { type: 'object', description: '附加请求头（如 Authorization——配合 credential_form 安全录入）' },
          },
          required: ['url'],
        },
      },
    },
    danger: true, // 外联/写库/调度/敏感输入——需确认（POST 有副作用更需确认链）
    async run({ method, url, body, headers }) {
      const { safeFetchText } = await import('./ssrf.js');
      const r = await safeFetchText(String(url), {
        method: String(method ?? 'GET'),
        body: body as string | Record<string, unknown> | undefined,
        headers: (headers ?? {}) as Record<string, string>,
        maxBytes: 1_000_000,
      });
      if ('error' in r) return r.error;
      return `HTTP ${r.status}\n${labelTruncate(r.text, 8000, '/claw <url> 或分段抓取续看')}`;
    },
  };
  // memory_search：黑洞引擎主动检索（建议清单 P0-1 落地）——模型需要回忆历史时调用。
  // W3 Memory：切 modern 权威层——scope 只来自可信 ToolCtx.sessionId（会话隔离），
  // 显式记忆记录（memory_records）FTS 检索（召回策略一致性验证后另行决定）
  const memorySearch: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'memory_search',
        description: '检索历史记忆（modern 显式记忆记录，会话隔离）。需要回忆之前讨论过的内容、决策、数据时调用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词（中文自动 bigram 分词）' },
            limit: { type: 'number', description: '返回条数（默认 5）' },
          },
          required: ['query'],
        },
      },
    },
    danger: false,
    async run(args, ctx) {
      const q = String(args?.query ?? '').trim();
      if (!q) return '参数错误：query 不能为空';
      try {
        const { memoryServiceForTool } = await import('../application/memory/memoryToolService.js');
        const svc = memoryServiceForTool(ctx);
        const result = svc.search({ text: q, limit: Math.min(Math.max(Number(args?.limit) || 5, 1), 20) });
        if (!result.ok) return `记忆检索失败：${result.error.code}`;
        if (!result.value.length) return `未检索到与「${q.slice(0, 40)}」相关的历史记忆`;
        return `历史记忆命中 ${result.value.length} 条：\n${result.value.map(h => `- [${h.record.id}] ${labelTruncate(String(h.record.content ?? ''), 300)}`).join('\n')}`;
      } catch (e: any) {
        return `记忆检索失败：${String(e?.message ?? e).slice(0, 120)}`;
      }
    },
  };
  const memoryWrite: ToolDef = {
    schema: { type: 'function', function: { name: 'memory_write', description: '写入长期记忆（modern 显式记忆记录，会话隔离，/memory search 与 /hole 可检索）', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
    danger: true, // 外联/写库/调度/敏感输入——需确认
    async run({ content }, ctx) {
      const c = String(content ?? '').trim();
      if (!c) return '记忆内容为空';
      try {
        const { memoryServiceForTool } = await import('../application/memory/memoryToolService.js');
        const svc = memoryServiceForTool(ctx);
        const result = svc.append({
          role: 'assistant',
          content: c,
          salience: 0.5,
          retention: { class: 'session', retainUntil: null },
          provenance: {
            sourceType: 'tool',
            sourceId: ctx.sessionId ?? 'default',
            sourceUri: undefined,
            capturedAt: new Date().toISOString(),
            actorId: ctx.sessionId ?? 'default',
            correlationId: 'memory_write',
            policySnapshotId: 'tool',
            sourceTrust: 1,
          },
        });
        if (!result.ok) return `记忆写入失败：${result.error.code}`;
        return '已写入长期记忆（/memory search 可检索）';
      } catch (e: any) { return `记忆写入失败：${String(e?.message ?? e).slice(0, 120)}`; }
    },
  };
  // P0-2：记忆删改闭环——memory_search（查）/memory_write（增）已有，补 update/delete：
  // 模型发现记忆过时/错误时可主动纠正（改），或按 id 清理（删）——「增删改查」四操作齐
  // W3 Memory：id 为 modern 字符串 id（memory_search 返回的 [id]）
  const memoryUpdate: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'memory_update',
        description: '改写历史记忆（按 id 更新内容，FTS 全文索引同步）。发现记忆过时/错误/不完整时调用纠正——比重复写入更准确。id 来自 memory_search 结果。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '记忆 id（memory_search 返回的 [id]）' },
            content: { type: 'string', description: '纠正后的完整内容' },
          },
          required: ['id', 'content'],
        },
      },
    },
    danger: true, // 写库——需确认
    async run({ id, content }, ctx) {
      const sid = String(id ?? '').trim();
      const c = String(content ?? '').trim();
      if (!sid) return '参数错误：id 必填（字符串 id，见 memory_search 结果）';
      if (!c) return '参数错误：content 不能为空';
      try {
        const { memoryServiceForTool } = await import('../application/memory/memoryToolService.js');
        const svc = memoryServiceForTool(ctx);
        const result = svc.update(sid, { content: c });
        return result.ok ? `已更新记忆 ${sid}（FTS 同步）` : `记忆 ${sid} 不存在或越权（${result.error.code}——/memory search 查看 id）`;
      } catch (e: any) {
        return `记忆更新失败：${String(e?.message ?? e).slice(0, 120)}`;
      }
    },
  };
  const memoryDelete: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'memory_delete',
        description: '删除历史记忆（按 id 删除 + FTS 索引清理）。记忆内容错误且无法通过 memory_update 纠正时调用。id 来自 memory_search 结果。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '记忆 id（memory_search 返回的 [id]）' },
          },
          required: ['id'],
        },
      },
    },
    danger: true, // 写库/删除——需确认
    async run({ id }, ctx) {
      const sid = String(id ?? '').trim();
      if (!sid) return '参数错误：id 必填（字符串 id，见 memory_search 结果）';
      try {
        const { memoryServiceForTool } = await import('../application/memory/memoryToolService.js');
        const svc = memoryServiceForTool(ctx);
        const result = svc.delete(sid);
        return result.ok ? `已删除记忆 ${sid}（索引已清理）` : `记忆 ${sid} 不存在或越权（${result.error.code}——/memory search 查看 id）`;
      } catch (e: any) {
        return `记忆删除失败：${String(e?.message ?? e).slice(0, 120)}`;
      }
    },
  };
  // P0-1：浏览器自动化工具组（竞品标配缺口补齐）——系统 Edge/Chrome 复用 + SSRF 域名白名单。
  // 模型可主动打开网页、点击、输入、截图（/img 视觉分析）——配合 web_search 形成完整联网闭环。
  const browserNavigate: ToolDef = {
    schema: { type: 'function', function: { name: 'browser_navigate', description: '打开网页（系统浏览器 + SSRF 三层防护：内网/DNS 重绑定/重定向逐跳拦截）。返回页面标题/地址/正文快照——模型据此决定下一步点击或输入。', parameters: { type: 'object', properties: { url: { type: 'string', description: 'http/https 公网 URL' } }, required: ['url'] } } },
    danger: true, // 外联/副作用——需确认
    async run({ url }, ctx) {
      const { browserNavigate } = await import('./browser.js');
      const r = await browserNavigate(String(url ?? ''), ctx.sessionId);
      // 审查接线（授权存证）：导航成功即留痕（scope=host；SSRF 已放行的公网目标）
      if (r.ok) { try { await recordConsent(ctx.db, hostOf(String(url ?? '')), 'browser_navigate'); } catch { /* 静默 */ } }
      return r.text;
    },
  };
  const browserClick: ToolDef = {
    schema: { type: 'function', function: { name: 'browser_click', description: '点击页面元素（CSS 选择器）。导航后操作页面交互（链接/按钮/标签页切换）。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器，如 a[href*="docs"]、#submit、button:has-text("登录")' } }, required: ['selector'] } } },
    danger: true, // 外联/副作用——需确认
    async run({ selector }, ctx) {
      const { browserClick } = await import('./browser.js');
      const r = await browserClick(String(selector ?? ''), ctx.sessionId);
      return r.text;
    },
  };
  const browserType: ToolDef = {
    schema: { type: 'function', function: { name: 'browser_type', description: '向输入框输入文本（CSS 选择器定位；submit=true 回车提交——表单/搜索框）。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器（input/textarea）' }, text: { type: 'string', description: '输入内容' }, submit: { type: 'boolean', description: '输入后回车（默认 false）' } }, required: ['selector', 'text'] } } },
    danger: true, // 外联/副作用——需确认
    async run({ selector, text, submit }, ctx) {
      const { browserType } = await import('./browser.js');
      const r = await browserType(String(selector ?? ''), String(text ?? ''), submit === true, ctx.sessionId);
      return r.text;
    },
  };
  const browserScreenshot: ToolDef = {
    schema: { type: 'function', function: { name: 'browser_screenshot', description: '当前页面截图保存（返回文件路径——配合 /img 或视觉模型分析页面视觉状态）。', parameters: { type: 'object', properties: {} } } },
    danger: false,
    async run(_args, ctx) {
      const { browserScreenshot } = await import('./browser.js');
      const r = await browserScreenshot(ctx.sessionId);
      return r.text;
    },
  };
  const browserSnapshot: ToolDef = {
    schema: { type: 'function', function: { name: 'browser_snapshot', description: '当前页面快照（标题/地址/正文 + 可交互元素清单——按钮/链接/输入框的选择器建议）。交互前先调用本工具确定选择器。', parameters: { type: 'object', properties: {} } } },
    danger: false,
    async run(_args, ctx) {
      const { browserSnapshot } = await import('./browser.js');
      const r = await browserSnapshot(ctx.sessionId);
      return r.text;
    },
  };
  const browserWait: ToolDef = {
    schema: { type: 'function', function: { name: 'browser_wait', description: '等待元素出现（SPA 动态加载后交互前调用）或固定毫秒。selector 为空时按毫秒等待（默认 2s）。', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器（空则按 timeout_ms 等待）' }, timeout_ms: { type: 'number', description: '超时毫秒（默认 15000）' } } } } },
    danger: false,
    async run({ selector, timeout_ms }, ctx) {
      const { browserWait } = await import('./browser.js');
      const r = await browserWait(String(selector ?? ''), Number(timeout_ms) || 15000, ctx.sessionId);
      return r.text;
    },
  };
  const browserClose: ToolDef = {
    schema: { type: 'function', function: { name: 'browser_close', description: '关闭浏览器会话（释放进程；下次 browser_navigate 自动重启）。', parameters: { type: 'object', properties: {} } } },
    danger: false,
    async run(_args, ctx) {
      const { browserClose } = await import('./browser.js');
      return await browserClose(ctx.sessionId);
    },
  };
  // P2-全方面：notify——AI 主动发系统通知（Codex notify 对齐）：长任务完成/关键事件提醒用户
  const notify: ToolDef = {
    schema: { type: 'function', function: { name: 'notify', description: '发送系统通知（长任务完成/关键事件提醒用户关注——如后台任务结束、重要结论）。', parameters: { type: 'object', properties: { content: { type: 'string', description: '通知内容（一句话）' } }, required: ['content'] } } },
    danger: false,
    async run({ content }, ctx) {
      const c = String(content ?? '').trim();
      if (!c) return '参数错误：content 不能为空';
      if (!ctx.bus) return '通知通道不可用（事件总线未装配）';
      try {
        ctx.bus.emit('system.notice', { text: `🔔 ${c.slice(0, 200)}` });
        return '通知已发送';
      } catch (e: any) {
        return `通知发送失败：${String(e?.message ?? e).slice(0, 120)}`;
      }
    },
  };
  const scaffoldBuild: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'scaffold_build',
        description: '构建可运行项目（需求编译：规格 → 计划 → 脚手架落地到 data/projects/）。dry_run=true 时只编译不落盘（预览计划与诊断）。',
        parameters: {
          type: 'object',
          properties: {
            spec: { type: 'string', description: '项目规格 JSON（title/summary/scaffold/acceptance）' },
            dry_run: { type: 'boolean', description: 'true = 只编译（规格诊断+计划预览），不产生任何文件（默认 false）' },
          },
          required: ['spec'],
        },
      },
    },
    danger: true,
    async run({ spec, dry_run }, ctx) {
      try {
        const parsed = typeof spec === 'string' ? JSON.parse(spec) : spec;
        if (!parsed?.title || !parsed?.summary) return 'spec 不完整（需要 title/summary）';
        const { validateSpec, diagnoseSpec, SCAFFOLDS } = await import('../build/spec.js');
        const { instantiate } = await import('../build/scaffold.js');
        const { createHash } = await import('node:crypto');
        // 规则脑已移除（2026-08-18）：AI 传入的 spec 必须显式完整——
        // 非法模具/空验收 fail-closed 报错，绝不回退确定性兜底
        const scaffoldRaw = String(parsed.scaffold ?? '');
        if (!(SCAFFOLDS as readonly string[]).includes(scaffoldRaw)) {
          return `scaffold_build 拒绝：scaffold 非法（必须 ∈ ${SCAFFOLDS.join('/')}）——AI 必须显式给出合法模具`;
        }
        if (!Array.isArray(parsed.acceptance) || parsed.acceptance.length === 0) {
          return 'scaffold_build 拒绝：acceptance 缺失——AI 必须显式给出验收条目';
        }
        const s = {
          title: String(parsed.title ?? '').slice(0, 30).trim(),
          summary: String(parsed.summary ?? '').slice(0, 500).trim(),
          scaffold: scaffoldRaw,
          acceptance: parsed.acceptance.slice(0, 3).map((a: unknown) => String(a).slice(0, 120)),
        };
        const diags = diagnoseSpec(s);
        const errors = diags.filter(d => d.level === 'error');
        // 计划构造：规则脑分解已移除——固定单模块计划
        const plan = {
          modules: [{ name: 'app', deps: [], desc: '单模块应用' }],
          order: ['app'],
          milestones: ['M1 应用构建', 'M2 验证与交付'],
        };
        // A21：dry-run——只编译不落盘（诊断 + 计划预览，零副作用）
        if (dry_run === true) {
          const diagLines = diags.length
            ? diags.map(d => ` ${d.level === 'error' ? '✗' : d.level === 'warning' ? '!' : '·'} [${d.code}] ${d.message}`)
            : [' 无诊断问题'];
          return [
            `── 规格诊断（${diags.filter(d => d.level === 'error').length} error / ${diags.filter(d => d.level === 'warning').length} warning）──`,
            ...diagLines,
            `── 编译计划（dry-run，未落盘）──`,
            ` 模块：${plan.order.join(' → ')}`,
            ` 里程碑：${(plan.milestones ?? []).join('；') || '（单阶段）'}`,
            ` 验收：${s.acceptance.join('；')}`,
          ].join('\n');
        }
        if (!validateSpec(s).ok) {
          return `规格校验失败：${errors.map(e => e.message).join('；')}`;
        }
        const dir = join(ctx.dataDir, 'projects', parsed.title);
        const r = instantiate(s, dir, plan); // KF-022：scaffold 由 BuildPlan 驱动
        if (!r.ok) return `脚手架失败：${r.reason}`;
        // A21：规格 IR 版本化——spec.json 快照 + sha256（后续 build 可 diff/增量）
        try {
          const { mkdirSync, writeFileSync } = await import('node:fs');
          mkdirSync(dir, { recursive: true });
          const ir = { specVersion: 1, builtAt: Date.now(), spec: s, plan: { order: plan.order, milestones: plan.milestones ?? [] } };
          const json = JSON.stringify(ir, null, 2);
          writeFileSync(join(dir, 'spec.json'), json, 'utf8');
          writeFileSync(join(dir, 'spec.sha256'), createHash('sha256').update(json).digest('hex'), 'utf8');
        } catch { /* IR 落盘失败不阻断构建 */ }
        return `项目已生成 → ${dir}\n规格 IR 已版本化（spec.json + sha256）\n模块计划：${plan.order.join(' → ')}\n验收：${s.acceptance.join('；')}`;
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
        return `${head}（${r.turns} 轮）：\n${labelTruncate(String(r.output ?? ''), 4000, '子代理输出过长——goal 里要求结论精简，或拆分子任务')}`;
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
    danger: true, // 外联/写库/调度/敏感输入——需确认
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
  // credential_form：模型需要敏感信息（API Key/密码/令牌）时，CLI 动态内容表多字段输入——
  // 用户亲手输入、仅内存 vault（$WXNODUS_SECRET_<字段> 供 bash 展开）、不落盘不进历史
  const credentialForm: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'credential_form',
        description: '请求用户提供敏感信息（API Key/密码/令牌等）——CLI 动态内容表多字段输入，仅内存不保存。任务需要用户凭据（如调用需要鉴权的接口/网站）时调用。',
        parameters: {
          type: 'object',
          properties: {
            fields: { type: 'array', items: { type: 'string' }, description: '所需字段名数组（如 ["api_key","secret_key"]）' },
            prompt: { type: 'string', description: '说明为何需要这些信息' },
          },
          required: ['fields'],
        },
      },
    },
    danger: true, // 外联/写库/调度/敏感输入——需确认
    async run(args, ctx) {
      const names = Array.isArray(args?.fields) ? args.fields.map(String).filter(Boolean) : [];
      if (!names.length) return '参数错误：fields 需为非空字段名数组';
      if (!ctx.requestForm) return '动态内容表不可用（需 TUI 会话）——请用 /key set 配置或 /input <字段> 手动录入';
      // P0-1 审计留痕：记录谁在何时请求了哪些字段（不含值——值绝不落盘）
      try {
        const { appendAudit } = await import('../store/db.js');
        appendAudit(ctx.db as any, 'credential.form_request', { source: 'agent_tool', fields: names });
      } catch { /* 审计失败不阻断 */ }
      const fields = names.map(n => ({ name: n.replace(/[^\w-]/g, '_'), label: n, kind: 'password' as const }));
      const prompt = String(args?.prompt ?? '').slice(0, 200) || '模型请求你提供以下敏感信息（仅内存，不保存）';
      const values = await ctx.requestForm(fields, prompt);
      if (!values) return '用户取消/超时——未录入任何值（内容不保存）';
      if (!ctx.secrets?.vault) return '内存保险库不可用（安全通道未装配）——/security secret on 开启';
      const { commitFormValues, validateFormResponse } = await import('./dynamicForm.js');
      const missing = validateFormResponse(values, fields);
      const committed = commitFormValues(ctx.secrets.vault, values, fields);
      if (!committed.length) return '未录入任何字段（全部为空）——内容不保存';
      return `已录入 ${committed.length} 个敏感字段（仅内存，不落盘）——bash 中可用 $WXNODUS_SECRET_${committed[0]} 引用；/security secret off 或进程退出即清除${missing.length ? `；未填写：${missing.join('、')}` : ''}`;
    },
  };
  // wx_cmd：AI 自主调用通道——模型可直接执行 WxNodus 内置斜杠指令
  // （分级裁决在 agent.executeTool：safe 直执行 / confirm 走模式确认链 / danger 强制人工确认 /
  //   redline 直接拒绝——commandLevels.classifyCommand 是单一裁决依据）
  const wxCmd: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'wx_cmd',
        description: '执行 WxNodus 内置命令（斜杠指令）——如 /memory（记忆概览）、/hole <关键词>（黑洞引擎检索）、/build <需求>（需求编译）、/plan on（计划模式）、/skill list、/cron list 等。参数 command 为完整指令串（含斜杠）。不确定用哪个命令时先调 command_search 检索目录（返回名称/描述/安全等级）。注意：涉及权限/密钥/安全/退出的指令会被拒绝，需用户手动执行。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '完整指令串，如 "/hole 项目结构" 或 "/build 待办清单应用"' },
          },
          required: ['command'],
        },
      },
    },
    danger: true, // 输出经 untrusted 包裹（命令结果可能含不可信内容）；分级裁决按命令等级
    async run(args, ctx) {
      const command = String(args?.command ?? '').trim();
      if (!command) return '参数错误：command 不能为空';
      if (!ctx.runCommand) return '命令通道未装配（当前环境不支持执行指令）——请用户手动输入';
      const out = await ctx.runCommand(command);
      // 诚实截断：超长命令输出显式标注（labelTruncate 统一口径——共 N 字/剩余 M 字）
      return out
        ? labelTruncate(out, 2000, '分段执行或重定向到文件续看')
        : `命令已执行（无输出）：${command.slice(0, 80)}`;
    },
  };
  // command_search：A22 命令目录检索（AI 主动调用入口——解决 96 条命令描述
  // 从不注入模型的盲调缺口）。模型按关键词/意图检索 → 拿到名称/描述/等级/
  // 合并关系 → 再经 wx_cmd 执行正确命令，不再瞎猜命令名。
  const commandSearch: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'command_search',
        description: '检索 WxNodus 内置命令目录（按关键词/意图，如「记忆」「构建」「安全」「任务」「搜索」）——返回命令名/描述/安全等级（🟢安全=AI 可直接执行，🟡确认=需模式确认链，🟠危险=强制人工确认，🔴红线=AI 拒绝）/合并关系。确定要调 wx_cmd 但不确定命令名时先调用本工具。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词或意图描述，如 "记忆" "构建" "权限" "后台任务"' },
          },
          required: ['query'],
        },
      },
    },
    danger: false,
    async run({ query }) {
      const { searchCommandCatalog } = await import('../commands/registry.js');
      const hits = searchCommandCatalog(String(query ?? ''), 8);
      if (!hits.length) return `未找到匹配命令（关键词：${String(query ?? '').slice(0, 40)}）——换关键词或 /help 查看全目录`;
      return `命令目录命中 ${hits.length} 条：\n` + hits
        .map(h => `- ${h.name} ${h.level}${h.merge ? `（= ${h.merge} 合并）` : ''}：${h.desc}`)
        .join('\n');
    },
  };
  // ── Computer Use（审查接线：computer/index.ts 整套此前零调用者——README 宣传但无入口）──
  // 工具链：computer_screenshot（截图→/img 或视觉模型分析）→ computer_click/type/open 按结果操作；
  // 动作经 ActionGuard 护栏（坐标越界拒绝 + 串行队列防抢鼠标）；click 坐标自动 DPI 换算
  let computerUseCache: { cu: any; width: number; height: number } | null = null;
  const getComputerUse = async (): Promise<{ cu: any; shot: any } | { error: string }> => {
    try {
      const mod = await import('./computer/index.js');
      const shot = await mod.captureScreen();
      if (!shot) return { error: '桌面捕获不可用（无桌面环境或原生模块缺失）——/doctor 查看' };
      if (!computerUseCache) {
        const { ActionGuard } = await import('./computer/guards.js');
        computerUseCache = {
          cu: new mod.ComputerUse(new ActionGuard({ width: shot.width, height: shot.height })),
          width: shot.width, height: shot.height,
        };
      }
      return { cu: computerUseCache.cu, shot };
    } catch (e: any) {
      return { error: `Computer Use 不可用：${String(e?.message ?? e).slice(0, 120)}` };
    }
  };
  const computerScreenshot: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_screenshot', description: '截取当前屏幕保存为 PNG（返回文件路径；/img <路径> 或视觉模型分析后，按坐标用 computer_click 操作屏幕）。', parameters: { type: 'object', properties: {} } } },
    danger: false,
    async run(_a, ctx) {
      const r = await getComputerUse();
      if ('error' in r) return r.error;
      try {
        const { join } = await import('node:path');
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const dir = join(ctx.dataDir, 'captures');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `screen-${Date.now().toString(36)}.png`);
        writeFileSync(file, r.shot.png);
        return `截图已保存：${file}（${r.shot.width}x${r.shot.height}——坐标按像素输入，内部自动 DPI 换算）`;
      } catch (e: any) { return `截图保存失败：${String(e?.message ?? e).slice(0, 120)}`; }
    },
  };
  const computerClick: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_click', description: '在屏幕坐标 (x,y) 点击（像素坐标——先 computer_screenshot + 视觉分析确定坐标；按钮 left/right/double）。', parameters: { type: 'object', properties: { x: { type: 'number', description: 'X 像素坐标' }, y: { type: 'number', description: 'Y 像素坐标' }, button: { type: 'string', description: 'left|right|double（默认 left）' } }, required: ['x', 'y'] } } },
    danger: true,
    async run({ x, y, button }, _ctx) {
      const r = await getComputerUse();
      if ('error' in r) return r.error;
      const { convertCoords } = await import('./computer/actionLayer.js');
      const { x: lx, y: ly } = convertCoords(Number(x), Number(y), { scale: r.shot.scale });
      const btn = button === 'right' || button === 'double' ? button : 'left';
      return await r.cu.act({ type: 'click', x: lx, y: ly, button: btn });
    },
  };
  const computerType: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_type', description: '向当前聚焦输入框键入文本（中文走剪贴板粘贴）。', parameters: { type: 'object', properties: { text: { type: 'string', description: '要键入的文本' } }, required: ['text'] } } },
    danger: true,
    async run({ text }, _ctx) {
      const r = await getComputerUse();
      if ('error' in r) return r.error;
      return await r.cu.act({ type: 'type', text: String(text ?? '') });
    },
  };
  const computerOpen: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_open', description: '用系统默认浏览器打开 URL 或资源管理器打开路径。', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL 或本地路径' } }, required: ['url'] } } },
    danger: true,
    async run({ url }, _ctx) {
      const r = await getComputerUse();
      if ('error' in r) return r.error;
      return await r.cu.act({ type: 'open', url: String(url ?? '') });
    },
  };
  const computerObserve: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_observe', description: '理解当前屏幕：截图 + 视觉模型描述（可见文字/布局/元素及其位置线索）。操作屏幕前先观察——配合 computer_uia_tree 拿精确元素结构。', parameters: { type: 'object', properties: {} } } },
    danger: false,
    async run(_a, ctx) {
      const r = await getComputerUse();
      if ('error' in r) return r.error;
      try {
        const { join } = await import('node:path');
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const dir = join(ctx.dataDir, 'captures');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `observe-${Date.now().toString(36)}.png`);
        writeFileSync(file, r.shot.png);
        // 开放视觉通道（settings/env 端点可换、本地 VLM 离线可用）
        const { describeImageStatus } = await import('./vision.js');
        const settings = ctx.getSettings?.();
        const enc = (settings as any)?.apiKeyEnc as string | undefined ?? null;
        const vr = await describeImageStatus(file, enc, '描述当前屏幕内容：界面/窗口/按钮与输入框的名称与大致位置（用中文），以及屏幕上的可见文字。', settings);
        const text = vr.ok ? (vr.text ?? '') : `（视觉不可用：${vr.reason}——已截图 ${file}，可用 /img 复查或 computer_uia_tree 读元素结构）`;
        return `截图已保存：${file}（${r.shot.width}x${r.shot.height}）${vr.cached ? '\n（同屏缓存：10s 内相同画面未重新识别）' : ''}\n${labelTruncate(text, 1500, '视觉描述过长——computer_uia_tree 读精确元素结构')}`;
      } catch (e: any) { return `观察失败：${String(e?.message ?? e).slice(0, 120)}`; }
    },
  };
  // ── UIA（Windows UI Automation——元素级桌面控制，robotjs 盲坐标的上限升级）──
  // 定位语法：<Name>|<AutomationId>（任一可省）——来自 computer_uia_tree 的输出
  const uiaWindowsTool: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_uia_windows', description: '枚举可见窗口（标题/进程/句柄）——定位要操作的窗口后，用 computer_uia_tree <句柄> 读其控件结构。', parameters: { type: 'object', properties: {} } } },
    danger: false,
    async run() {
      const { uiaWindows } = await import('./computer/uia.js');
      const r = uiaWindows();
      if (!r.ok) return r.reason ?? 'UIA 不可用';
      const all = r.windows ?? [];
      if (!all.length) return '未发现可见窗口';
      const wins = all.slice(0, 30);
      const cap = capNote(all.length, 30, 'computer_uia_tree <handle> 直达目标窗口');
      return `可见窗口（${wins.length}${all.length > 30 ? `/共 ${all.length}` : ''}）：\n` + wins.map(w => `${w.focused ? '◉' : '○'} 「${w.name.slice(0, 40)}」${w.className ? ` <${w.className}>` : ''} pid=${w.pid} handle=${w.handle}`).join('\n') + (cap ? `\n${cap}` : '');
    },
  };
  const uiaTreeTool: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_uia_tree', description: '读取窗口控件树（元素级结构：类型/名称/AutomationId/坐标/可用性）。盲坐标点击前先读树——动态 UI 按元素定位。无句柄时读当前焦点窗口。', parameters: { type: 'object', properties: { handle: { type: 'string', description: '窗口句柄（computer_uia_windows 输出；可省=焦点窗口）' } } } } },
    danger: false,
    async run({ handle }) {
      const { uiaTree } = await import('./computer/uia.js');
      const r = uiaTree(String(handle ?? ''));
      if (!r.ok) return r.reason ?? 'UIA 不可用';
      const els = r.elements ?? [];
      if (!els.length) return '控件树为空（窗口无可交互元素）';
      const shown = els.slice(0, 60);
      const cap = capNote(els.length, 60, '用 computer_uia_find <名称>|<AutomationId> 定位具体元素');
      return `控件树（${els.length} 项——定位语法 <名称>|<AutomationId>）：\n` + shown.map(e =>
        `${e.name ? `「${e.name.slice(0, 30)}」` : ''}${e.id ? ` id=${e.id}` : ''} <${e.ct}> @(${e.x},${e.y} ${e.w}x${e.h})${e.enabled ? '' : ' ✗disabled'}`.trim()
      ).join('\n') + (cap ? `\n${cap}` : '');
    },
  };
  const uiaFindTool: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_uia_find', description: '按名称或 AutomationId 定位元素（返回控件信息与坐标）。定位后 computer_uia_click/type 操作。', parameters: { type: 'object', properties: { query: { type: 'string', description: '<名称>|<AutomationId>（任一可省）' }, handle: { type: 'string', description: '窗口句柄（可省=全桌面搜索）' } }, required: ['query'] } } },
    danger: false,
    async run({ query, handle }) {
      const { uiaFind } = await import('./computer/uia.js');
      const r = uiaFind(String(query ?? ''), String(handle ?? ''));
      if (!r.ok) return r.reason ?? '未找到';
      const e = r.element as any;
      return `已定位：${e.name ? `「${e.name}」` : ''}${e.id ? ` id=${e.id}` : ''} <${e.ct}> @(${e.x},${e.y} ${e.w}x${e.h})`;
    },
  };
  const uiaClickTool: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_uia_click', description: '元素级点击（InvokePattern/SelectionItem 原生触发，动态 UI 可靠；失败回退坐标）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '<名称>|<AutomationId>' }, handle: { type: 'string', description: '窗口句柄（可省）' } }, required: ['query'] } } },
    danger: true,
    async run({ query, handle }) {
      const { uiaClick } = await import('./computer/uia.js');
      const r = uiaClick(String(query ?? ''), String(handle ?? ''));
      if (!r.ok) return r.reason ?? '点击失败';
      const el = r.element as any;
      return `已点击（${el?.method ?? 'uia'}）${el?.x != null ? ` @(${el.x},${el.y})` : ''}`;
    },
  };
  const uiaTypeTool: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_uia_type', description: '元素级输入（ValuePattern——中文原生，无剪贴板 hack）。', parameters: { type: 'object', properties: { text: { type: 'string' }, query: { type: 'string', description: '<名称>|<AutomationId>' }, handle: { type: 'string', description: '窗口句柄（可省）' } }, required: ['text', 'query'] } } },
    danger: true,
    async run({ text, query, handle }) {
      const { uiaType } = await import('./computer/uia.js');
      const r = uiaType(String(text ?? ''), String(query ?? ''), String(handle ?? ''));
      if (!r.ok) return r.reason ?? '输入失败';
      return `已输入 ${String(text ?? '').length} 字符（${(r.element as any)?.method ?? 'uia'}）`;
    },
  };
  // 边界裁决动作（Gate E 真实端口）：每动作重证边界（交互/解锁/Default 桌面/完整性/受保护 UI），
  // 通过后 Invoke→Selection→坐标兜底逐级尝试；边界不满足 fail-closed，绝不回落坐标
  const uiaActTool: ToolDef = {
    schema: { type: 'function', function: { name: 'computer_uia_act', description: '边界裁决的 UIA 动作：每动作重证会话边界（交互/解锁/Default 桌面/目标完整性/受保护 UI），InvokePattern→SelectionItem→坐标兜底逐级尝试；受保护/锁定/高完整性目标 fail-closed 绝不坐标回落。定位语法 <名称>|<AutomationId>|<窗口句柄>（后两者可省）。', parameters: { type: 'object', properties: { query: { type: 'string', description: '<名称>|<AutomationId>|<窗口句柄>' } }, required: ['query'] } } },
    danger: true,
    async run({ query }) {
      const { createWindowsUiaPorts } = await import('../infrastructure/computer/windowsUiaPorts.js');
      const { WindowsUiaDriver } = await import('../infrastructure/computer/windowsUiaDriver.js');
      const driver = new WindowsUiaDriver(createWindowsUiaPorts());
      const r = await driver.act({ runtimeId: String(query ?? ''), action: 'activate' }, {}, AbortSignal.timeout(30000));
      if (!r.ok) return `被阻断：${r.error.code}（边界/模式不满足——不回落坐标）`;
      return `已动作（receipt ${r.value.receiptId}）`;
    },
  };
  // ── gap P0-3 落地（2026-08-18）：apply_patch 结构化多文件补丁（codex 语法子集）──
  // 一次调用改多个文件：Add/Update/Delete/Move + @@ 锚定；全量校验通过才落盘
  // （绝不写一半）；匹配三级容错（精确→行尾空白→重缩进）；失败逐块报行号+did_you_mean。
  const applyPatchTool: ToolDef = {
    schema: {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: '结构化多文件补丁（推荐的多文件编辑方式，一次调用改多个文件）。语法：*** Begin Patch / *** Update File: <路径> + @@ 上下文锚定 + -旧行 +新行 / *** Add File / *** Delete File / *** Move File + *** To File / *** End Patch。全量校验通过才写入（任一块失败则不写任何文件并逐块报原因）。',
        parameters: {
          type: 'object',
          properties: { patch: { type: 'string', description: '补丁文本（codex apply_patch 语法子集）' } },
          required: ['patch'],
        },
      },
    },
    danger: true,
    async run({ patch }, ctx) {
      const text = String(patch ?? '').trim();
      if (!text) return '参数错误：patch 不能为空';
      const { applyPatch } = await import('./applyPatch.js');
      const r = await applyPatch(text, { cwd: ctx.cwd, dataDir: ctx.dataDir });
      return r.text;
    },
  };
  // ── gap P2「LSP 集成」落地（2026-08-18）：诊断/hover/定义三工具 ──
  // settings.lsp.servers 可配任意语言服务器；内置 typescript-language-server 探测
  // （PATH 或 cwd/node_modules/.bin）——缺失时诚实给安装指引，绝不假装诊断。
  const lspRun = async (kind: 'diagnostics' | 'hover' | 'definition', pathArg: unknown, line?: unknown, col?: unknown, ctx?: ToolCtx): Promise<string> => {
    const p = String(pathArg ?? '').trim();
    if (!p) return '参数错误：path 不能为空';
    const c = ctx!;
    const mod = await import('./lspClient.js');
    const specs = mod.discoverLspServers(c.getSettings?.(), c.cwd);
    const spec = mod.serverForFile(specs, resolve(c.cwd, p));
    if (!spec) return `未找到适用于 ${p} 的语言服务器——settings.lsp.servers 配置（/config set lsp {"servers":[{"id":"py","command":"pylsp","languages":["python"]}]}），或安装 typescript-language-server（npm i -g typescript-language-server）`;
    try {
      const session = await mod.lspSessionFor(spec, c.cwd);
      const abs = resolve(c.cwd, p);
      if (kind === 'diagnostics') {
        let text = '';
        try { const { readFileSync } = await import('node:fs'); text = readFileSync(abs, 'utf8'); } catch (e: any) { return `读取失败：${e?.message ?? e}`; }
        const diags = await session.diagnostics(abs, text);
        if (!diags.length) return '（无诊断——0 error 0 warning）';
        const shown = diags.slice(0, 30);
        return `诊断（${diags.length} 条${diags.length > 30 ? `，已截断前 ${shown.length} 条` : ''}）：\n${shown.map(d => `  ${d.severity === 'error' ? '✗' : d.severity === 'warning' ? '!' : '·'} ${p}:${d.line}:${d.col}${d.code ? ` [${d.code}]` : ''} ${d.message}`).join('\n')}`;
      }
      const ln = Math.max(1, Math.floor(Number(line) || 1));
      const cl = Math.max(1, Math.floor(Number(col) || 1));
      if (kind === 'hover') return `悬停信息（${p}:${ln}:${cl}）：\n${await session.hover(abs, ln, cl)}`;
      return `定义位置（${p}:${ln}:${cl}）：\n${await session.definition(abs, ln, cl)}`;
    } catch (e: any) {
      return `LSP 调用失败：${String(e?.message ?? e).slice(0, 200)}`;
    }
  };
  const lspDiagnostics: ToolDef = {
    schema: { type: 'function', function: { name: 'lsp_diagnostics', description: 'LSP 实时诊断（类型错误/语法错误/警告，语言服务器）。改完代码后调用验证——比运行编译更快。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } } },
    danger: false,
    async run({ path }, ctx) { return lspRun('diagnostics', path, undefined, undefined, ctx); },
  };
  const lspHover: ToolDef = {
    schema: { type: 'function', function: { name: 'lsp_hover', description: 'LSP 悬停信息（符号类型/文档注释）。查 API 用法与类型签名时调用。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, line: { type: 'number', description: '行号（从 1 开始）' }, col: { type: 'number', description: '列号（从 1 开始）' } }, required: ['path', 'line', 'col'] } } },
    danger: false,
    async run({ path, line, col }, ctx) { return lspRun('hover', path, line, col, ctx); },
  };
  const lspDefinition: ToolDef = {
    schema: { type: 'function', function: { name: 'lsp_definition', description: 'LSP 跳转定义（符号来源位置）。定位函数/类/变量定义处时调用。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, line: { type: 'number', description: '行号（从 1 开始）' }, col: { type: 'number', description: '列号（从 1 开始）' } }, required: ['path', 'line', 'col'] } } },
    danger: false,
    async run({ path, line, col }, ctx) { return lspRun('definition', path, line, col, ctx); },
  };
  return { fs_read: fsRead, fs_write: fsWrite, fs_edit: fsEdit, apply_patch: applyPatchTool, bash, ls, grep, find_files: findFiles, http_get: httpGet, http_request: httpRequest, web_search: webSearch, browser_navigate: browserNavigate, browser_click: browserClick, browser_type: browserType, browser_screenshot: browserScreenshot, browser_snapshot: browserSnapshot, browser_wait: browserWait, browser_close: browserClose, computer_screenshot: computerScreenshot, computer_click: computerClick, computer_type: computerType, computer_open: computerOpen, computer_observe: computerObserve, computer_uia_windows: uiaWindowsTool, computer_uia_tree: uiaTreeTool, computer_uia_find: uiaFindTool, computer_uia_click: uiaClickTool, computer_uia_type: uiaTypeTool, computer_uia_act: uiaActTool, lsp_diagnostics: lspDiagnostics, lsp_hover: lspHover, lsp_definition: lspDefinition, notify, memory_write: memoryWrite, memory_update: memoryUpdate, memory_delete: memoryDelete, memory_search: memorySearch, scaffold_build: scaffoldBuild, delegate, ask_user: askUser, clarify, todo, skill_load: skillLoad, repo_map: repoMap, cron_create: cronCreate, credential_form: credentialForm, wx_cmd: wxCmd, command_search: commandSearch };
}

export function isDangerous(tools: Record<string, ToolDef>, name: string): boolean {
  return tools[name]?.danger ?? false;
}

// 工具集 → OpenAI tools 数组（模型可见）
export function toolsToOpenAI(tools: Record<string, ToolDef>): unknown[] {
  return Object.values(tools).map(t => t.schema);
}
