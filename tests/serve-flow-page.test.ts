// tests/serve-flow-page.test.ts — /flow 管线流图可视化（2026-08-27）
// 契约：GET /flow 为纯静态零数据页（无认证、零外部资源、CSP no-store）；实时模式在页面内凭
// token 走同源 fetch 流式 /events——网关认证面不变（页面不注入任何请求参数，session_id 由页面 JS 自取）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { renderFlowHtml, FLOW_STAGES, FLOW_EVENT_STAGE, FLOW_CSP } from '../src/presentation/http/flowPage.js';
import { startServeServer, type ServeKernel } from '../src/cli/serve.js';

describe('renderFlowHtml（纯函数）', () => {
  const html = renderFlowHtml({ version: '4.0.0-rc.1' });

  it('六阶段管线全部在场（真实实现文件锚点）', () => {
    expect(FLOW_STAGES.map(s => s.id)).toEqual(['queue', 'policy', 'llm', 'tools', 'events', 'audit']);
    for (const s of FLOW_STAGES) {
      expect(html).toContain(`"id":"${s.id}"`);   // STAGES 数据（页面 JS 据此动态建 DOM）
      expect(html).toContain(s.file);
      expect(html).toContain(s.title);
    }
    expect(html).toContain("'stage-' + s.id");    // 动态拼接逻辑在场
  });

  it('事件→阶段映射覆盖已订阅 SSE 事件集', () => {
    for (const type of ['agent.start', 'agent.token', 'agent.message', 'agent.tool', 'agent.error', 'agent.end', 'run.final', 'system.notice', 'voice.transcript']) {
      expect(FLOW_EVENT_STAGE[type]).toBeTruthy();
      expect(FLOW_STAGES.some(s => s.id === FLOW_EVENT_STAGE[type])).toBe(true);
    }
  });

  it('零外部资源（脚本/样式/链接全部内联）', () => {
    expect(html).not.toMatch(/<(script|link|img|iframe)\b[^>]*(src|href)=["']https?:/i);
    expect(html).toContain(FLOW_CSP);
  });

  it('版本号注入转义（无 XSS 注入面）', () => {
    const evil = renderFlowHtml({ version: '<script>alert(1)</script>' });
    expect(evil).not.toContain('<script>alert(1)</script>');
  });

  it('页面不含任何服务端数据注入（无具体 session 值进入 HTML）', () => {
    expect(html).not.toMatch(/session_id=['"][^'"]+['"]/);
    expect(html).not.toContain('/events?session_id=');
  });
});

describe('GET /flow（网关路由）', () => {
  let srv: ReturnType<typeof startServeServer>;
  const PORT = 4796;
  beforeAll(() => {
    const kernel: ServeKernel = {
      dataDir: 'unused', cwd: 'unused',
      db: { prepare: () => { throw new Error('flow 路由不触库'); } } as unknown as ServeKernel['db'],
      bus: { on: () => () => {} },
      runInvocation: null as unknown as ServeKernel['runInvocation'],
      mem: { recall: () => [] },
      agent: { run: async () => ({ ok: true, text: '', turns: 0, interrupted: false }) },
      commandBus: { execute: async () => ({ ok: true, output: '' }) },
      config: { get: () => ({}) },
    };
    srv = startServeServer(kernel, PORT, { token: 'flow-test-token' });
  });
  afterAll(async () => { await srv.close(); });

  it('无认证即可浏览（静态零数据页）+ 严格 CSP + no-store', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/flow`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.text();
    expect(body).toContain('wxnodus 管线流图');
    expect(body).toContain('"id":"queue"');
    expect(body).toContain('durableQueue.ts');
  });

  it('query 参数不被服务端处理（session_id 由页面 JS 自取转交 /events）', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/flow?session_id=%22%3E%3Cscript%3E`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toContain('"><script>');
  });
});
