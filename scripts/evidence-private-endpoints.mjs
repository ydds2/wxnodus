// scripts/evidence-private-endpoints.mjs — A5 / P1-3（2026-08-27）：私有端点客户端兼容矩阵实测
// 用法：npm exec -- tsx scripts/evidence-private-endpoints.mjs
// 设计：本地 mock OpenAI 兼容服务器模拟五类私有端点差异（标准 / DeepSeek reasoning / 非标 SSE /
//       无 usage / 不支持工具），直接用内核 callLlmStream 实测客户端宽容度——
//       矩阵结果 = 私有化部署「开箱即用」的验收证据（docs/private-endpoints.md 由此生成）。
//       真实端点（Ollama/LM Studio/one-api/vLLM）经环境变量供给，未配置诚实 skip。
import { createServer } from 'node:http';
import { callLlmStream } from '../src/kernel/llmStream.js';

const sse = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  if (frames.at(-1)?.done !== 'no-done') res.write('data: [DONE]\n\n');
  res.end();
};

const FLAVORS = {
  standard: (req, res) => sse(res, [
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '，世界' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
  ]),
  'deepseek-reasoning': (req, res) => sse(res, [
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '思考中…' }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '答案' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 6 } },
  ]),
  'malformed-sse': (req, res) => {
    // 非标端点：CRLF 分隔 + 缺尾帧 [DONE]——llmStream 尾帧宽容/尾帧缺省语义
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"残缺"},"finish_reason":null}]}\r\n\r\n');
    res.write('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"流"},"finish_reason":"stop"}]}\r\n\r\n');
    res.end();
  },
  'no-usage': (req, res) => sse(res, [
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '无用量' }, finish_reason: 'stop' }] },
  ]),
  'tools-unsupported': (req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'tools are not supported by this model', type: 'invalid_request_error' } }));
  },
  'tool-roundtrip': (req, res) => {
    const body = JSON.parse(req.body);
    const asked = Array.isArray(body.tools) && body.tools.length > 0;
    if (asked) {
      return sse(res, [
        { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 't1', function: { name: 'fs_read', arguments: '' } }] }, finish_reason: null }] },
        { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
      ]);
    }
    return sse(res, [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '工具轮转完成' }, finish_reason: 'stop' }] },
    ]);
  },
};

const results = [];
const run = async (flavor, withTools) => {
  let tokens = '';
  const r = await callLlmStream({
    baseURL: `${BASE}/v1`, model: flavor, key: 'k',
    messages: [{ role: 'user', content: 'hi' }],
    tools: withTools ? [{ type: 'function', function: { name: 'fs_read', description: 'x', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }] : [],
    onToken: t => { tokens += t; },
    timeoutMs: 8000,
    idleFirstChunkMs: 5000,
  });
  return { flavor, withTools, kind: r.ok ? 'ok' : (r.status ? `http-${r.status}` : 'error'), content: r.ok ? r.content : undefined, reasoning: r.ok ? (r.reasoning ?? null) : null, toolCalls: r.ok ? (r.toolCalls?.map(c => c.name) ?? []) : [], usage: r.ok ? (r.usage ?? null) : null, error: r.ok ? undefined : String(r.error ?? '').slice(0, 120), tokens };
};

const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    req.body = body;
    if (!req.url?.startsWith('/v1/chat/completions')) { res.writeHead(404); res.end(); return; }
    let flavor = 'standard';
    try { flavor = JSON.parse(body)?.model ?? 'standard'; } catch { /* 保持默认 */ }
    const handler = FLAVORS[flavor] ?? FLAVORS.standard;
    try { handler(req, res); } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
});

const port = await new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const BASE = `http://127.0.0.1:${port}`;

for (const flavor of Object.keys(FLAVORS)) {
  results.push(await run(flavor, false));
  results.push(await run(flavor, true));
}
server.close();

// ── 矩阵输出（表 + JSON）──
console.log('私有端点客户端兼容矩阵（mock 五类差异 × 7 轴）');
console.log('| 端点形态 | 连接 | 流式解析 | 正文 | 思考字段 | 工具调用 | 用量 | 容错注记 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of results.filter(r => !r.withTools)) {
  const t = results.find(x => x.flavor === r.flavor && x.withTools);
  console.log(`| ${r.flavor} | ${r.kind === 'ok' ? '✅' : '❌ ' + r.kind} | ${r.tokens.length ? '✅' : '❌'} | ${r.content ? '✅' : '—'} | ${r.reasoning !== null ? (r.reasoning ? '✅' : '—（无）') : 'n/a'} | ${t?.kind === 'ok' && t.toolCalls.length ? '✅ ' + t.toolCalls.join(',') : (t?.error ?? '—')} | ${r.usage ? '✅' : '—'} | ${r.error ?? ''} |`);
}
console.log('\nJSON:');
console.log(JSON.stringify(results, null, 2));

// 真实端点探针（env 供给，未配置诚实 skip）
const REAL = {
  OLLAMA: process.env.WXNODUS_E2E_OLLAMA_BASE,
  LMSTUDIO: process.env.WXNODUS_E2E_LMSTUDIO_BASE,
  ONEAPI: process.env.WXNODUS_E2E_ONEAPI_BASE,
};
for (const [name, base] of Object.entries(REAL)) {
  if (!base) { console.log(`[skip] ${name}：未配置 WXNODUS_E2E_${name}_BASE`); continue; }
  const r = await callLlmStream({
    baseURL: base, model: process.env[`WXNODUS_E2E_${name}_MODEL`] ?? 'x', key: process.env[`WXNODUS_E2E_${name}_KEY`] ?? 'none',
    messages: [{ role: 'user', content: '说“好”' }], timeoutMs: 15000, maxRetries: 0,
  });
  console.log(`[real] ${name}: ${r.ok ? `ok content=${JSON.stringify(r.content)} usage=${JSON.stringify(r.usage)}` : `FAIL ${r.kind} ${String(r.error).slice(0, 120)}`}`);
}
