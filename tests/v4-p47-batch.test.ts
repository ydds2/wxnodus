// tests/v4-p47-batch.test.ts — V4 P4-7：B 级精选一揽子（8 项缺陷的机制级测试）
// ①browser 导航守卫 ②term sanitizedEnv（源接线断言）③cron dom/dow OR ④[DONE] 尾帧宽容
// ⑤temperature 按模型省略 ⑥MCP 增量解码机制 ⑦/warp 入 SLASH ⑧apply_patch 敏感写下沉
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cronMatches, parseCronExpr } from '../src/kernel/cronExpr.js';
import { modelRejectsTemperature, buildChatRequest } from '../src/kernel/providers.js';
import { modeVerdict } from '../src/kernel/permissions.js';
import { armNavigationGuard, lastNavigationBlock } from '../src/kernel/browser.js';
import { SLASH } from '../src/commands/registry.js';
import { callLlmStream } from '../src/kernel/llmStream.js';

describe('③ cron dom/dow OR 语义（B-16）', () => {
  const fields = (expr: string) => (parseCronExpr(expr) as { ok: true; fields: ReturnType<typeof parseCronExpr> extends never ? never : any }).fields;
  it('双受限 OR：`0 0 15 * 1` 在非 15 号的周一日触发（纯 AND 会漏）', () => {
    const f = fields('0 0 15 * 1'); // 每月 15 号 OR 每周一
    const monday24 = new Date(2026, 7, 24, 0, 0); // 2026-08-24 是周一，非 15 号
    expect(monday24.getDay()).toBe(1);
    expect(cronMatches(f, monday24)).toBe(true);
    const tue15 = new Date(2026, 7, 18, 0, 0); // 2026-08-18 周二，非 15 号非周一
    expect(cronMatches(f, tue15)).toBe(false);
  });
  it('单受限 AND：`0 0 15 * *` 仅 15 号触发', () => {
    const f = fields('0 0 15 * *');
    expect(cronMatches(f, new Date(2026, 7, 15, 0, 0))).toBe(true);
    expect(cronMatches(f, new Date(2026, 7, 16, 0, 0))).toBe(false);
  });
  it('全 * 不受影响', () => {
    const f = fields('* * * * *');
    expect(cronMatches(f, new Date(2026, 7, 24, 10, 30))).toBe(true);
  });
});

describe('⑤ temperature 按模型省略（B-18）', () => {
  it('modelRejectsTemperature：o 系/gpt-5 类 true，其余 false', () => {
    for (const m of ['o1', 'o1-preview', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5.1', 'GPT-5-Turbo']) {
      expect(modelRejectsTemperature(m), m).toBe(true);
    }
    for (const m of ['deepseek-chat', 'kimi-k2.7', 'glm-4.7', 'gpt-4o', 'claude-sonnet-4']) {
      expect(modelRejectsTemperature(m), m).toBe(false);
    }
  });
  it('buildChatRequest：不采样族请求体无 temperature；常规模型保留缺省 0.7', () => {
    const base = { baseURL: 'https://api.x.com/v1', key: 'k', messages: [{ role: 'user' as const, content: 'hi' }], stream: true };
    const o3body = JSON.parse(buildChatRequest({ ...base, model: 'o3-mini' }).body as string);
    expect(o3body).not.toHaveProperty('temperature');
    const dsBody = JSON.parse(buildChatRequest({ ...base, model: 'deepseek-chat' }).body as string);
    expect(dsBody.temperature).toBe(0.7);
    const custom = JSON.parse(buildChatRequest({ ...base, model: 'deepseek-chat', temperature: 0.2 }).body as string);
    expect(custom.temperature).toBe(0.2);
  });
});

describe('⑦ /warp 入 SLASH（B-27 精选）', () => {
  it('SLASH 数组含 /warp（注册/分类/描述一致性测试同时锁定）', () => {
    expect(SLASH).toContain('/warp');
  });
});

describe('⑧ apply_patch 敏感写下沉（A-22 补遗）', () => {
  it('补丁目标为敏感文件 → 任何模式 reject', () => {
    const patch = '*** Begin Patch\n*** Update File: config/.env\n@@\n-old\n+new\n*** End Patch';
    for (const mode of ['smart', 'auto', 'yolo'] as const) {
      expect(modeVerdict(mode, 'apply_patch', { patch }), mode).toBe('reject');
    }
  });
  it('Move/Add/Delete File 目标同样受保护（.ssh 密钥）', () => {
    expect(modeVerdict('yolo', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: keys/id_rsa\n@@\n+SECRET\n*** End Patch' })).toBe('reject');
    expect(modeVerdict('yolo', 'apply_patch', { patch: '*** Begin Patch\n*** Move File: .ssh/config\n*** To File: .ssh/config.bak\n*** End Patch' })).toBe('reject');
  });
  it('普通文件补丁不受影响；补丁内容行提及 .env 字样不误伤', () => {
    expect(modeVerdict('yolo', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-load .env\n+load .env.local\n*** End Patch' })).toBe('approve');
  });
});

describe('① browser 导航守卫（B-14）', () => {
  const fakePage = () => {
    const handlers: Array<(frame: any) => void> = [];
    let wentBack = 0;
    // 主框架必须是稳定单例引用（守卫以 frame === page.mainFrame() 判主框架）；
    // url 是方法（playwright Frame.url() 同形——写成 getter 会让 frame.url() 变调用字符串）
    let mainUrl = 'https://good.example/page';
    const mainFrame = { url: () => mainUrl };
    return {
      page: {
        on: (_ev: string, cb: (f: any) => void) => { handlers.push(cb); },
        mainFrame: () => mainFrame,
        goBack: async () => { wentBack += 1; },
      },
      navigate(url: string, isMain = true) {
        if (isMain) { mainUrl = url; for (const h of handlers) h(mainFrame); }
        else { for (const h of handlers) h({ url: () => url }); } // 子框架独立引用
      },
      get wentBack() { return wentBack; },
    };
  };
  it('主框架跳内网 → goBack 回退 + 拦截记录；公网放行', async () => {
    const t = fakePage();
    armNavigationGuard(t.page, 'guard-1', async url => url.includes('192.168.') ? { ok: false, reason: '内网/保留地址' } : { ok: true });
    t.navigate('https://public.example/next');
    await new Promise(r => setTimeout(r, 20));
    expect(t.wentBack).toBe(0);
    expect(lastNavigationBlock('guard-1')).toBeNull();
    t.navigate('http://192.168.1.1/admin');
    await new Promise(r => setTimeout(r, 20));
    expect(t.wentBack).toBe(1);
    expect(lastNavigationBlock('guard-1')?.url).toBe('http://192.168.1.1/admin');
    expect(lastNavigationBlock('guard-1')?.reason).toContain('内网');
  });
  it('子框架跳转不回退主页面；非 http 目标忽略', async () => {
    const t = fakePage();
    armNavigationGuard(t.page, 'guard-2', async () => ({ ok: false, reason: '内网' }));
    t.navigate('http://192.168.0.1/ads', false); // 子框架
    await new Promise(r => setTimeout(r, 20));
    t.navigate('about:blank'); // 非 http
    await new Promise(r => setTimeout(r, 20));
    expect(t.wentBack).toBe(0);
    expect(lastNavigationBlock('guard-2')).toBeNull();
  });
});

describe('④ [DONE] 尾帧宽容（B-17）', () => {
  const encoder = new TextEncoder();
  const streamResponse = (chunks: string[]): Response => {
    let i = 0;
    return {
      ok: true, status: 200, headers: new Headers(),
      body: { getReader: () => ({ read: async () => i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]!) } : { done: true, value: undefined } }) },
    } as unknown as Response;
  };
  it('[DONE] 后追加 data 帧不再判 malformed——已产出内容完整保留', async () => {
    const resp = streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '完整回答' } }] })}\n\n`,
      'data: [DONE]\n\n',
      `data: ${JSON.stringify({ usage: { total_tokens: 10 } })}\n\n`, // 网关补发统计帧
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => resp;
    try {
      const r = await callLlmStream({ baseURL: 'https://api.example.com/v1', model: 'relay-x', key: 'k', messages: [{ role: 'user', content: 'hi' }] });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.content).toBe('完整回答');
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});

describe('⑥ MCP 增量解码机制（B-12）+ ② term sanitizedEnv 接线', () => {
  it('TextDecoder stream 模式：中文多字节跨 chunk 截断不产替换符（toString 对照）', () => {
    const full = Buffer.from('{"desc":"中文名称"}', 'utf8');
    const cut = 10; // 切在 '中'(3 字节) 中间——单字节边界无截断效果
    const dec = new TextDecoder();
    const streamed = dec.decode(full.subarray(0, cut), { stream: true }) + dec.decode(full.subarray(cut));
    expect(streamed).toBe('{"desc":"中文名称"}');
    // 旧做法（chunk.toString 各自解码）在截断点产 U+FFFD
    const naive = full.subarray(0, cut).toString('utf8') + full.subarray(cut).toString('utf8');
    expect(naive).not.toBe('{"desc":"中文名称"}');
    expect(naive).toContain('\uFFFD');
  });
  it('term.ts pty 环境已接 sanitizedEnv（源级接线断言——spawn 级集成需真 pty）', () => {
    const src = readFileSync(resolve(__dirname, '../src/kernel/term.ts'), 'utf8');
    expect(src).toContain('env: sanitizedEnv()');
    expect(src).not.toMatch(/env:\s*process\.env/);
  });
  it('mcp.ts stdout 已接流式解码器（源级接线断言）', () => {
    const src = readFileSync(resolve(__dirname, '../src/kernel/mcp.ts'), 'utf8');
    expect(src).toContain('mcpStdoutDecoder.decode(chunk, { stream: true })');
    expect(src).not.toMatch(/buf \+= chunk\.toString\('utf8'\)/);
  });
});
