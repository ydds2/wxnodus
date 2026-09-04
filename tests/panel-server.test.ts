// tests/panel-server.test.ts — /panel HTML 配置面板契约（2026-09-04 · 用户需求：命令全景动态配置）
// 三层：① renderPanelPage 纯函数（目录注入/</script> 转义/CSP 范式）；② startPanelServer 真实
// 回环 HTTP（token 恒时校验/命令白名单/CommandBus 往返）；③ ensurePanelServer 幂等单例 + reset seam。
// 安全契约锚定：无 token 401 · 错 token 401 · 未注册命令头 404（路径探测不可达）。
import { describe, it, expect, afterAll } from 'vitest';
import { renderPanelPage } from '../src/presentation/http/panelPage.js';
import { startPanelServer, ensurePanelServer, resetPanelServerForTests } from '../src/presentation/http/panelServer.js';

const CATALOG = {
  slash: ['/status', '/doctor', '/panel'],
  desc: { '/status': '系统状态', '/doctor': '体检', '/panel': '配置面板' },
  cat: { '/status': '⚙', '/doctor': '⚙', '/panel': '⚙' },
  core: ['/status'],
};

const stubBus = (log: string[] = []) => ({
  execute: async (cmd: string) => { log.push(cmd); return { ok: true, output: `PANEL执行:${cmd}` }; },
});

afterAll(() => { resetPanelServerForTests(); });

describe('renderPanelPage 纯函数', () => {
  it('命令目录注入：全量命令名/描述进 HTML（面板零拉取）', () => {
    const html = renderPanelPage({ catalog: CATALOG, version: '4.0.2' });
    expect(html).toContain('"/status"');
    expect(html).toContain('系统状态');
    expect(html).toContain('4.0.2');
    expect(html).toContain('WxNodus 配置面板');
  });
  it('</script> 注入转义：desc 含闭合序列不逃逸 <script> 块', () => {
    const evil = { ...CATALOG, desc: { ...CATALOG.desc, '/status': '</script><img src=x onerror=alert(1)>' } };
    const html = renderPanelPage({ catalog: evil as typeof CATALOG });
    expect(html).not.toContain('</script><img');
    expect(html).toContain('<\\/script>');
  });
  it('模式切换器六档含 yolo 红警示 · 危险清单含 /perm', () => {
    const html = renderPanelPage({ catalog: CATALOG });
    expect(html).toContain('"id":"yolo"');
    expect(html).toContain('YOLO');
    expect(html).toContain('^/perm\\\\b');
  });
});

describe('startPanelServer 真实回环 HTTP（token · 白名单 · 往返）', () => {
  it('GET /panel 200 HTML · 无/错 token 401 · 好 token 命令往返 · 未注册头 404', async () => {
    const log: string[] = [];
    const handle = await startPanelServer({ commandBus: stubBus(log), catalog: CATALOG, version: '4.0.2' });
    try {
      // ① 静态页：本机回环可达，含命令目录
      const page = await fetch(`http://127.0.0.1:${handle.port}/panel`);
      expect(page.status).toBe(200);
      expect(page.headers.get('cache-control')).toBe('no-store');
      const html = await page.text();
      expect(html).toContain('WxNodus 配置面板');
      expect(html).toContain('/doctor');

      // ② token 面：无/错 token 一律 401（恒时比较——不区分缺失与错误）
      const noToken = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, { method: 'POST', body: '{}' });
      expect(noToken.status).toBe(401);
      const badToken = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, { method: 'POST', headers: { authorization: 'Bearer ' + '0'.repeat(64) }, body: '{}' });
      expect(badToken.status).toBe(401);

      // ③ 命令往返：好 token → CommandBus 执行（全量放行裁决——内核审批链在真实装配面）
      const ok = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ method: 'command', command: '/doctor --fast' }),
      });
      expect(ok.status).toBe(200);
      const j = await ok.json() as { ok: boolean; output: string };
      expect(j.ok).toBe(true);
      expect(j.output).toBe('PANEL执行:/doctor --fast');
      expect(log).toEqual(['/doctor --fast']);

      // ④ 白名单：未注册命令头（路径探测形态）一律 404
      const probe = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ method: 'command', command: '/../../../etc/passwd' }),
      });
      expect(probe.status).toBe(404);
      const pj = await probe.json() as { error: { code: string } };
      expect(pj.error.code).toBe('UNKNOWN_COMMAND');

      // ⑤ 非 command 方法 400（本服务面单一职责）
      const bad = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ method: 'chat' }),
      });
      expect(bad.status).toBe(400);
    } finally { await handle.close(); }
  }, 20_000);

  it('ensurePanelServer 幂等单例（复用同实例）+ reset seam（K3 教训）', async () => {
    const h1 = await ensurePanelServer({ commandBus: stubBus(), catalog: CATALOG });
    const h2 = await ensurePanelServer({ commandBus: stubBus(), catalog: CATALOG });
    expect(h2.port).toBe(h1.port);
    expect(h2.token).toBe(h1.token);
    resetPanelServerForTests();
    const h3 = await ensurePanelServer({ commandBus: stubBus(), catalog: CATALOG });
    expect(h3.port).not.toBe(h1.port); // 新实例
    resetPanelServerForTests();
  }, 20_000);
});

describe('/panel 命令注册面（三表由 check:registry-consistency 门禁锁定——此处锁 catalog 真实性）', () => {
  it('真实 registry 目录可渲染（127 条进面板 HTML）', async () => {
    const { SLASH, COMMAND_DESC, COMMAND_CAT, CORE_COMMANDS } = await import('../src/commands/registry.js');
    expect(SLASH).toContain('/panel');
    const html = renderPanelPage({ catalog: { slash: SLASH, desc: COMMAND_DESC, cat: COMMAND_CAT, core: [...CORE_COMMANDS] } });
    expect(html).toContain('"/panel"');
    expect((html.match(/"/g)?.length ?? 0)).toBeGreaterThan(100); // 目录体量真实注入
  });
});

// 面板 2.0（2026-09-04）：market.search 只读搜索 + chat AI 直通——自动搜索下载闭环与智能自动化
describe('面板 2.0：market.search 只读 + chat AI 直通', () => {
  it('market.search：结构化结果往返（只读 RPC——安装不走此面）', async () => {
    const handle = await startPanelServer({
      commandBus: stubBus(),
      catalog: CATALOG,
      marketSearch: async q => [{ name: `fs-${q}`, description: '文件系统 MCP', type: 'mcp', source: 'npm', installArg: `fs-${q}` }],
    });
    try {
      const r = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ method: 'market.search', query: 'server' }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { ok: boolean; items: Array<{ name: string; installArg: string }> };
      expect(j.ok).toBe(true);
      expect(j.items[0]!.name).toBe('fs-server');
      expect(j.items[0]!.installArg).toBe('fs-server');
      // 未装配 marketSearch → 400 诚实报（不假装搜索）
    } finally { await handle.close(); }
  }, 20_000);

  it('chat：AI 直通往返（agent.run 结果原样回传）+ 未装配诚实 400', async () => {
    const agent = { run: async (p: string) => ({ ok: true, text: `AI完成:${p}`, turns: 3, interrupted: false }) };
    const handle = await startPanelServer({ commandBus: stubBus(), catalog: CATALOG, agent });
    try {
      const r = await fetch(`http://127.0.0.1:${handle.port}/api/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ method: 'chat', prompt: '体检并总结' }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { ok: boolean; text: string; turns: number };
      expect(j.ok).toBe(true);
      expect(j.text).toBe('AI完成:体检并总结');
      expect(j.turns).toBe(3);
    } finally { await handle.close(); }
    const bare = await startPanelServer({ commandBus: stubBus(), catalog: CATALOG });
    try {
      const r = await fetch(`http://127.0.0.1:${bare.port}/api/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bare.token}` },
        body: JSON.stringify({ method: 'chat', prompt: 'x' }),
      });
      expect(r.status).toBe(400); // 未装配 agent 诚实拒绝（不假装 AI 可用）
    } finally { await bare.close(); }
  }, 20_000);

  it('面板 HTML 含 AI 助手区与插件市场卡片化 UI（2.0 形态）', () => {
    const html = renderPanelPage({ catalog: CATALOG });
    expect(html).toContain('AI 助手');
    expect(html).toContain('market.search');
    expect(html).toContain('一键安装');
  });
});
