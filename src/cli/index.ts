#!/usr/bin/env node
// src/cli/index.ts — L6-2 CLI 入口（commander + 交互 TUI 装配）
// 装配：data/config/db/mem/bus/agent → Bridge 接线 → 命令注册 → render App
import { Command } from 'commander';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const VERSION = '3.0.0';
const program = new Command();
program.name('wxnodus').version(VERSION).description('WxNodus V3 — 本地概念编译器 CLI');
program.option('-p, --prompt <text>', '非交互单次执行');
program.parse(process.argv);
const opts = program.opts();

async function main() {
  const cwd = process.cwd();
  const dataDir = join(cwd, 'data');
  mkdirSync(dataDir, { recursive: true });

  const [{ createConfig }, { openDB }, { createEventBus }, { createMemory }, { createAgent }, { createBridge }, { createCommandBus }, { patchUi }, { patchOverlay }] = await Promise.all([
    import('../store/config.js'),
    import('../store/db.js'),
    import('../kernel/events.js'),
    import('../kernel/memory.js'),
    import('../kernel/agent.js'),
    import('../app/Bridge.js'),
    import('../app/CommandBus.js'),
    import('../app/stores/uiStore.js'),
    import('../app/stores/overlayStore.js'),
  ]);

  const config = createConfig(dataDir);
  const db = openDB(dataDir);
  const bus = createEventBus(dataDir);
  const mem = createMemory(db);
  const settings = config.get('settings') as { apiKeyEnc?: string; model?: string; baseURL?: string };
  let model = settings.model ?? (settings.apiKeyEnc ? 'deepseek-v4-flash' : '');
  // 权限审批：agent 工具执行需要确认时 → 打开 UI 弹窗并等待用户选择
  let approvalResolve: ((ok: boolean) => void) | null = null;
  const agent = createAgent({
    db, bus, mem, sessionId: 'default', config: { settings },
    mode: (config.get('settings') as any).mode ?? 'smart',
    onApproval: async (name, args) => new Promise<boolean>(resolve => {
      approvalResolve = resolve;
      patchOverlay({ approval: { title: `执行工具：${name}`, detail: JSON.stringify(args).slice(0, 200), allowPermanent: false } });
    }),
  });
  bus.on('ui.approval', (e) => {
    const choice = (e.payload as any)?.choice as string | undefined;
    if (approvalResolve) { approvalResolve(choice !== 'deny'); approvalResolve = null; }
  });
  bus.on('ui.confirm', (e) => {
    if (approvalResolve) { approvalResolve(!!(e.payload as any)?.ok); approvalResolve = null; }
  });
  bus.on('ui.clarify', (e) => {
    if (approvalResolve) { approvalResolve(true); approvalResolve = null; }
  });
  const bridge = createBridge({ send: t => agent.run(t), abort: () => agent.abort() });

  // agent 事件 → Bridge
  for (const type of ['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.stage', 'agent.error', 'agent.end']) {
    bus.on(type, e => bridge.emit(type, e.payload));
  }

  // 模式/主题状态
  let mode = (config.get('settings') as any).mode ?? 'smart';
  let themeName = (config.get('settings') as any).theme ?? 'kimi';
  let thinking = (config.get('settings') as any).thinking ?? true;
  patchUi({ mode, themeName, model, sessionId: 'default', cwd, thinking });

  // 命令注册
  const commandBus = createCommandBus();
  const { registerCoreHandlers } = await import('../commands/handlers.js');
  const { registerExtHandlers } = await import('../commands/handlersExt.js');
  let exitRequested = false;
  // 模型热切换：agent 持有 settings 对象引用——改内存字段即生效，再持久化
  const applyModel = (modelId: string, baseURL?: string) => {
    settings.model = modelId;
    if (baseURL) settings.baseURL = baseURL;
    config.setKey('settings', 'model', modelId);
    if (baseURL) config.setKey('settings', 'baseURL', baseURL);
    model = modelId;
    patchUi({ model: modelId });
  };
  const makeHandlerCtx = () => ({
    dataDir, cwd, db, mem, config, bus,
    getModel: () => model,
    getMode: () => mode,
    setMode: (m: string) => { mode = m; agent.setMode(m as any); config.setKey('settings', 'mode', m); patchUi({ mode: m as any }); },
    setTheme: (t: string) => { themeName = t; config.setKey('settings', 'theme', t); patchUi({ themeName: t }); },
    getThemeName: () => themeName,
    requestExit: () => { exitRequested = true; try { app?.unmount(); } catch {} setTimeout(() => process.exit(0), 50); },
    clearHistory: () => { /* UI 历史清理由 App 层处理（此处保留空实现） */ },
    setModel: applyModel,
    openModelPicker: () => patchOverlay({ modelPicker: true }),
    openSessions: () => patchOverlay({ sessions: true }),
    setThinking: (on: boolean) => { thinking = on; config.setKey('settings', 'thinking', on); patchUi({ thinking: on }); },
  });
  registerCoreHandlers(commandBus, makeHandlerCtx());
  registerExtHandlers(commandBus, makeHandlerCtx());

  // 非交互模式
  if (opts.prompt) {
    const text = String(opts.prompt);
    const { routeInput } = await import('../commands/intent.js');
    const routed = await routeInput(text);
    if (routed.kind === 'command' && routed.cmd) {
      const r = await commandBus.execute(routed.cmd + (routed.value ? ' ' + routed.value : ''));
      console.log(r.output ?? r.error ?? '');
    } else if (routed.kind === 'tool' && routed.value) {
      console.log(routed.value);
    } else {
      const result = await agent.run(text);
      console.log(result.text);
    }
    process.exit(0);
  }

  if (!process.stdout.isTTY) {
    console.log('wxnodus: 非 TTY 环境，请使用 -p 非交互模式');
    process.exit(0);
  }

  // Windows cmd 编码修复：默认代码页 936(GBK) 下 UTF-8 边框/中文会乱码——
  // 交互启动时切换到 UTF-8(65001) 并设置终端标题（Kimi/Claude Code 同款处理）
  if (process.platform === 'win32') {
    try {
      const { execSync } = await import('node:child_process');
      execSync('chcp 65001 >nul', { stdio: 'ignore' });
    } catch { /* 无权限/非 cmd 时静默 */ }
  }
  try { process.stdout.write('\x1b]0;WxNodus — 概念编译器\x07'); } catch {}

  // 交互 TUI
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { App } = await import('../ui/entry.js');
  let app: any;
  // 主屏幕模式（非 alternateScreen，无固定全屏）：历史消息经 <Static> 提交到
  // 终端滚动缓冲自然上滚（滚轮/PgUp 由终端处理），输入框固定底部——
  // 用户要求：取消固定全屏、对话栏不锁死
  app = render(
    React.createElement(App, {
      bridge,
      version: VERSION,
      model,
      cwd,
      runCommand: async (input: string) => {
        const r = await commandBus.execute(input);
        const { pushSegment } = await import('../app/stores/turnStore.js');
        if (r.output) pushSegment({ id: `cmd${Date.now()}`, role: 'system', kind: 'panel', text: r.output });
        if (r.error) pushSegment({ id: `cmd${Date.now()}`, role: 'system', text: r.error, error: true });
      },
      onQuit: () => {
        exitRequested = true;
        try { app?.unmount(); } catch {}
        setTimeout(() => process.exit(0), 50);
      },
      setModel: applyModel,
      onThinkingChange: on => {
        thinking = on;
        config.setKey('settings', 'thinking', on);
        patchUi({ thinking: on });
      },
      listSessions: () => {
        try {
          return (db.prepare(`SELECT s.id, s.title, s.created_at AS ts, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msgs FROM sessions s ORDER BY s.updated_at DESC`).all() as any[]).map(r => ({ id: String(r.id), title: String(r.title ?? ''), msgs: Number(r.msgs ?? 0), ts: Number(r.ts ?? 0) }));
        } catch { return []; }
      },
    }),
    { exitOnCtrlC: false }
  );

  // Ctrl+C：运行中中断 / 空闲退出
  const { useInput } = await import('ink');
  // 退出守卫：unmount + 显式 exit（防 cmd 冻结）
  process.on('SIGINT', () => {
    if (exitRequested) { try { app?.unmount(); } catch {} process.exit(0); }
    exitRequested = true;
    agent.abort();
    setTimeout(() => { try { app?.unmount(); } catch {} process.exit(0); }, 300);
  });
  process.on('SIGTERM', () => { try { app?.unmount(); } catch {} process.exit(0); });
}

main().catch(e => { console.error('启动失败：', e?.message ?? e); process.exit(1); });
