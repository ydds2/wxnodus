// src/build/scaffold.ts — L3-1 脚手架（模具实例化）
// A22 成熟栈改造：生成项目 = node:http REST 分层（router 路由 / store 存储 /
//   index 入口 + 统一错误处理，零依赖可跑）+ React 19 前端 + esbuild 打包 +
//   node:test 冒烟测试（npm test 真实执行——质量门第五门不再跳过）。
// 5 模具差异化：todo(CRUD+勾选) / ledger(收支统计) / note(全文搜索) /
//   anim(帧动画) / generic(基线 CRUD)。
// 诚实交付：未构建前端时页面自动回退零依赖兜底（同一 API，页面标注）；
//   LEFTOVER 残留槽位检测（占位符未替换 = 拒交付）。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Spec } from './spec.js';

export interface InstantiateResult { ok: boolean; reason?: string }

const LEFTOVER_RE = /LEFTOVER|__TITLE__|__SUMMARY__|__PORT__/;

// ── 服务端分层模板（零依赖 node:http）───────────────────────────────

const STORE_JS = `// 存储层：JSON 文件持久化（零依赖；原子写 = 临时文件 + rename）
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'data.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function save(d) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, FILE);
}

function read(key, fallback = []) { const d = load(); return d[key] ?? fallback; }
function mutate(key, fn) { const d = load(); d[key] = fn(d[key] ?? []); save(d); return d[key]; }
function reset() { try { fs.unlinkSync(FILE); } catch { /* 忽略 */ } }

module.exports = { read, mutate, reset, FILE };
`;

const ROUTER_JS = `// 路由层：「方法 路径」→ 处理器；:id 路径参数；统一 JSON 输出与错误处理
function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve(null); }
    });
  });
}

// 精确键优先，其次 :param 模式键（捕获路径参数）
function match(routes, method, pathname) {
  const exact = routes[method + ' ' + pathname];
  if (exact) return { handler: exact, params: {} };
  for (const [key, handler] of Object.entries(routes)) {
    if (!key.startsWith(method + ' ') || !key.includes(':')) continue;
    const pattern = key.slice(method.length + 1);
    const re = new RegExp('^' + pattern.replace(/:[^/]+/g, '([^/]+)') + '$');
    const m = re.exec(pathname);
    if (m) {
      const names = [...pattern.matchAll(/:([^/]+)/g)].map((x) => x[1]);
      return { handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
    }
  }
  return null;
}

function createRouter(routes) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\\/+$/, '') || '/';
    const hit = match(routes, req.method ?? 'GET', pathname);
    if (!hit) return json(res, 404, { error: 'not found' });
    try {
      await hit.handler(req, res, url, readBody, hit.params);
    } catch (e) {
      json(res, 500, { error: String((e && e.message) || e) });
    }
  };
}

module.exports = { createRouter, json, readBody };
`;

// 各模具路由表（嵌入生成 index.js；nextId 由入口模板提供）
const MOLD_ROUTES: Record<string, string> = {
  todo: `  'GET /api/health': (req, res) => json(res, 200, { ok: true, items: store.read('items').length }),
  'GET /api/items': (req, res) => json(res, 200, store.read('items')),
  'POST /api/items': async (req, res, url, readBody) => {
    const b = await readBody(req);
    if (!b || typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'text 必填' });
    const items = store.mutate('items', (list) => [...list, { id: nextId(list), text: b.text.trim(), done: false, ts: Date.now() }]);
    json(res, 201, items[items.length - 1]);
  },
  'PUT /api/items/:id': async (req, res, url, readBody, params) => {
    const id = Number(params.id);
    const b = await readBody(req);
    let found = false;
    store.mutate('items', (list) => list.map((i) => {
      if (i.id === id) {
        found = true;
        return { ...i, done: typeof b?.done === 'boolean' ? b.done : i.done, text: typeof b?.text === 'string' && b.text.trim() ? b.text.trim() : i.text };
      }
      return i;
    }));
    if (!found) return json(res, 404, { error: 'item not found' });
    json(res, 200, { ok: true });
  },
  'DELETE /api/items/:id': (req, res, url, readBody, params) => {
    const id = Number(params.id);
    let found = false;
    store.mutate('items', (list) => list.filter((i) => { if (i.id === id) found = true; return i.id !== id; }));
    if (!found) return json(res, 404, { error: 'item not found' });
    json(res, 200, { ok: true });
  },`,

  ledger: `  'GET /api/health': (req, res) => json(res, 200, { ok: true, entries: store.read('entries').length }),
  'GET /api/entries': (req, res) => json(res, 200, store.read('entries')),
  'POST /api/entries': async (req, res, url, readBody) => {
    const b = await readBody(req);
    const amount = Number(b?.amount);
    const type = b?.type === 'expense' ? 'expense' : 'income';
    if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: 'amount 必须为正数' });
    const entries = store.mutate('entries', (list) => [...list, { id: nextId(list), amount, type, note: String(b?.note ?? '').slice(0, 200), ts: Date.now() }]);
    json(res, 201, entries[entries.length - 1]);
  },
  'GET /api/stats': (req, res) => {
    const entries = store.read('entries');
    const income = entries.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
    const expense = entries.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
    json(res, 200, { income, expense, balance: income - expense, count: entries.length });
  },`,

  note: `  'GET /api/health': (req, res) => json(res, 200, { ok: true, notes: store.read('notes').length }),
  'GET /api/notes': (req, res) => json(res, 200, store.read('notes')),
  'POST /api/notes': async (req, res, url, readBody) => {
    const b = await readBody(req);
    if (!b || !String(b?.title ?? '').trim()) return json(res, 400, { error: 'title 必填' });
    const notes = store.mutate('notes', (list) => [...list, { id: nextId(list), title: String(b.title).trim(), content: String(b?.content ?? ''), ts: Date.now() }]);
    json(res, 201, notes[notes.length - 1]);
  },
  'GET /api/search': (req, res, url) => {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (!q) return json(res, 400, { error: 'q 必填' });
    const notes = store.read('notes').filter((n) => (n.title + ' ' + n.content).toLowerCase().includes(q));
    json(res, 200, notes);
  },`,

  anim: `  'GET /api/health': (req, res) => json(res, 200, { ok: true, frames: store.read('frames').length }),
  'GET /api/frames': (req, res) => json(res, 200, store.read('frames')),
  'POST /api/frames': async (req, res, url, readBody) => {
    const b = await readBody(req);
    if (!b || !String(b?.label ?? '').trim()) return json(res, 400, { error: 'label 必填' });
    const durationMs = Number(b?.durationMs) > 0 ? Number(b.durationMs) : 500;
    const frames = store.mutate('frames', (list) => [...list, { id: nextId(list), label: String(b.label).trim(), durationMs, ts: Date.now() }]);
    json(res, 201, frames[frames.length - 1]);
  },`,

  generic: `  'GET /api/health': (req, res) => json(res, 200, { ok: true, items: store.read('items').length }),
  'GET /api/items': (req, res) => json(res, 200, store.read('items')),
  'POST /api/items': async (req, res, url, readBody) => {
    const b = await readBody(req);
    if (!b || typeof b.text !== 'string' || !b.text.trim()) return json(res, 400, { error: 'text 必填' });
    const items = store.mutate('items', (list) => [...list, { id: nextId(list), text: b.text.trim(), ts: Date.now() }]);
    json(res, 201, items[items.length - 1]);
  },
  'DELETE /api/items/:id': (req, res, url, readBody, params) => {
    const id = Number(params.id);
    let found = false;
    store.mutate('items', (list) => list.filter((i) => { if (i.id === id) found = true; return i.id !== id; }));
    if (!found) return json(res, 404, { error: 'item not found' });
    json(res, 200, { ok: true });
  },`,
};

// 各模具冒烟测试用例（node:test；公共头由 genSmokeTest 拼装）
const MOLD_SMOKE_CASES: Record<string, string> = {
  todo: `test('新增 → 列表 → 勾选 → 删除（CRUD 闭环）', async () => {
    const post = (body) => fetch(base + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const a = await (await post({ text: '写冒烟测试' })).json();
    const b = await (await post({ text: '跑质量门' })).json();
    assert.ok(a.id && b.id);
    let list = await (await fetch(base + '/api/items')).json();
    assert.equal(list.length, 2);
    await fetch(base + '/api/items/' + a.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: true }) });
    list = await (await fetch(base + '/api/items')).json();
    assert.equal(list.find((i) => i.id === a.id).done, true);
    await fetch(base + '/api/items/' + b.id, { method: 'DELETE' });
    list = await (await fetch(base + '/api/items')).json();
    assert.equal(list.length, 1);
  });`,

  ledger: `test('新增收入/支出 → 统计正确', async () => {
    const post = (body) => fetch(base + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post({ amount: 100, type: 'income', note: '工资' });
    await post({ amount: 30, type: 'expense', note: '午饭' });
    const stats = await (await fetch(base + '/api/stats')).json();
    assert.equal(stats.income, 100);
    assert.equal(stats.expense, 30);
    assert.equal(stats.balance, 70);
    assert.equal(stats.count, 2);
  });
  test('金额非法 → 400', async () => {
    const r = await fetch(base + '/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: -5 }) });
    assert.equal(r.status, 400);
  });`,

  note: `test('新增笔记 → 全文搜索命中', async () => {
    const post = (body) => fetch(base + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post({ title: '会议记录', content: '讨论了 WxNodus 的路线图' });
    await post({ title: '购物清单', content: '牛奶鸡蛋' });
    const hits = await (await fetch(base + '/api/search?q=' + encodeURIComponent('路线图'))).json();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, '会议记录');
  });
  test('缺 title → 400', async () => {
    const r = await fetch(base + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400);
  });`,

  anim: `test('新增帧 → 列表（缺省时长兜底）', async () => {
    const post = (body) => fetch(base + '/api/frames', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await post({ label: '起跳', durationMs: 400 });
    await post({ label: '落地' });
    const frames = await (await fetch(base + '/api/frames')).json();
    assert.equal(frames.length, 2);
    assert.equal(frames[0].label, '起跳');
    assert.equal(frames[0].durationMs, 400);
    assert.equal(frames[1].durationMs, 500);
  });`,

  generic: `test('新增 → 列表 → 删除（基线 CRUD）', async () => {
    const post = (body) => fetch(base + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const a = await (await post({ text: '基线条目' })).json();
    assert.ok(a.id);
    let list = await (await fetch(base + '/api/items')).json();
    assert.equal(list.length, 1);
    await fetch(base + '/api/items/' + a.id, { method: 'DELETE' });
    list = await (await fetch(base + '/api/items')).json();
    assert.equal(list.length, 0);
  });`,
};

function genSmokeTest(mold: string): string {
  return `// 冒烟测试（node:test 内置——零依赖；npm test 真实执行，质量门第五门）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let proc = null;
let base = '';

before(async () => {
  try { fs.unlinkSync(path.join(__dirname, 'data.json')); } catch { /* 全新数据 */ }
  const boot = new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.on('exit', (code) => reject(new Error('server exited ' + code)));
    proc.stdout.on('data', (c) => {
      out += c;
      const m = /listening on (\\d+)/.exec(out);
      if (m) resolve(m[1]);
    });
  });
  const port = await Promise.race([
    boot,
    new Promise((_, reject) => setTimeout(() => reject(new Error('启动超时')), 8000)),
  ]);
  base = 'http://127.0.0.1:' + port;
});

after(() => { try { proc && proc.kill(); } catch { /* 忽略 */ } });

test('健康探活', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

${MOLD_SMOKE_CASES[mold] ?? MOLD_SMOKE_CASES.generic!}

test('未知路径 → 404 JSON（统一错误处理）', async () => {
  const r = await fetch(base + '/api/nope');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'not found');
});
`;
}

function genServer(mold: string, title: string): string {
  return `// ${title} — 服务入口（node:http REST 分层：路由 → 存储 → 统一错误处理；零依赖）
const { createServer } = require('node:http');
const { createRouter, json, readBody } = require('./router.js');
const store = require('./store.js');

const PORT = process.env.PORT || 4321;

const nextId = (list) => list.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0) + 1;

// 路由表（「方法 路径」键；:id = 路径参数）
const routes = {
${MOLD_ROUTES[mold] ?? MOLD_ROUTES.generic!}
};

const server = createServer(createRouter(routes));
server.listen(PORT, () => console.log('listening on ' + server.address().port));
module.exports = server;
`;
}

// ── 前端（React 19 + esbuild；未构建时零依赖兜底）───────────────────

const MAIN_JSX = `// React 19 入口（npm run build 用 esbuild 打包为 public/dist/bundle.js）
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
`;

// 各模具 React 19 组件（成熟组件路径；与零依赖兜底共用同一 API）
const MOLD_APP: Record<string, string> = {
  todo: `// React 19 待办组件（npm install && npm run build 后生效）
import { useEffect, useState } from 'react';

export default function App() {
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');

  const load = () => fetch('/api/items').then((r) => r.json()).then(setItems);
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!text.trim()) return;
    await fetch('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    setText('');
    load();
  };
  const toggle = async (id, done) => {
    await fetch('/api/items/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: !done }) });
    load();
  };
  const del = async (id) => {
    await fetch('/api/items/' + id, { method: 'DELETE' });
    load();
  };

  return (
    <div className="card">
      <h1>TITLE</h1>
      <form onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="输入内容" />
        <button type="submit">添加</button>
      </form>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <label>
              <input type="checkbox" checked={!!i.done} onChange={() => toggle(i.id, i.done)} /> {i.text}
            </label>
            <button onClick={() => del(i.id)}>删除</button>
          </li>
        ))}
      </ul>
      <p className="muted">{items.length} 条待办 · 数据本地持久化（server/data.json）</p>
    </div>
  );
}
`,

  ledger: `// React 19 记账组件（收入/支出 + 实时统计）
import { useEffect, useState } from 'react';

export default function App() {
  const [entries, setEntries] = useState([]);
  const [stats, setStats] = useState({ income: 0, expense: 0, balance: 0, count: 0 });
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('income');
  const [note, setNote] = useState('');

  const load = () => {
    fetch('/api/entries').then((r) => r.json()).then(setEntries);
    fetch('/api/stats').then((r) => r.json()).then(setStats);
  };
  useEffect(load, []);

  const add = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: n, type, note }),
    });
    setAmount('');
    setNote('');
    load();
  };

  return (
    <div className="card">
      <h1>TITLE</h1>
      <div className="stats">
        <span>收入 <b>{stats.income}</b></span>
        <span>支出 <b>{stats.expense}</b></span>
        <span>结余 <b>{stats.balance}</b></span>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="金额" />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="income">收入</option>
          <option value="expense">支出</option>
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注" />
        <button type="submit">记一笔</button>
      </form>
      <ul>
        {entries.map((e) => (
          <li key={e.id}>
            {e.type === 'income' ? '+' : '-'}{e.amount} {e.note}
            <span className="muted"> · {new Date(e.ts).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
`,

  note: `// React 19 笔记组件（全文搜索）
import { useEffect, useState } from 'react';

export default function App() {
  const [notes, setNotes] = useState([]);
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const search = (kw) => {
    const url = kw ? '/api/search?q=' + encodeURIComponent(kw) : '/api/notes';
    return fetch(url).then((r) => r.json()).then(setNotes);
  };
  useEffect(() => { search(''); }, []);

  const add = async () => {
    if (!title.trim()) return;
    await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) });
    setTitle('');
    setContent('');
    search(q);
  };

  return (
    <div className="card">
      <h1>TITLE</h1>
      <input value={q} onChange={(e) => { setQ(e.target.value); search(e.target.value); }} placeholder="搜索笔记…" />
      <form onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题" />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="内容" />
        <button type="submit">保存</button>
      </form>
      <ul>
        {notes.map((n) => (
          <li key={n.id}><b>{n.title}</b> {n.content}</li>
        ))}
      </ul>
      {!notes.length ? <p className="muted">无匹配笔记</p> : null}
    </div>
  );
}
`,

  anim: `// React 19 分镜组件（帧列表 + 播放器）
import { useEffect, useState } from 'react';

export default function App() {
  const [frames, setFrames] = useState([]);
  const [label, setLabel] = useState('');
  const [durationMs, setDurationMs] = useState(500);
  const [playing, setPlaying] = useState(false);
  const [active, setActive] = useState(-1);

  const load = () => fetch('/api/frames').then((r) => r.json()).then(setFrames);
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!label.trim()) return;
    await fetch('/api/frames', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, durationMs }) });
    setLabel('');
    load();
  };

  const play = async () => {
    if (!frames.length || playing) return;
    setPlaying(true);
    for (let i = 0; i < frames.length; i++) {
      setActive(i);
      await new Promise((r) => setTimeout(r, frames[i].durationMs || 500));
    }
    setActive(-1);
    setPlaying(false);
  };

  return (
    <div className="card">
      <h1>TITLE</h1>
      <form onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="帧描述" />
        <input type="number" min="100" step="100" value={durationMs} onChange={(e) => setDurationMs(Number(e.target.value) || 500)} />
        <button type="submit">加帧</button>
      </form>
      <button onClick={play} disabled={playing}>▶ 播放</button>
      <ul>
        {frames.map((f, i) => (
          <li key={f.id} className={i === active ? 'active' : ''}>
            {i + 1}. {f.label} <span className="muted">({f.durationMs}ms)</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
`,

  generic: `// React 19 通用条目组件（基线 CRUD）
import { useEffect, useState } from 'react';

export default function App() {
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');

  const load = () => fetch('/api/items').then((r) => r.json()).then(setItems);
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!text.trim()) return;
    await fetch('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    setText('');
    load();
  };
  const del = async (id) => {
    await fetch('/api/items/' + id, { method: 'DELETE' });
    load();
  };

  return (
    <div className="card">
      <h1>TITLE</h1>
      <form onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="输入内容" />
        <button type="submit">添加</button>
      </form>
      <ul>
        {items.map((i) => (
          <li key={i.id}>{i.text} <button onClick={() => del(i.id)}>删除</button></li>
        ))}
      </ul>
      <p className="muted">{items.length} 条 · 数据本地持久化（server/data.json）</p>
    </div>
  );
}
`,
};

// 各模具零依赖兜底（未 npm install 时页面仍可用——同一 API，诚实标注）
const MOLD_FALLBACK: Record<string, string> = {
  todo: `function vanillaFallback() {
  var root = document.getElementById('root');
  root.innerHTML = '<h1>TITLE</h1><p class="muted">⚠ 未构建前端（npm install && npm run build 后启用 React 19 版）——当前为零依赖兜底页</p><div><input id="t" placeholder="输入内容"><button onclick="vfAdd()">添加</button></div><ul id="l"></ul>';
  function load() {
    fetch('/api/items').then(function (r) { return r.json(); }).then(function (d) {
      document.getElementById('l').innerHTML = d.map(function (i) {
        return '<li>' + (i.done ? '✓ ' : '') + esc(i.text) + ' <button onclick="vfDel(' + i.id + ')">删除</button></li>';
      }).join('');
    });
  }
  window.vfAdd = function () {
    var t = document.getElementById('t');
    fetch('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t.value }) }).then(load);
    t.value = '';
  };
  window.vfDel = function (id) { fetch('/api/items/' + id, { method: 'DELETE' }).then(load); };
  load();
}`,

  ledger: `function vanillaFallback() {
  var root = document.getElementById('root');
  root.innerHTML = '<h1>TITLE</h1><p class="muted">⚠ 未构建前端（npm install && npm run build 后启用 React 19 版）——当前为零依赖兜底页</p><div class="stats" id="st"></div><div><input id="amt" type="number" placeholder="金额"><select id="typ"><option value="income">收入</option><option value="expense">支出</option></select><input id="note" placeholder="备注"><button onclick="vfAdd()">记一笔</button></div><ul id="l"></ul>';
  function load() {
    fetch('/api/stats').then(function (r) { return r.json(); }).then(function (s) {
      document.getElementById('st').innerHTML = '<span>收入 <b>' + s.income + '</b></span><span>支出 <b>' + s.expense + '</b></span><span>结余 <b>' + s.balance + '</b></span>';
    });
    fetch('/api/entries').then(function (r) { return r.json(); }).then(function (d) {
      document.getElementById('l').innerHTML = d.map(function (e) {
        return '<li>' + (e.type === 'income' ? '+' : '-') + e.amount + ' ' + esc(e.note || '') + '</li>';
      }).join('');
    });
  }
  window.vfAdd = function () {
    fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: Number(document.getElementById('amt').value), type: document.getElementById('typ').value, note: document.getElementById('note').value }) }).then(load);
  };
  load();
}`,

  note: `function vanillaFallback() {
  var root = document.getElementById('root');
  root.innerHTML = '<h1>TITLE</h1><p class="muted">⚠ 未构建前端（npm install && npm run build 后启用 React 19 版）——当前为零依赖兜底页</p><div><input id="q" placeholder="搜索笔记…" oninput="vfSearch(this.value)"></div><div><input id="ti" placeholder="标题"><input id="co" placeholder="内容"><button onclick="vfAdd()">保存</button></div><ul id="l"></ul>';
  function render(d) { document.getElementById('l').innerHTML = d.map(function (n) { return '<li><b>' + esc(n.title) + '</b> ' + esc(n.content || '') + '</li>'; }).join('') || '<li class="muted">无匹配笔记</li>'; }
  function load(url) { fetch(url).then(function (r) { return r.json(); }).then(render); }
  window.vfSearch = function (q) { load(q ? '/api/search?q=' + encodeURIComponent(q) : '/api/notes'); };
  window.vfAdd = function () {
    fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: document.getElementById('ti').value, content: document.getElementById('co').value }) }).then(function () { vfSearch(document.getElementById('q').value); });
  };
  load('/api/notes');
}`,

  anim: `function vanillaFallback() {
  var root = document.getElementById('root');
  root.innerHTML = '<h1>TITLE</h1><p class="muted">⚠ 未构建前端（npm install && npm run build 后启用 React 19 版）——当前为零依赖兜底页</p><div><input id="lb" placeholder="帧描述"><input id="du" type="number" value="500" step="100"><button onclick="vfAdd()">加帧</button></div><button onclick="vfPlay()">▶ 播放</button><ul id="l"></ul>';
  var frames = [];
  function render() { document.getElementById('l').innerHTML = frames.map(function (f, i) { return '<li id="f' + i + '">' + (i + 1) + '. ' + esc(f.label) + ' (' + f.durationMs + 'ms)</li>'; }).join(''); }
  function load() { fetch('/api/frames').then(function (r) { return r.json(); }).then(function (d) { frames = d; render(); }); }
  window.vfAdd = function () {
    fetch('/api/frames', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: document.getElementById('lb').value, durationMs: Number(document.getElementById('du').value) || 500 }) }).then(load);
  };
  window.vfPlay = async function () {
    for (var i = 0; i < frames.length; i++) {
      document.querySelectorAll('#l li').forEach(function (li) { li.className = ''; });
      var el = document.getElementById('f' + i);
      if (el) el.className = 'active';
      await new Promise(function (r) { setTimeout(r, frames[i].durationMs || 500); });
    }
  };
  load();
}`,

  generic: `function vanillaFallback() {
  var root = document.getElementById('root');
  root.innerHTML = '<h1>TITLE</h1><p class="muted">⚠ 未构建前端（npm install && npm run build 后启用 React 19 版）——当前为零依赖兜底页</p><div><input id="t" placeholder="输入内容"><button onclick="vfAdd()">添加</button></div><ul id="l"></ul>';
  function load() {
    fetch('/api/items').then(function (r) { return r.json(); }).then(function (d) {
      document.getElementById('l').innerHTML = d.map(function (i) { return '<li>' + esc(i.text) + ' <button onclick="vfDel(' + i.id + ')">删除</button></li>'; }).join('');
    });
  }
  window.vfAdd = function () {
    var t = document.getElementById('t');
    fetch('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t.value }) }).then(load);
    t.value = '';
  };
  window.vfDel = function (id) { fetch('/api/items/' + id, { method: 'DELETE' }).then(load); };
  load();
}`,
};

function genIndexHtml(mold: string, title: string): string {
  const fallback = (MOLD_FALLBACK[mold] ?? MOLD_FALLBACK.generic!).replaceAll('TITLE', title);
  const style = `body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;color:#222}
h1{font-size:1.4rem}.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px 20px}
input,select,textarea,button{padding:8px;margin:4px;font-size:14px;border:1px solid #ccc;border-radius:6px}
button{background:#2563eb;color:#fff;border-color:#2563eb;cursor:pointer}
ul{list-style:none;padding:0}li{padding:8px 0;border-bottom:1px solid #eee}
li.active{background:#fff7e0;font-weight:bold}.muted{color:#888;font-size:12px}
.stats span{margin-right:16px;font-size:15px}.stats b{color:#2563eb}`;

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>${style}</style></head>
<body>
<div id="root" class="card">加载中…</div>
<script src="dist/bundle.js" onerror="vanillaFallback()"></script>
<script>
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
${fallback}
</script>
</body></html>`;
}

function genPackageJson(mold: string, _title: string, summary: string): string {
  return JSON.stringify(
    {
      name: `wxnodus-gen-${mold}`,
      version: '1.0.0',
      description: summary,
      scripts: {
        start: 'node server/index.js',
        test: 'node --test server/*.test.js',
        build: 'esbuild public/src/main.jsx --bundle --outfile=public/dist/bundle.js --minify',
        'build:watch': 'esbuild public/src/main.jsx --bundle --outfile=public/dist/bundle.js --watch',
      },
      dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      devDependencies: { esbuild: '^0.24.0' },
    },
    null,
    2
  );
}

function genReadme(mold: string, spec: Spec): string {
  const api = {
    todo: 'GET/POST /api/items、PUT/DELETE /api/items/:id（勾选/删除）',
    ledger: 'GET/POST /api/entries（收支明细）、GET /api/stats（收入/支出/结余统计）',
    note: 'GET/POST /api/notes（笔记）、GET /api/search?q=（全文搜索）',
    anim: 'GET/POST /api/frames（帧列表：label + durationMs）',
    generic: 'GET/POST /api/items、DELETE /api/items/:id（基线 CRUD）',
  }[mold] ?? '';

  return `# ${spec.title}

${spec.summary}

## 技术栈（成熟组件）
- 服务端：node:http REST 分层（server/router.js 路由 / server/store.js 存储 / server/index.js 入口 + 统一错误处理）——零依赖
- 前端：React 19 + esbuild 打包（public/src/main.jsx → public/dist/bundle.js）
- 测试：node:test 冒烟测试（server/smoke.test.js——npm test 真实执行）

## 验收
${spec.acceptance.map((a) => `- ${a}`).join('\n')}

## 启动与验证
- \`npm start\` —— 零依赖即可运行（服务端纯 node:http）
- \`npm test\` —— 冒烟测试（node:test 内置，零依赖）
- \`npm install && npm run build\` —— 构建 React 19 前端（需联网拉取 react/esbuild）
- 未构建前端时页面自动回退零依赖兜底（同一 API，页面顶部有标注——诚实提示）

## API（模具：${mold}）
- GET /api/health —— 探活
- ${api}

## 数据
本地 JSON 持久化（server/data.json），重启不丢失。
`;
}

export function checkLeftover(projectDir: string): boolean {
  // 返回 true = 无残留（可交付）；false = 有残留槽位
  const files = [join(projectDir, 'server', 'index.js'), join(projectDir, 'public', 'index.html'), join(projectDir, 'README.md')];
  for (const f of files) {
    if (existsSync(f) && LEFTOVER_RE.test(readFileSync(f, 'utf8'))) return false;
  }
  return true;
}

export function instantiate(spec: Spec, projectDir: string): InstantiateResult {
  try {
    for (const sub of ['server', 'public', 'public/src']) mkdirSync(join(projectDir, sub), { recursive: true });
    const mold = spec.scaffold === 'todo' || spec.scaffold === 'ledger' || spec.scaffold === 'note' || spec.scaffold === 'anim' ? spec.scaffold : 'generic';
    const title = spec.title || '项目';
    writeFileSync(join(projectDir, 'server', 'index.js'), genServer(mold, title), 'utf8');
    writeFileSync(join(projectDir, 'server', 'router.js'), ROUTER_JS, 'utf8');
    writeFileSync(join(projectDir, 'server', 'store.js'), STORE_JS, 'utf8');
    writeFileSync(join(projectDir, 'server', 'smoke.test.js'), genSmokeTest(mold), 'utf8');
    writeFileSync(join(projectDir, 'public', 'index.html'), genIndexHtml(mold, title), 'utf8');
    writeFileSync(join(projectDir, 'public', 'src', 'main.jsx'), MAIN_JSX, 'utf8');
    writeFileSync(join(projectDir, 'public', 'src', 'App.jsx'), (MOLD_APP[mold] ?? MOLD_APP.generic!).replaceAll('TITLE', title), 'utf8');
    writeFileSync(join(projectDir, 'README.md'), genReadme(mold, spec), 'utf8');
    writeFileSync(join(projectDir, 'package.json'), genPackageJson(mold, title, spec.summary), 'utf8');
    writeFileSync(join(projectDir, 'healthcheck.js'), `// healthcheck：启动→探活→读回\nconst http = require('node:http');\nhttp.get('http://127.0.0.1:' + (process.env.PORT || 4321) + '/api/health', r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ console.log(b); process.exit(r.statusCode===200?0:1); }); }).on('error', () => process.exit(1));\n`, 'utf8');
    if (!checkLeftover(projectDir)) {
      return { ok: false, reason: '残留槽位（LEFTOVER）未替换' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message };
  }
}
