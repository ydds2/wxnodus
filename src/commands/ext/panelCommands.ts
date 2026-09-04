// src/commands/ext/panelCommands.ts — /panel HTML 配置面板入口（2026-09-04 · 用户需求）
// 形态裁决（用户 2026-09-04）：命令全景/配置确认/模式切换/插件中心集成浏览器 HTML 面板；
// TUI 保留引导入口与速查。本命令：懒起本机回环面板服务（panelServer）→ 系统默认浏览器打开。
// 安全：回环绑定 + 随机 token（URL 一次性携带→sessionStorage）+ 命令白名单 ∈ SLASH——
// 执行全走 CommandBus（权限模式/硬红线/审计哈希链照常），浏览器只是另一个前端。
import { spawn } from 'node:child_process';
import type { HandlerCtx } from '../handlers.js';
import type { CommandBus } from '../../app/CommandBus.js';
import { SLASH, COMMAND_DESC, COMMAND_CAT, CORE_COMMANDS } from '../registry.js';
import { WXNODUS_VERSION } from '../../kernel/version.js';

export function registerPanelCommands(bus: CommandBus, _ctx: HandlerCtx): void {
  bus.register('/panel', async () => {
    const { ensurePanelServer } = await import('../../presentation/http/panelServer.js');
    const panel = await ensurePanelServer({
      commandBus: { execute: (cmd, context) => bus.execute(cmd, context) },
      catalog: { slash: SLASH, desc: COMMAND_DESC, cat: COMMAND_CAT, core: [...CORE_COMMANDS] },
      version: WXNODUS_VERSION,
    });
    // 打开系统默认浏览器（Windows：cmd /c start——URL 含 token，仅本机回环可达）
    // VITEST 守卫：测试环境（command-runtime-smoke 全量执行 SLASH）不弹浏览器窗口
    const opened = process.env.VITEST
      ? false
      : await new Promise<boolean>(resolve => {
      if (process.platform !== 'win32') return resolve(false);
      const child = spawn('cmd.exe', ['/c', 'start', '', panel.url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => resolve(true));
    });
    return [
      '◈ WxNodus 配置面板已就绪（本机回环 · 随 TUI 生命周期）',
      `  地址：${panel.url}`,
      opened ? '  已在系统默认浏览器打开。' : '  浏览器未自动打开——复制上行地址到浏览器（token 已含在 URL 内）。',
      '  面板能力：命令全景（搜索/分类/执行 · 危险面二次确认）· 模式切换（smart/auto/manual/plan/goal/yolo）· 插件中心（market 搜索）· 配置/体检',
      '  安全：所有执行经 CommandBus——权限模式、硬红线、审计哈希链照常生效；关闭 TUI 即失效。',
    ].join('\n');
  });
}
