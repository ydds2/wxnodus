// src/commands/ext/sessionCommands.ts — 会话/系统工具类命令（handlersExt 巨文件拆分第 2 块，audit §13.46）
// /resume /new /title /offline /undo /versions /snapshot /script /fork /checkpoint /reload-skills /map /init /usage /cost
import { join, resolve, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { saveCheckpoint, replaceSessionMessages } from '../../store/db.js';
import { estimateTokens } from '../../kernel/memory.js';
import { discoverSkills } from '../../kernel/skills.js';
import { scanProject, renderAgentsMd } from '../../kernel/projectScan.js';
import { buildRepoMap } from '../../kernel/repoMap.js';
import { listShadows, restoreShadow, versionsOfFile, snapshotFile, snapshotDir, restoreDirShadows } from '../../kernel/undoShadows.js';
import { lineDiff, parseHunks, applyHunkToText, reverseHunk } from '../../kernel/hunkApply.js';
import { listScripts, loadScript, saveScript, deleteScript, isValidScriptName, scriptStats, checkScriptExpectations, type Script, type ScriptStep } from '../../kernel/scripts.js';
import { usageSummary, usageRangeSince, type UsageRange } from '../../kernel/usage.js';
import { estimateCost } from '../../kernel/cost.js';
import { sessionCost, rangeCost, costText, type CostQueryResult } from '../../kernel/costQuery.js';
import { listSessionsStructured, forkSession, sessionLineage } from '../../kernel/sessionLineage.js';
import { exportSessionBundle, importSessionBundle } from '../../kernel/share.js';
import { c, type HandlerCtx } from '../handlers.js';
import { type CommandBus } from '../../app/CommandBus.js';

const lines = (title: string, body: string[]): string => {
  const w = Math.max(...body.map(l => l.length), title.length) + 4;
  return [`┌${'─'.repeat(w)}┐`, `│ ${title}${' '.repeat(w - title.length - 2)} │`, ...body.map(l => `│ ${l}${' '.repeat(Math.max(0, w - l.length - 2))} │`), `└${'─'.repeat(w)}┘`].join('\n');
};

// /script 录制状态（模块级——bus 处理器共享；/script record 挂 agent recorder）
let scriptRecording: { name: string; description: string; buffer: ScriptStep[]; current: ScriptStep | null; offStart?: () => void } | null = null;

// /usage --waterfall 的条形瀑布渲染（纯函数可单测）：
// 每行 = 一次 API 调用（轮），条长按总 token 缩放——input 段用 ░、output 段用 █，
// 一眼看出「哪轮烧 token、输入输出比」。宽度固定（后端无终端宽度，面板自洽即可）。

export function renderWaterfall(
  rows: Array<{ model: string; input_tokens: number; output_tokens: number; ts: number }>,
  width = 40,
  title?: string,
  priceFor?: (model: string, inputTokens: number, outputTokens: number) => number | null,
): string {
  const max = Math.max(...rows.map(r => r.input_tokens + r.output_tokens), 1);
  const scale = (n: number) => Math.max(1, Math.round((n / max) * width));
  const out = rows.map(r => {
    const total = r.input_tokens + r.output_tokens;
    // 0 token 行 = 端点未上报用量：无条形（NaN 防护）+ 显式标注——绝不伪装成 ≈$0 免费
    if (total === 0) {
      return ` ${new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false })} ${r.model.slice(0, 14).padEnd(14)} ${' '.repeat(2)}（端点未上报用量）`;
    }
    const inLen = Math.max(1, Math.round((r.input_tokens / total) * scale(total)));
    const outLen = Math.max(1, scale(total) - inLen + 1);
    const bar = '░'.repeat(inLen) + '█'.repeat(outLen);
    const t = new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false });
    // 行尾成本（参考价目；未收录定价不显示——诚实）——哪轮烧钱一眼可见
    const cost = priceFor ? priceFor(r.model, r.input_tokens, r.output_tokens) : null;
    return ` ${t} ${r.model.slice(0, 14).padEnd(14)} ${bar} ${total.toLocaleString()} tok（入 ${r.input_tokens.toLocaleString()} / 出 ${r.output_tokens.toLocaleString()}）${cost !== null ? ` ≈$${cost.toFixed(4)}` : ''}`;
  });
  return lines(title ?? ` Token 瀑布（最近 ${rows.length} 轮 · ░输入 █输出） `, out);
}



export function registerSessionCommands(bus: CommandBus, ctx: HandlerCtx): void {
  // ── 会话类 ──────────────────────────────────
  // /resume <id|标题片段>：真正切换会话（修复：此前仅 restoreCheckpoint 提示，不切 agent 会话）
  //   P2 深化：id 未命中时按标题模糊匹配（/resume 我的分析 → 标题含「我的分析」的会话）
  bus.register('/resume', (args) => {
    const id = args[0];
    const rows = ctx.db.prepare(`SELECT id, title FROM sessions ORDER BY updated_at DESC`).all() as any[];
    if (!id) return lines(' 会话（/resume <id> 恢复） ', rows.map(r => ` ${r.id}  ${r.title || '(无标题)'}`));
    let target = id;
    if (!rows.some(r => r.id === id)) {
      // 标题模糊匹配：取最近更新且标题包含关键词的会话
      const q = id.toLowerCase();
      const hit = rows.find(r => String(r.title ?? '').toLowerCase().includes(q));
      if (!hit) return `会话不存在：${id}`;
      target = hit.id;
    }
    const cnt = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id=?`).get(target) as { c: number }).c;
    // 真正切换：agent 会话 + 状态提示（CLI 单会话 'default' 主用；UI 走 session.resume RPC）
    try { ctx.agent?.setSessionId(target); } catch { /* 无 agent 时仅提示 */ }
    return `已切换到会话 ${target}（${cnt} 条消息）${cnt ? '——历史已加载，可直接继续对话' : ''}`;
  });

  // /sessions [--json]：结构化会话列表（gap P2-1 部分落地——first_user_message 摘要 +
  // 血缘 + 分支数，gemini sessionUtils 对齐）；--json 输出结构化 JSON（桌面端/脚本消费，
  // 与 serve 网关共用 listSessionsStructured 单一出口）
  bus.register('/sessions', (args) => {
    const list = listSessionsStructured(ctx.db, 100);
    if (args.includes('--json')) return JSON.stringify(list, null, 2);
    if (!list.length) return '暂无会话';
    return lines(' 会话 ', list.map(s => {
      const head = s.firstUser ? `「${s.firstUser}」` : '(空会话)';
      const lineage = s.forkedFromId ? ` ⟵fork ${s.forkedFromId}` : '';
      const forks = s.forkCount > 0 ? ` ⑂${s.forkCount}` : '';
      return ` ${s.id}  ${s.title || '(无标题)'}${lineage}${forks}  [${s.msgCount} 条] ${head}`;
    }));
  });

  // /share export|import：离线加密打包分享（数据不出机——opencode/kimi 云端分享的离线变体；
  // 明文包 sha256 防篡改、--encrypt 为 AES-256-GCM（scrypt 口令派生，盐/iv 随机，口令不落包））
  bus.register('/share', (args) => {
    const sub = args[0];
    const passIdx = args.indexOf('--pass');
    const pass = passIdx >= 0 ? args[passIdx + 1] : process.env.WXNODUS_SHARE_PASS;
    const clean = (a: string[]) => a.filter((_, i) => a[i - 1] !== '--pass' && a[i] !== '--pass');
    if (sub === 'export') {
      const rest = clean(args.slice(1));
      const encrypt = rest.includes('--encrypt');
      const outIdx = rest.indexOf('--out');
      const sid = rest.filter((_, i) => i !== outIdx && i !== outIdx + 1).find(a => !a.startsWith('--')) ?? ctx.agent?.getSessionId?.() ?? 'default';
      const r = exportSessionBundle(ctx.db, sid, { password: encrypt ? pass : undefined });
      if (!r.ok) return r.error;
      const outPath = outIdx >= 0 && rest[outIdx + 1] ? rest[outIdx + 1] : join(process.cwd(), `wxn-share-${sid}-${Date.now().toString(36)}.wxnshare`);
      try { writeFileSync(outPath, r.bundle, 'utf8'); } catch (e: any) { return `写入失败：${e?.message ?? e}`; }
      return `已导出会话 ${sid}（${r.summary.msgCount} 条消息${r.summary.encrypted ? '，AES-256-GCM 加密' : '，明文——建议 --encrypt 口令加密'}）→ ${outPath}\n对方导入：/share import ${outPath}${r.summary.encrypted ? ' --pass <口令>' : ''}`;
    }
    if (sub === 'import') {
      const file = clean(args.slice(1)).find(a => !a.startsWith('--'));
      if (!file) return '用法：/share import <文件> [--pass <口令>]（口令也可用环境变量 WXNODUS_SHARE_PASS）';
      let bundle: string;
      try { bundle = readFileSync(resolve(process.cwd(), file), 'utf8'); } catch (e: any) { return `读取失败：${e?.message ?? e}`; }
      const r = importSessionBundle(ctx.db, bundle, { password: pass });
      if (!r.ok) return r.error;
      return `已导入会话（来源 ${r.sourceId}）→ ${r.sessionId}（${r.msgCount} 条消息，血缘已标记 share:${r.sourceId}）——/resume ${r.sessionId} 恢复`;
    }
    return '用法：/share export [sid] [--encrypt] [--pass <口令>] [--out <文件>] ｜ /share import <文件> [--pass <口令>]\n说明：离线加密打包分享（数据不出机）；口令 argv 可见，敏感环境请用环境变量 WXNODUS_SHARE_PASS';
  });

  // /new：新建空会话并切换
  bus.register('/new', async () => {
    const newId = `s${Date.now()}n`;
    // W3 Session 第 3 步：会话启动工件（能力/hook 快照 + sha256 绑定）先落盘——
    // 生成失败 fail-closed（绝不创建无工件的会话，工件是后续审计/恢复的事实源）
    if (ctx.sessionStart) {
      const artifact = await ctx.sessionStart.ensure(newId);
      if (!artifact.ok) {
        throw new Error(`[${artifact.error.code}] 会话启动工件生成失败：${artifact.error.message}`);
      }
    }
    ctx.db.prepare(`INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(newId, '', Date.now(), Date.now());
    try { ctx.agent?.setSessionId(newId); } catch { /* 忽略 */ }
    return `已新建会话 ${newId} 并切换`;
  });

  // /title <名称>：重命名当前会话（对齐参考 /title 语义）
  bus.register('/title', (args) => {
    const name = args.join(' ').trim();
    // 审查修复：会话统一——多会话切换后作用于当前会话（此前硬编码 default）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    if (!name) {
      const row = ctx.db.prepare(`SELECT title FROM sessions WHERE id=?`).get(sid) as { title: string } | undefined;
      return `当前会话标题：${row?.title || '(未命名)'}（/title <名称> 重命名）`;
    }
    ctx.db.prepare(`UPDATE sessions SET title=?, updated_at=? WHERE id=?`).run(name.slice(0, 50), Date.now(), sid);
    return `会话已重命名：${name.slice(0, 50)}`;
  });

  // /offline：离线 token 包管理（审查完善：本地 LLM 通道——离线拼图最后一块）
  //   /offline pack status  —— 各离线组件就绪状态 + 缓存占用
  //   /offline pack download [模型] —— 预下载文本 LLM（之后完全断网可用）
  //   /offline pack dir     —— 模型缓存路径
  //   /offline on           —— 切换离线模型（= /model 离线 Qwen2.5-1.5B）
  bus.register('/offline', async (args) => {
    const { OFFLINE_MODELS, offlineModelId, isOfflineModelReady, offlineCacheBytes, ensureOfflineModelReady } = await import('../../kernel/offlineModel.js');
    // 波 2 ⑪：拉取进度回报（codex pull_with_reporter 对标——5% 步进节流，TUI 状态行实时显示）
    const progressNotice = (model: string) => {
      let lastPct = -1;
      return (p: { percent: number }) => {
        if (p.percent - lastPct >= 5 || p.percent >= 100) {
          lastPct = p.percent;
          try { ctx.bus.emit('system.notice', { text: `⬇ 下载离线模型 ${model}…${Math.floor(p.percent)}%` }); } catch { /* 静默 */ }
        }
      };
    };
    const { resolveDataDir } = await import('../../kernel/paths.js');
    const sub = args[0];
    if (sub === 'pack' && args[1] === 'status') {
      const models = ['offline:Qwen2.5-1.5B', 'offline:Qwen2.5-3B'];
      const mb = (offlineCacheBytes() / 1024 / 1024).toFixed(0);
      return lines(' 离线 token 包 ', [
        ` 文本 LLM（transformers.js + onnxruntime-node，随包零新增依赖）：`,
        ...models.map(m => {
          const info = OFFLINE_MODELS[m]!;
          return `   ${isOfflineModelReady(m) ? '✅' : '⬇'} ${m}（${info.sizeGB}，${info.speed}）${isOfflineModelReady(m) ? '已就绪' : '未下载——/offline pack download ' + m.replace('offline:', '')}`;
        }),
        ` 缓存占用：${mb} MB @ ${resolveDataDir(process.cwd())}`,
        ` 其他离线组件：记忆 embedding（本地）/ 视觉 moondream2（visionLocal）/ 语音 whisper——见各自命令`,
        ``,
        ` 边界（诚实）：离线模型无工具调用（对话为纯文本）、1.5B 质量有限（对话/规格化/摘要够用）、`,
        ` CPU ~15-30 tok/s。工具类任务离线由确定性工具兜底。`,
      ]);
    }
    if (sub === 'pack' && args[1] === 'download') {
      const model = args[2] ? `offline:${args[2]}` : 'offline:Qwen2.5-1.5B';
      if (!offlineModelId(model)) return `未知离线模型：${model}（可选 Qwen2.5-1.5B / Qwen2.5-3B）`;
      // 波 2 ⑪：缺模型即拉取 + 进度回报（codex ensure_oss_ready/pull_with_reporter 对标）
      const r = await ensureOfflineModelReady(model, progressNotice(model));
      return r.already ? r.message : r.message;
    }
    if (sub === 'pack' && args[1] === 'dir') {
      return `模型缓存：${resolveDataDir(process.cwd())}（WXNODUS_DATA_DIR 可改）`;
    }
    if (sub === 'on') {
      const { MODEL_CATALOG } = await import('../../kernel/providers.js');
      const hit = MODEL_CATALOG.find(m => m.modelId === 'offline:Qwen2.5-1.5B');
      if (hit) ctx.setModel(hit.modelId, hit.baseURL);
      // 波 2 ⑪：切完即自动就绪（codex ensure_oss_ready 对标——缺模型即拉取，零门槛离线）
      const r = await ensureOfflineModelReady('offline:Qwen2.5-1.5B', progressNotice('offline:Qwen2.5-1.5B'));
      if (!r.ok) return `已切换离线模型：Qwen2.5-1.5B（本地）——但模型下载失败：${r.message}（重试 /offline pack download）`;
      return r.already
        ? '已切换离线模型：Qwen2.5-1.5B（本地）——对话断网可用'
        : `已切换离线模型：Qwen2.5-1.5B（本地）——${r.message}`;
    }
    return lines(' 离线 token 包 ', [
      ' 用法：',
      '  /offline pack status                — 组件就绪状态 + 缓存占用',
      '  /offline pack download [模型]       — 预下载文本 LLM（默认 Qwen2.5-1.5B）',
      '  /offline pack dir                   — 模型缓存路径',
      '  /offline on                         — 切换离线模型（=/model 离线 Qwen2.5-1.5B）',
      ` 边界：无工具调用、1.5B 质量有限、CPU ~15-30 tok/s——对话/规格化/摘要可用`,
    ]);
  });

  // /undo：轮级回滚（机制补强）——撤销最近 N 轮（默认 1 轮），撤销前自动保存 checkpoint  //   F20 修复：软撤销（UPDATE archived=1 而非 DELETE——recall 全量永不丢，黑洞可检索）；
  //   快照含完整字段（id/archived/ts），restore 才能重建原始状态
  //   对比轮 6 补强：/undo list 列出可撤销轮次（时间 + 首句）
  // 波 3 ③：/diff <文件> [revert <hunk序号>]——快照 vs 当前文件的完整 diff 查看 +
  // per-hunk 选择性回滚（六家皆无的差异化：opencode diff-viewer 仅跳转无 apply/discard；
  // 回滚前自动快照——/undo fs restore 可再滚回）
  // P3 评估轮：三源扩展（opencode diff-viewer.tsx:46 git|branch|last-turn 对标）——
  // turn（默认，快照 vs 当前）/ git（工作区 vs HEAD）/ branch <分支名>（工作区 vs 分支）；
  // revert 仅 turn 源可用（git 源改动在 git 侧管理，诚实边界）
  bus.register('/diff', async (args) => {
    const rel = String(args[0] ?? '').trim();
    if (!rel) return '用法：/diff <文件> [turn|git|branch <分支名>|revert <hunk序号>]——turn（默认）快照 vs 当前；git 工作区 vs HEAD；branch 工作区 vs 指定分支；revert 按 hunk 序号选择性回滚（仅 turn 源）';
    const abs = resolve(ctx.cwd, rel);
    const source = String(args[1] ?? '').toLowerCase();
    if (source === 'git' || source === 'branch') {
      try {
        const { gitDiffWorkingVsHead, gitDiffVsBranch } = await import('../../kernel/gitDiff.js');
        if (source === 'branch') {
          const b = String(args[2] ?? '').trim();
          if (!b) return '用法：/diff <文件> branch <分支名>（工作区 vs 该分支同名文件）';
          const r = gitDiffVsBranch(ctx.cwd, abs, b);
          if (!r.ok) return `diff 失败：${r.error}`;
          if (!r.diff) return `${rel} 与分支 ${b} 无差异`;
          return `工作区 → 分支 ${b}（${rel}）
${r.diff}`;
        }
        const r = gitDiffWorkingVsHead(ctx.cwd, abs);
        if (!r.ok) return `diff 失败：${r.error}`;
        if (!r.diff) return `${rel} 工作区与 HEAD 无差异`;
        return `工作区 → HEAD（${rel}）
${r.diff}`;
      } catch (e: any) { return `diff 失败：${String(e?.message ?? e).slice(0, 120)}`; }
    }
    if (source && source !== 'turn' && source !== 'revert') {
      return '未知 diff 源——支持：turn（默认）/ git / branch <分支名> / revert <hunk序号>';
    }
    try {
      const cur = readFileSync(abs, 'utf8');
      const versions = versionsOfFile(ctx.dataDir, abs);
      if (!versions.length) return '该文件无编辑快照（undoShadows 为空）——turn 源需要先经 fs_edit/fs_write 编辑过才有对比基线（git 源可用 /diff <文件> git）';
      const base = versions[0]!.content;
      if (args[1] === 'revert') {
        const idx = Number(args[2]);
        if (!Number.isInteger(idx) || idx < 1) return '用法：/diff <文件> revert <hunk序号>（序号见 /diff <文件> 输出的 @@ 顺序，从 1 起）';
        const hunks = parseHunks(lineDiff(base, cur));
        const h = hunks[idx - 1];
        if (!h) return `hunk ${idx} 不存在（共 ${hunks.length} 个）`;
        const r = applyHunkToText(cur, reverseHunk(h));
        if (!r.ok) return `回滚失败：${r.error}`;
        snapshotFile(ctx.dataDir, abs, cur);
        writeFileSync(abs, r.text, 'utf8');
        return `已回滚 hunk ${idx}/${hunks.length}（${rel}）——快照已留存，/undo fs restore 可再滚回`;
      }
      const d = lineDiff(base, cur);
      if (!d) return `${rel} 与快照无差异`;
      return `快照 → 当前（${rel}）
${d}

（/diff ${rel} revert <hunk序号> 选择性回滚某个 hunk；git 源：/diff ${rel} git）`;
    } catch (e: any) { return `diff 失败：${String(e?.message ?? e).slice(0, 120)}`; }
  });

  bus.register('/undo', (args) => {
    // /undo fs：文件编辑影子快照（Aider /undo 精神的零 git 依赖版）——
    // fs_write/fs_edit 覆盖前自动备份，/undo fs list｜restore 安全撤销文件编辑
    if (args[0] === 'fs') {
      const sub = args[1];
      if (sub === 'list') {
        const shadows = listShadows(ctx.dataDir);
        if (!shadows.length) return '无文件快照——fs_write/fs_edit 编辑文件前自动生成（/undo fs restore <编号> 恢复）';
        return lines(' 文件快照（/undo fs restore <编号>） ', shadows.slice(0, 20).map((s, i) => {
          // 相对路径展示：去 cwd 前缀 + 开头分隔符（Windows 下 slice 残留反斜杠）
          const rel = s.path.startsWith(ctx.cwd) ? s.path.slice(ctx.cwd.length).replace(/^[\\/]/, '') : s.path;
          return ` #${i + 1}  ${new Date(s.ts).toLocaleString('zh-CN', { hour12: false })}  ${rel}（${s.content.length} 字符）`;
        }));
      }
      if (sub === 'restore') {
        const id = args[2] ?? '1';
        return restoreShadow(ctx.dataDir, id).message;
      }
      return '用法：/undo fs list｜restore [编号]（fs_write/fs_edit 编辑文件前自动快照）';
    }
    // M4 修复：定位当前会话（UI 多会话切换后 /undo 作用于活跃会话）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    const msgs = ctx.db.prepare(`SELECT id, role, content, ts, run_no FROM messages WHERE session_id=? AND role!='system' AND archived=0 ORDER BY id`).all(sid) as Array<{ id: number; role: string; content: string; ts: number; run_no: number }>;
    if (!msgs.length) return '没有可撤销的消息';
    // 架构（V3）：按 run_no 定位用户轮次（跨压缩稳定——压缩归档旧轮次后编号不变；
    // 旧数据 run_no=0 回退按消息下标定位）
    const userRuns: number[] = [];
    for (const m of msgs) {
      if (m.role === 'user' && m.run_no > 0) {
        if (!userRuns.includes(m.run_no)) userRuns.push(m.run_no);
      }
    }
    const fallbackUserIdx: number[] = [];
    msgs.forEach((m, i) => { if (m.role === 'user' && m.run_no === 0) fallbackUserIdx.push(i); });
    if (args[0] === 'list') {
      // 最近 5 个用户轮次（倒序展示）
      const recent = userRuns.length ? userRuns.slice(-5).reverse() : fallbackUserIdx.slice(-5).reverse();
      return lines(' 可撤销轮次（/undo <n> 撤销） ', recent.map((runOrIdx, k) => {
        const m = userRuns.length
          ? msgs.find(x => x.run_no === runOrIdx && x.role === 'user')
          : msgs[runOrIdx as number];
        if (!m) return ` #${k + 1}  （不可用）`;
        const firstLine = String(m.content ?? '').split('\n')[0]!.slice(0, 30);
        return ` #${k + 1}  ${new Date(m.ts).toLocaleString('zh-CN', { hour12: false })}  ${firstLine}`;
      }));
    }
    const n = parseInt(args[0] ?? '1', 10);
    if (!Number.isFinite(n) || n < 1 || n > 20) return '用法：/undo [轮次数 1-20] ｜ /undo list 查看可撤销轮次';
    // 目标轮次定位：run_no 优先（压缩后仍精确）；旧数据回退消息下标
    const targetRun = userRuns.length ? userRuns[Math.max(0, userRuns.length - n)] : null;
    const target = targetRun
      ? msgs.findIndex(m => m.run_no === targetRun && m.role === 'user')
      : fallbackUserIdx.length ? fallbackUserIdx[Math.max(0, fallbackUserIdx.length - n)] : undefined;
    // 审查修复（P3）：无任何 user 消息时 target=undefined → slice(undefined)=slice(0) 整会话被归档
    if (target === undefined || target < 0) return '没有可撤销的用户轮次（会话中无 user 消息）';
    // 撤销前自动快照（F20：完整字段 id/archived/ts，restore 保留原始 id 与黑洞状态）
    try {
      const full = ctx.db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? AND role!='system' ORDER BY id`).all(sid);
      saveCheckpoint(ctx.db, sid, { kind: 'undo-snapshot', messages: full, ts: Date.now() });
    } catch { /* 快照失败不阻断 */ }
    const dropIds = msgs.slice(target).map(m => m.id);
    if (!dropIds.length) return '没有可撤销的消息';
    // F20：软撤销——归档而非删除（recall 全量仍可检索，working 窗口回退）
    ctx.db.prepare(`UPDATE messages SET archived=1 WHERE id IN (${dropIds.map(() => '?').join(',')})`).run(...dropIds);
    return `已撤销 ${n} 轮（${dropIds.length} 条消息移入历史存档，仍可检索）——/checkpoint restore 可恢复到撤销前`;
  });

  // /versions：文件时间机器——同一文件的快照链即版本时间线（/undo fs 数据源复用）
  bus.register('/versions', (args) => {
    const target = args[0];
    if (!target) return '用法：/versions <文件>（列出该文件的历史版本）｜/versions restore <文件> <版本号>（回滚到指定版本）';
    const abs = resolve(ctx.cwd, target);
    const all = versionsOfFile(ctx.dataDir, abs);
    if (args[0] === 'restore') {
      const fileArg = args[1];
      const idx = Number(args[2] ?? 1);
      if (!fileArg || !Number.isInteger(idx) || idx < 1) return '用法：/versions restore <文件> <版本号 1=最新>';
      const versions = versionsOfFile(ctx.dataDir, resolve(ctx.cwd, fileArg));
      const v = versions[idx - 1];
      if (!v) return `文件「${fileArg}」共 ${versions.length} 个版本（版本号超范围）`;
      const r = restoreShadow(ctx.dataDir, v.id);
      return r.message;
    }
    const rel = abs.startsWith(ctx.cwd) ? abs.slice(ctx.cwd.length).replace(/^[\\/]/, '') : abs;
    if (!all.length) return `「${rel}」暂无版本记录（fs_write/fs_edit 编辑前自动快照；/snapshot <目录> 可手动建档）`;
    return lines(` 版本时间线「${rel}」`, all.map((v, i) => {
      return ` #${i + 1}  ${new Date(v.ts).toLocaleString('zh-CN', { hour12: false })}  ${v.content.length} 字符${i === 0 ? '（最新）' : ''}`;
    }));
  });

  // /snapshot：目录级快照——整目录文本文件建档，可一键整体回滚
  bus.register('/snapshot', (args) => {
    if (args[0] === 'list') {
      const shadows = listShadows(ctx.dataDir);
      const byDir = new Map<string, number>();
      for (const s of shadows) {
        const d = s.path.startsWith(ctx.cwd) ? dirname(s.path).slice(ctx.cwd.length) : s.path;
        byDir.set(d, (byDir.get(d) ?? 0) + 1);
      }
      if (!byDir.size) return '无快照（/undo fs 编辑文件前自动生成；/snapshot <目录> 手动建档）';
      return lines(' 快照分布（/undo fs list 看明细） ', [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([d, n]) => ` ${d}（${n} 份）`));
    }
    if (args[0] === 'restore') {
      const dir = args[1] ? resolve(ctx.cwd, args[1]) : ctx.cwd;
      const r = restoreDirShadows(ctx.dataDir, dir);
      if (!r.ok && !r.failed.length) return `「${dir}」无快照可恢复`;
      return `已恢复 ${r.ok} 个文件${r.failed.length ? `，失败 ${r.failed.length} 个：${r.failed.slice(0, 3).join('; ')}` : ''}`;
    }
    const dir = args[0] ? resolve(ctx.cwd, args[0]) : ctx.cwd;
    const r = snapshotDir(ctx.dataDir, dir);
    if (!r.count) return `「${dir}」无可快照文本文件（${r.skipped.length} 个跳过：二进制/超大/空）`;
    return lines(' 目录快照 ', [
      ` 已建档：${r.count} 个文本文件`,
      ` 跳过：${r.skipped.length} 个（二进制/超大/空/忽略目录）`,
      ` 回滚：/snapshot restore ${args[0] ?? '.'}（整体恢复到建档时刻）`,
    ]);
  });

  // /script：可执行剧本（开放兼容——会话 → 可重放脚本，跳过 AI 决策确定性执行）
  //   record <名> [描述]：开始录制（此后每轮用户输入 + 工具调用序列进剧本）
  //   stop：结束录制并保存 ｜ list ｜ show <名> ｜ run <名> ｜ dry-run <名> ｜ rm <名>
  bus.register('/script', async (args) => {
    const [sub, ...rest] = args;
    if (!sub || sub === 'list') {
      const scripts = listScripts(ctx.dataDir);
      if (!scripts.length) return '暂无剧本——/script record <名称> [描述] 开始录制（录制中的对话工具调用将进剧本）';
      return lines(' 剧本 ', scripts.map(s => {
        const st = scriptStats(s);
        return ` ${s.auto ? '⭯' : ' '} ${s.name}（${st.steps} 轮 / ${st.tools} 次工具调用）${s.auto ? '·自动回归 ' : ''}${s.description ? '· ' + s.description.slice(0, 40) : ''}`;
      }));
    }
    if (sub === 'record') {
      const name = rest[0];
      if (!name) return '用法：/script record <名称> [描述]——此后对话的工具调用序列将被录制';
      if (!isValidScriptName(name)) return '剧本名非法（仅字母/数字/_/-，≤40 字符）';
      if (scriptRecording) return `已在录制（${scriptRecording.name}）——先 /script stop`;
      // 每轮对话开始（agent.start）→ 新 step（用户输入入册）；工具调用由 recorder 归集
      const offStart = ctx.bus.on('agent.start', (e: any) => {
        if (scriptRecording) {
          scriptRecording.current = { prompt: String(e?.payload?.prompt ?? ''), tools: [] };
          scriptRecording.buffer.push(scriptRecording.current);
        }
      });
      scriptRecording = { name, description: rest.slice(1).join(' ') || `${name} 剧本`, buffer: [], current: null, offStart };
      ctx.agent?.setScriptRecorder?.((toolName, toolArgs) => {
        if (scriptRecording?.current) scriptRecording.current.tools.push({ name: toolName, args: toolArgs });
      });
      return `开始录制剧本「${name}」——下一轮对话起工具调用序列入册；/script stop 保存`;
    }
    if (sub === 'stop') {
      if (!scriptRecording) return '当前未在录制——/script record <名称> 开始';
      const rec = scriptRecording;
      scriptRecording = null;
      try { rec.offStart?.(); } catch { /* 忽略 */ }
      ctx.agent?.setScriptRecorder?.(null);
      const script: Script = {
        name: rec.name,
        description: rec.description,
        created_at: Date.now(),
        steps: rec.buffer.filter(s => s.prompt.trim() || s.tools.length),
      };
      if (!script.steps.length) return `剧本「${rec.name}」为空——录制期间没有对话轮次`;
      if (!saveScript(ctx.dataDir, script)) return '保存失败（数据目录不可写？）';
      const st = scriptStats(script);
      return `剧本已保存：${script.name}（${st.steps} 轮 / ${st.tools} 次工具调用）——/script run ${script.name} 重放`;
    }
    // 变更即回归开关：watch 标记 auto=true → fs_write/fs_edit 修改文件后自动重放
    if (sub === 'watch') {
      if (rest[0] === 'list') {
        const autos = listScripts(ctx.dataDir).filter(s => s.auto === true);
        if (!autos.length) return '无自动回归剧本——/script watch <名> 开启（fs_write/fs_edit 后自动重放）';
        return lines(' 自动回归剧本（文件变更后自动重放） ', autos.map(s => ` ⭯ ${s.name}${s.description ? ' · ' + s.description.slice(0, 40) : ''}`));
      }
      const [mode, name] = (rest[0] === 'on' || rest[0] === 'off') ? [rest[0], rest[1]] : [undefined, rest[0]];
      if (!name) return '用法：/script watch <名> ｜ on|off <名> ｜ list';
      const sc = loadScript(ctx.dataDir, name);
      if (!sc) return `剧本不存在：${name}（/script list 查看）`;
      const on = mode ? mode === 'on' : !sc.auto;
      sc.auto = on || undefined; // 关闭时清字段（undefined 不落盘）
      if (!saveScript(ctx.dataDir, sc)) return `保存失败（数据目录不可写？）：${name}`;
      return on
        ? `已开启自动回归：${name}——此后 fs_write/fs_edit 修改文件将自动重放该剧本（2s 防抖合并；/script watch list 查看）`
        : `已关闭自动回归：${name}`;
    }
    const name = rest[0];
    if (!name) return '用法：/script record <名> ｜ stop ｜ list ｜ show <名> ｜ run <名> ｜ dry-run <名> ｜ watch <名> ｜ rm <名>';
    const script = loadScript(ctx.dataDir, name);
    if (!script) return `剧本不存在：${name}（/script list 查看）`;
    if (sub === 'show') {
      return lines(` 剧本「${script.name}」 `, [
        ` 描述：${script.description || '（无）'} · 创建：${new Date(script.created_at).toLocaleString('zh-CN', { hour12: false })}`,
        ...script.steps.flatMap((s, i) => [
          ` #${i + 1} ❯ ${s.prompt.slice(0, 50) || '（无输入，纯工具轮）'}`,
          ...s.tools.map(t => `    ⚡ ${t.name} ${JSON.stringify(t.args ?? {}).slice(0, 80)}`),
        ]),
      ]);
    }
    if (sub === 'dry-run') {
      const st = scriptStats(script);
      return lines(` 剧本 dry-run「${script.name}」 `, [
        ` 将执行：${st.steps} 轮输入 + ${st.tools} 次工具调用（跳过 AI 决策，确定性重放）`,
        ...script.steps.flatMap((s, i) => [
          ` #${i + 1} ❯ ${s.prompt.slice(0, 50) || '（无输入）'}`,
          ...s.tools.map(t => `    ⚡ ${t.name} ${JSON.stringify(t.args ?? {}).slice(0, 80)}`),
        ]),
        ` 确认执行：/script run ${name}`,
      ]);
    }
    if (sub === 'rm') {
      return deleteScript(ctx.dataDir, name) ? `剧本已删除：${name}` : `删除失败（不存在或无权限）：${name}`;
    }
    if (sub === 'run') {
      if (!ctx.agent?.runScript) return '当前环境不支持剧本重放（agent 未装配）';
      const r = await ctx.agent.runScript(script.steps);
      if (!r.ok) return '剧本执行中断（工具异常）——查看上方执行日志';
      const st = scriptStats(script);
      return lines(` 剧本执行完成「${script.name}」 `, [
        ` 重放：${st.steps} 轮 / ${st.tools} 次工具调用（确定性执行，无 AI 决策）`,
        ...r.log.filter(l => l.kind !== 'result').map(l => ` ${l.kind === 'prompt' ? '❯' : '⚡'} ${l.text.slice(0, 80)}`),
        ` 结果已写入会话记忆（/memory 可检索）`,
      ]);
    }
    // 回放 CI（审计扩展）：重放 + 断言校验——剧本带 expect 断言时输出 pass/fail 报告
    if (sub === 'verify' || sub === 'ci') {
      if (sub === 'ci') {
        // 回归套件：遍历全部剧本逐个验证，汇总报告
        const scripts = listScripts(ctx.dataDir);
        if (!scripts.length) return '无剧本可验证（/script record 录制后 /script ci 作回归套件）';
        const reports: string[] = [];
        let passed = 0;
        for (const sc of scripts) {
          const r = await runScriptVerify(ctx, sc);
          if (r.allOk) passed++;
          reports.push(` ${r.allOk ? '✅' : '❌'} ${sc.name}（${r.assertions.length} 项断言，${r.assertions.filter(a => a.ok).length} 通过）`);
        }
        return lines(` 回归套件 ${passed}/${scripts.length} 通过 `, [
          ...reports,
          ` 全部通过时输出可作为发布门禁（/self-evolve 自举验证复用）`,
        ]);
      }
      const r = await runScriptVerify(ctx, script);
      return lines(` 剧本验证「${script.name}」${r.allOk ? '✅ 通过' : '❌ 失败'} `, [
        ...r.assertions.map(a => ` ${a.ok ? '✓' : '✗'} ${a.label}${a.detail ? ' —— ' + a.detail : ''}`),
        ...(r.assertions.length ? [] : [` （无断言——录制时或手工编辑剧本添加 expect 字段启用回放 CI）`]),
      ]);
    }
    return '用法：/script record <名> ｜ stop ｜ list ｜ show <名> ｜ run <名> ｜ verify <名> ｜ ci ｜ dry-run <名> ｜ watch <名> ｜ rm <名>';
  });

  // 回放 CI 执行器（verify/ci 共用）：重放 → 按步骤收集输出 → 断言检查
  async function runScriptVerify(ctx: HandlerCtx, sc: Script): Promise<{ allOk: boolean; assertions: Array<{ ok: boolean; label: string; detail?: string }> }> {
    if (!ctx.agent?.runScript) return { allOk: false, assertions: [{ ok: false, label: 'agent 未装配', detail: '无法重放' }] };
    const r = await ctx.agent.runScript(sc.steps);
    const outputs = r.log.filter(l => l.kind === 'result').map(l => ({ step: l.step, tool: l.name ?? '', out: l.text }));
    const assertions = checkScriptExpectations(sc, outputs);
    return { allOk: r.ok && assertions.every(a => a.ok), assertions };
  }

  // /fork：复制当前会话（含全部消息）为分支会话（记血缘 forked_from_id——codex 对齐）；
  //   /fork lineage [id] 打印祖先链
  bus.register('/fork', (args) => {
    if (args[0] === 'lineage') {
      const sid = args[1] ?? ctx.agent?.getSessionId?.() ?? 'default';
      const chain = sessionLineage(ctx.db, sid);
      return chain.length
        ? lines(' 血缘 ', chain.map((id, i) => ` ${i === chain.length - 1 ? '●' : '○'} ${id}${i === 0 ? '（根）' : ''}`))
        : `会话不存在：${sid}`;
    }
    const target = args[0] ?? ctx.agent?.getSessionId?.() ?? 'default';
    const newId = `s${Date.now()}f`;
    const r = forkSession(ctx.db, target, newId);
    if (!r.ok) return r.error ?? 'fork 失败';
    return `已分支会话 ${target} → ${newId}（${r.msgCount} 条消息，血缘已记录——/fork lineage ${newId} 查看）`;
  });

  // /checkpoint：会话快照（机制补强——激活既有 checkpoints 表）
  //   save 手动快照 ｜ list 列表 ｜ restore [id] 恢复消息 ｜ clear 清空
  bus.register('/checkpoint', (args) => {
    const [sub, ...rest] = args;
    // 审查修复：会话统一——作用于当前会话
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    if (!sub || sub === 'list') {
      const rows = ctx.db.prepare(`SELECT id, data, ts FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 10`).all(sid) as Array<{ id: number; data: string; ts: number }>;
      if (!rows.length) return '暂无快照——/checkpoint save 保存，/undo 撤销前自动保存';
      return lines(' 快照 ', rows.map(r => {
        const d = JSON.parse(r.data) as { kind?: string; messages?: unknown[] };
        const n = Array.isArray(d.messages) ? d.messages.length : 0;
        return ` #${r.id} ${d.kind ?? 'checkpoint'}（${n} 条消息）${new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}`;
      }));
    }
    if (sub === 'save') {
      // F20：快照含完整字段（id/archived/ts），restore 保留原始 id 与黑洞状态
      const msgs = ctx.db.prepare(`SELECT id, role, content, tool_call_id, archived, ts FROM messages WHERE session_id=? ORDER BY id`).all(sid);
      const id = saveCheckpoint(ctx.db, sid, { kind: 'manual', messages: msgs, ts: Date.now() });
      return `已保存快照 #${id}（${(msgs as unknown[]).length} 条消息）`;
    }
    if (sub === 'restore') {
      const id = rest[0];
      const row = id
        ? ctx.db.prepare(`SELECT data FROM checkpoints WHERE id=? AND session_id=?`).get(id, sid) as { data: string } | undefined
        : ctx.db.prepare(`SELECT data FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(sid) as { data: string } | undefined;
      if (!row) return `未找到快照${id ? ` #${id}` : ''}`;
      const d = JSON.parse(row.data) as { messages?: Array<{ id?: number; role: string; content: string; tool_call_id?: string | null; archived?: number; ts?: number }> };
      if (!Array.isArray(d.messages)) return '快照数据不完整';
      // A25：统一恢复函数——清理 FTS 旧行 + 重置 AUTOINCREMENT 序列再重插
      // （此前手写 DELETE+重插：FTS5 触发器使同 rowid 重插 constraint failed）
      replaceSessionMessages(ctx.db, sid, d.messages);
      return `已从快照${id ? ` #${id}` : ''}恢复 ${d.messages.length} 条消息（保留原始 id/archived）`;
    }
    if (sub === 'compare') {
      // P1-4：快照 vs 当前三态对比（Claude Code checkpoint 三态语义补全）——
      // 新增/删除/修改条数 + 变更预览，恢复前先看差异
      const id = rest[0];
      const row = id
        ? ctx.db.prepare(`SELECT data FROM checkpoints WHERE id=? AND session_id=?`).get(id, sid) as { data: string } | undefined
        : ctx.db.prepare(`SELECT data FROM checkpoints WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(sid) as { data: string } | undefined;
      if (!row) return `未找到快照${id ? ` #${id}` : ''}（/checkpoint list 查看）`;
      const snap = JSON.parse(row.data) as { kind?: string; messages?: Array<{ id?: number; role: string; content: string; archived?: number }> };
      if (!Array.isArray(snap.messages)) return '快照数据不完整';
      const cur = ctx.db.prepare(`SELECT id, role, content, archived FROM messages WHERE session_id=? ORDER BY id`).all(sid) as Array<{ id: number; role: string; content: string; archived: number }>;
      const snapById = new Map(snap.messages.map(m => [m.id, m]));
      const curById = new Map(cur.map(m => [m.id, m]));
      const added: Array<{ id: number; content: string }> = [];
      const removed: Array<{ id?: number; content?: string }> = [];
      const modified: Array<{ id: number; from: string; to: string }> = [];
      for (const c of cur) {
        if (!snapById.has(c.id)) added.push({ id: c.id, content: c.content });
      }
      for (const s of snap.messages) {
        if (!curById.has(s.id!)) removed.push({ id: s.id, content: s.content });
      }
      for (const s of snap.messages) {
        const c = curById.get(s.id!);
        if (c && (c.content !== s.content || c.archived !== (s.archived ?? 0))) {
          modified.push({ id: s.id!, from: String(s.content ?? '').slice(0, 40), to: String(c.content ?? '').slice(0, 40) });
        }
      }
      const preview = (list: Array<{ id?: number; content?: string }>, n: number) =>
        list.slice(0, n).map(x => ` #${x.id} ${String(x.content ?? '').slice(0, 50)}`).join('\n');
      return lines(` 快照对比 #${id ?? '最新'}（${snap.kind ?? 'checkpoint'}） `, [
        ` 新增 ${added.length} 条｜删除 ${removed.length} 条｜修改 ${modified.length} 条（快照 ${snap.messages.length} → 当前 ${cur.length}）`,
        added.length ? `— 新增预览 —\n${preview(added, 5)}` : '',
        removed.length ? `— 删除预览 —\n${preview(removed, 5)}` : '',
        modified.length ? `— 修改预览 —\n${modified.map(m => ` #${m.id} ${m.from} → ${m.to}`).slice(0, 5).join('\n')}` : '',
        ` 恢复：/checkpoint restore ${id ?? ''}`.trim(),
      ]);
    }
    if (sub === 'clear') {
      ctx.db.prepare(`DELETE FROM checkpoints WHERE session_id=?`).run(sid);
      return '已清空全部快照';
    }
    return '用法：/checkpoint save｜list｜restore [id]｜clear';
  });


  // /reload-skills：重扫技能目录（含跨品牌 .claude/.agents/.codex/.gemini），汇报统计
  bus.register('/reload-skills', () => {
    const list = discoverSkills(ctx.dataDir, ctx.cwd);
    if (!list.length) return '未发现技能（目录：.wxnodus/skills、.claude/.agents/.codex/.gemini/skills、data/skills、forge 产物）';
    const bySource = new Map<string, number>();
    for (const s of list) bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
    const summary = [...bySource.entries()].map(([k, n]) => `${k}:${n}`).join(' ');
    return lines(' 技能已重载 ', [
      ...list.slice(0, 20).map(s => ` ${s.name}（${s.source}${s.description ? `：${s.description.slice(0, 40)}` : ''}）`),
      ` 共 ${list.length} 个（${summary}）`,
    ]);
  });

  // /map：仓库地图（aider repo-map 自研版）——/map [token 预算]
  bus.register('/map', (args) => {
    const budget = Math.max(100, Math.floor(Number(args[0]) || 2000));
    const r = buildRepoMap(ctx.cwd, { budgetTokens: budget });
    return `${r.map}\n（扫描 ${r.scanned} 文件，跳过 ${r.skipped}，预算 ${budget} tokens）`;
  });

  // /init：本地扫描项目生成 AGENTS.md（确定性数据；--overwrite 覆盖）
  bus.register('/init', (args) => {
    const overwrite = args.includes('--overwrite');
    const target = join(ctx.cwd, 'AGENTS.md');
    if (existsSync(target) && !overwrite) {
      return `AGENTS.md 已存在（用 /init --overwrite 重新生成）——现有内容：\n${readFileSync(target, 'utf8').slice(0, 200)}`;
    }
    const profile = scanProject(ctx.cwd);
    writeFileSync(target, renderAgentsMd(profile), 'utf8');
    return `已生成 ${target}（项目类型：${profile.type}，顶层 ${profile.structure.length} 项）`;
  });

  bus.register('/usage', (args) => {
    // 分区间 token（状态栏 📊 同源）：/usage range <today|7d|30d> 跨会话聚合 + 持久化
    if (args[0] === 'range') {
      const range = args[1];
      if (range !== 'today' && range !== '7d' && range !== '30d') {
        return '用法：/usage range <today|7d|30d>（状态栏 📊 段点击可循环切换）';
      }
      ctx.config.setKey('settings', 'usageRange', range);
      const s = usageSummary(ctx.db, range as UsageRange);
      // 区间成本估算（与 /cost 同源——顺带知晓区间花费）
      const q = rangeCost(ctx.db, usageRangeSince(range as UsageRange), (ctx.config.get('settings') as Record<string, any>)?.costPrices);
      const costNote = q ? ` · ≈${costText(q)}` : '';
      const unmeasuredNote = s.unmeasured > 0 ? `，其中 ${s.unmeasured} 次端点未上报用量（不计入 token）` : '';
      const cacheNote = s.cacheHit > 0
        ? ` · 前缀缓存命中 ${s.cacheHit.toLocaleString()} token（${(s.cacheHit / Math.max(1, s.cacheHit + s.cacheMiss) * 100).toFixed(0)}%）`
        : '';
      return `token 区间已切换：${range}——累计 ${s.total.toLocaleString()} token（入 ${s.input.toLocaleString()} / 出 ${s.output.toLocaleString()} / ${s.calls} 次调用，跨全部会话）${unmeasuredNote}${cacheNote}${costNote}`;
    }
    // B2 修复：定位当前活跃会话（不再硬编码 'default'）+ 真实 token 统计（usage_stats）
    const sid = ctx.agent?.getSessionId?.() ?? 'default';
    const real = ctx.db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(input_tokens),0) AS it, COALESCE(SUM(output_tokens),0) AS ot, COUNT(DISTINCT model) AS models FROM usage_stats WHERE session_id=?`
    ).get(sid) as { c: number; it: number; ot: number; models: number };

    // --waterfall [today|7d|30d]：每次 API 调用（轮）的 token 瀑布——input ░ / output █ 横向条形
    // （默认本会话最近 12 轮；带区间参数 → 跨会话该区间最近 12 轮）
    if (args[0] === '--waterfall') {
      const range = args[1];
      const scoped = range === 'today' || range === '7d' || range === '30d';
      const rows = scoped
        ? ctx.db.prepare(
            `SELECT model, input_tokens, output_tokens, ts FROM usage_stats WHERE ts >= ? ORDER BY id DESC LIMIT 12`
          ).all(usageRangeSince(range as UsageRange)) as Array<{ model: string; input_tokens: number; output_tokens: number; ts: number }>
        : ctx.db.prepare(
            `SELECT model, input_tokens, output_tokens, ts FROM usage_stats WHERE session_id=? ORDER BY id DESC LIMIT 12`
          ).all(sid) as Array<{ model: string; input_tokens: number; output_tokens: number; ts: number }>;
      if (!rows.length) return '暂无 API 用量记录（--waterfall 需真实调用后查看；当前会话消息 token 可看 /context）';
      const scopeLabel = scoped ? (range === 'today' ? '今日' : range === '7d' ? '近 7 天' : '近 30 天') : '本会话';
      // 行尾成本估算（参考价目 + costPrices 覆盖；未收录定价不显示）
      const overrides = (ctx.config.get('settings') as Record<string, any>)?.costPrices;
      const priceFor = (model: string, i: number, o: number) => estimateCost(model, i, o, overrides);
      return renderWaterfall(rows.reverse(), 40, ` Token 瀑布（${scopeLabel}最近 ${rows.length} 轮 · ░输入 █输出 · ≈$ 估算成本） `, priceFor);
    }

    const rows = ctx.db.prepare(`SELECT role, content FROM messages WHERE session_id=?`).all(sid) as any[];
    const est = rows.reduce((a, r) => a + estimateTokens(r.content), 0);
    const realTotal = real.it + real.ot;
    // 端点未上报用量的调用（0 token 行）单独计数——诚实告知 token 可能被低估
    const unmeasured = ctx.db.prepare(`SELECT COUNT(*) c FROM usage_stats WHERE session_id=? AND input_tokens=0 AND output_tokens=0`).get(sid) as { c: number };
    const tokenLine = real.c > 0
      ? ` 实际 Token：${c(realTotal.toLocaleString(), '36')}（输入 ${real.it.toLocaleString()} / 输出 ${real.ot.toLocaleString()}，${real.models} 个模型${unmeasured.c > 0 ? `；${unmeasured.c} 次调用未上报用量` : ''}）`
      : ` Token：约 ${est.toLocaleString()}（本地估算，尚无 API 用量记录）`;
    return lines(' 用量 ', [
      ` 会话：${sid.slice(0, 12)}…`,
      ` 消息：${c(`${rows.length} 条`, '36')}`,
      tokenLine,
      ` 成本：/cost 估算（参考公开价目）`,
      ` 瀑布：/usage --waterfall（最近 12 轮 input/output 条形图）`,
    ]);
  });

  // /cost：会话/区间成本估算（#11 债尾项——会话级 $ 成本；诚实口径：参考价目 + 未收录模型只报 token）
  bus.register('/cost', (args) => {
    const range = args[0];
    const overrides = (ctx.config.get('settings') as Record<string, any>)?.costPrices;
    let scopeLabel = '';
    let q: CostQueryResult | null = null;
    if (range === 'today' || range === '7d' || range === '30d') {
      q = rangeCost(ctx.db, usageRangeSince(range as UsageRange), overrides);
      scopeLabel = range === 'today' ? '今日' : range === '7d' ? '近 7 天' : '近 30 天';
    } else if (range === 'session' || !range) {
      const sid = ctx.agent?.getSessionId?.() ?? 'default';
      q = sessionCost(ctx.db, sid, overrides);
      scopeLabel = `会话 ${sid.slice(0, 12)}…`;
    } else {
      return '用法：/cost [session|today|7d|30d]（默认当前会话；估算按公开参考价目，非实际账单）';
    }
    if (!q) return `暂无 API 用量记录（${scopeLabel}）——真实对话后才有成本数据`;
    const fmtUsd = (n: number | null) => (n === null ? '未收录定价' : n === 0 ? '$0（免费/离线）' : `$${n.toFixed(4)}`);
    const body = [
      ` 范围：${scopeLabel}`,
      ` 用量：入 ${q.tokens.input.toLocaleString()} / 出 ${q.tokens.output.toLocaleString()} / 共 ${q.tokens.total.toLocaleString()} token（${q.models} 个模型）`,
      ...q.rows.map(r => ` ${r.model.slice(0, 22).padEnd(22)} 入 ${r.input.toLocaleString().padStart(8)} / 出 ${r.output.toLocaleString().padStart(8)} → ${fmtUsd(r.usd)}`),
      ` 合计（估算）：$${q.usd.toFixed(4)}${q.unknown ? `（另有 ${q.unknown} 个模型未收录定价，仅计 token）` : ''}`,
      ` 注：参考公开价目估算，非实际账单；/usage 看 token 明细`,
    ];
    return lines(' 成本估算 ', body);
  });

}
