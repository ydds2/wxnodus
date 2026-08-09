// src/build/scaffold.ts — L3-1 脚手架（模具实例化）
// 设计：按规格生成可运行项目骨架（server/public/README/package.json/evidence 占位）
//       LEFTOVER 残留槽位检测（占位符未替换 = 拒交付）
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Spec } from './spec.js';

export interface InstantiateResult { ok: boolean; reason?: string }

const LEFTOVER_RE = /LEFTOVER|__TITLE__|__SUMMARY__|__PORT__/;

function genServer(title: string): string {
  return `// ${title} — 自动生成服务（WxNodus 概念编译器产物）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const PORT = process.env.PORT || 4321;
const DB = path.join(__dirname, 'data.json');
const read = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
const write = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/api/items') { res.end(JSON.stringify(read())); return; }
  if (req.method === 'POST' && req.url === '/api/items') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => { const d = read(); d.push(JSON.parse(body)); write(d); res.end(JSON.stringify({ ok: true })); });
    return;
  }
  if (req.url === '/api/health') { res.end(JSON.stringify({ ok: true, items: read().length })); return; }
  res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' }));
});
server.listen(PORT, () => console.log('listening on ' + PORT));
module.exports = server;
`;
}

function genPublic(): string {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>__TITLE__</title>
<style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px}
input,button{padding:8px;margin:4px}li{padding:6px 0}</style></head>
<body><h1>__TITLE__</h1><div><input id="t" placeholder="输入内容"><button onclick="add()">添加</button></div>
<ul id="list"></ul>
<script>
async function load(){const r=await fetch('/api/items');const d=await r.json();document.getElementById('list').innerHTML=d.map(x=>'<li>'+x.text+'</li>').join('')}
async function add(){const t=document.getElementById('t');await fetch('/api/items',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t.value})});t.value='';load()}
load();
</script></body></html>`;
}

export function checkLeftover(projectDir: string): boolean {
  // 返回 true = 无残留（可交付）；false = 有残留槽位
  const files = [join(projectDir, 'server', 'index.js'), join(projectDir, 'public', 'index.html'), join(projectDir, 'README.md')];
  for (const f of files) {
    if (existsSync(f) && LEFTOVER_RE.test(readFileSync(f, 'utf8'))) return false;
  }
  return true;
}

export function instantiate(spec: Spec, projectDir: string, _opts: { checkLeftover?: boolean } = {}): InstantiateResult {
  try {
    for (const sub of ['server', 'public']) mkdirSync(join(projectDir, sub), { recursive: true });
    const title = spec.title || '项目';
    writeFileSync(join(projectDir, 'server', 'index.js'), genServer(title), 'utf8');
    writeFileSync(join(projectDir, 'public', 'index.html'), genPublic().replaceAll('__TITLE__', title), 'utf8');
    writeFileSync(join(projectDir, 'README.md'), `# ${title}\n\n${spec.summary}\n\n## 验收\n${spec.acceptance.map(a => `- ${a}`).join('\n')}\n`, 'utf8');
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'gen-project', version: '1.0.0', scripts: { start: 'node server/index.js' } }, null, 2), 'utf8');
    writeFileSync(join(projectDir, 'healthcheck.js'), `// healthcheck：启动→探活→读回\nconst http = require('node:http');\nhttp.get('http://127.0.0.1:' + (process.env.PORT || 4321) + '/api/health', r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ console.log(b); process.exit(r.statusCode===200?0:1); }); }).on('error', () => process.exit(1));\n`, 'utf8');
    if (!checkLeftover(projectDir)) {
      return { ok: false, reason: '残留槽位（LEFTOVER）未替换' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message };
  }
}
