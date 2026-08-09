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

  const [{ createConfig }, { openDB }, { createEventBus }, { createMemory }, { createAgent }, { createBridge }, { createCommandBus }] = await Promise.all([
    import('../store/config.js'),
    import('../store/db.js'),
    import('../kernel/events.js'),
    import('../kernel/memory.js'),
    import('../kernel/agent.js'),
    import('../app/Bridge.js'),
    import('../app/CommandBus.js'),
  ]);

  const config = createConfig(dataDir);
  const db = openDB(dataDir);
  const bus = createEventBus(dataDir);
  const mem = createMemory(db);
  const settings = config.get('settings') as { apiKeyEnc?: string; model?: string; baseURL?: string };
  const model = settings.model ?? (settings.apiKeyEnc ? 'deepseek-v4-flash' : '');
  const agent = createAgent({ db, bus, mem, sessionId: 'default', config: { settings }, mode: (config.get('settings') as any).mode ?? 'smart' });
  const bridge = createBridge({ send: t => agent.run(t), abort: () => agent.abort() });

  // agent 事件 → Bridge
  for (const type of ['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.stage', 'agent.error', 'agent.end']) {
    bus.on(type, e => bridge.emit(type, e.payload));
  }

  // 模式/主题状态
  let mode = (config.get('settings') as any).mode ?? 'smart';
  let themeName = (config.get('settings') as any).theme ?? 'kimi';
  const { patchUi } = await import('../app/stores/uiStore.js');
  const { patchOverlay } = await import('../app/stores/overlayStore.js');
  patchUi({ mode, themeName, model, sessionId: 'default', cwd });

  // 命令注册
  const commandBus = createCommandBus();
  const { registerCoreHandlers } = await import('../commands/handlers.js');
  let exitRequested = false;
  registerCoreHandlers(commandBus, {
    dataDir, cwd, db, mem, config, bus,
    getModel: () => model,
    getMode: () => mode,
    setMode: m => { mode = m; config.setKey('settings', 'mode', m); patchUi({ mode: m as any }); },
    setTheme: t => { themeName = t; config.setKey('settings', 'theme', t); patchUi({ themeName: t }); },
    getThemeName: () => themeName,
    requestExit: () => { exitRequested = true; try { app?.unmount(); } catch {} setTimeout(() => process.exit(0), 50); },
    clearHistory: () => { /* UI 历史清理由 App 层处理（此处保留空实现） */ },
  });

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

  // 交互 TUI
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { App } = await import('../ui/entry.js');
  let app: any;
  app = render(
    React.createElement(App, {
      bridge,
      version: VERSION,
      model,
      cwd,
      runCommand: async (input: string) => {
        const r = await commandBus.execute(input);
        const { patchTurn } = await import('../app/stores/turnStore.js');
        const { pushSegment } = await import('../app/stores/turnStore.js');
        if (r.output) pushSegment({ id: `cmd${Date.now()}`, role: 'system', kind: 'panel', text: r.output });
        if (r.error) pushSegment({ id: `cmd${Date.now()}`, role: 'system', text: r.error, error: true });
      },
    }),
    { alternateScreen: true, exitOnCtrlC: false }
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
