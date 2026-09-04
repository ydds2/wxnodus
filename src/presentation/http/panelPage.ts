// src/presentation/http/panelPage.ts — /panel HTML 配置面板（2026-09-04 · 用户需求：命令全景动态配置）
// 范式沿 flowPage：纯静态单文件 HTML（CSP 严格内联、零外部资源、Cache-Control no-store）——
// 气隙可用、零网络泄漏。数据注入：命令目录（SLASH/DESC/CAT/CORE 由 serve 端 import registry
// 注入——面板零拉取即有全量目录）+ 版本。交互通道：POST /api/rpc（Bearer token →
// method:command → CommandBus——内核审批链/硬红线/审计全生效，浏览器只是另一个前端）。
// 危险面：前端二次确认（DANGEROUS 正则清单——仅 UI 层提示，内核防线不变）。
export interface PanelCatalog {
  slash: string[];
  desc: Record<string, string>;
  cat: Record<string, string>;
  core: string[];
}

export interface PanelPageOptions {
  version?: string;
  catalog: PanelCatalog;
}

/** 前端二次确认的危险命令清单（正则，匹配命令头+参数）——内核审批链独立生效不受此影响 */
const DANGEROUS_RULES: Array<{ re: string; label: string }> = [
  { re: '^/perm\\b', label: '权限模式变更' },
  { re: '^/sudo\\b', label: '提权执行' },
  { re: '^/model set-key\\b', label: '密钥写入' },
  { re: '^/encrypt\\b|^/key', label: '密钥面' },
  { re: '^/reset\\b', label: '重置' },
  { re: '^/bundle (publish|create)', label: '对外发布' },
  { re: '^/market (install|remove)\\b|^/plugin (install|uninstall|remove)\\b', label: '安装/卸载外部代码' },
  { re: '^/channel (apply|switch)\\b|^/update (apply|--apply)\\b', label: '版本切换/自升级' },
  { re: '^/self-evolve\\b', label: '自举改码' },
];

export const PANEL_MODES: Array<{ id: string; label: string; warn?: string }> = [
  { id: 'smart', label: 'Smart 智能' },
  { id: 'auto', label: 'Auto 自动' },
  { id: 'manual', label: 'Manual 手动' },
  { id: 'plan', label: 'Plan 计划' },
  { id: 'goal', label: 'Goal 目标' },
  { id: 'yolo', label: 'YOLO', warn: 'YOLO：全部自动批准（硬红线仍在）——确认要放飞？' },
];

/** 单文件 HTML（内联 CSS/JS；JSON 注入经 safeJsonForHtml 转义 </script 防闭合逃逸） */
export function renderPanelPage(opts: PanelPageOptions): string {
  const v = opts.version ?? '';
  const catNames: Record<string, string> = {
    '⚙': '设置', '⛨': '安全', '⬡': '生态', '❖': '集成', '◆': '面板',
  };
  const data = {
    slash: opts.catalog.slash,
    desc: opts.catalog.desc,
    cat: opts.catalog.cat,
    core: opts.catalog.core,
    modes: PANEL_MODES,
    dangerous: DANGEROUS_RULES,
    catNames,
    version: v,
  };
  const json = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WxNodus 配置面板</title>
<style>
  :root{--bg:#0c0f14;--bg2:#131820;--fg:#cfd8e3;--dim:#7a8699;--acc:#4cc2ff;--ok:#3fd68f;--warn:#ffb64c;--err:#ff6b6b;--line:#232b38}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Cascadia Code",Consolas,"Microsoft YaHei",monospace}
  header{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--bg2);flex-wrap:wrap}
  header h1{font-size:16px;margin:0;color:var(--acc)}
  header .v{color:var(--dim);font-size:12px}
  .modes{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
  .mode{padding:3px 10px;border:1px solid var(--line);border-radius:12px;cursor:pointer;font-size:12px;color:var(--dim)}
  .mode.on{color:var(--acc);border-color:var(--acc)}
  .mode.yolo{color:var(--err)}
  nav{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid var(--line);background:var(--bg2)}
  nav button{background:none;border:none;color:var(--dim);padding:9px 16px;cursor:pointer;font:inherit;border-bottom:2px solid transparent}
  nav button.on{color:var(--fg);border-bottom-color:var(--acc)}
  main{padding:18px 20px;max-width:1180px;margin:0 auto}
  .search{width:100%;max-width:520px;padding:8px 12px;background:var(--bg2);border:1px solid var(--line);border-radius:6px;color:var(--fg);font:inherit;margin-bottom:14px}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
  .chip{padding:2px 10px;border-radius:10px;border:1px solid var(--line);cursor:pointer;font-size:12px;color:var(--dim)}
  .chip.on{color:var(--acc);border-color:var(--acc)}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:8px}
  .card{background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:8px 12px;cursor:pointer}
  .card .nm{color:var(--acc);font-weight:600}
  .card .ds{color:var(--dim);font-size:12px;margin-top:2px}
  .card .ex{display:none;margin-top:8px}
  .card.open .ex{display:block}
  .ex input{width:100%;padding:6px 8px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--fg);font:inherit}
  .ex .row{display:flex;gap:8px;margin-top:6px;align-items:center}
  .btn{background:var(--acc);color:#00131f;border:none;border-radius:4px;padding:6px 16px;cursor:pointer;font:inherit;font-weight:600}
  .btn.ghost{background:none;border:1px solid var(--line);color:var(--fg)}
  .btn:disabled{opacity:.45;cursor:wait}
  pre.out{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px 10px;white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:280px;overflow:auto;margin-top:8px}
  .ok{color:var(--ok)} .err{color:var(--err)}
  .toast{position:fixed;bottom:18px;right:18px;background:var(--bg2);border:1px solid var(--acc);border-radius:6px;padding:10px 16px;display:none;max-width:420px}
  .dlg{position:fixed;inset:0;background:rgba(4,6,10,.72);display:none;align-items:center;justify-content:center}
  .dlg .box{background:var(--bg2);border:1px solid var(--warn);border-radius:8px;padding:18px 22px;max-width:460px}
  .dlg .box h3{margin:0 0 8px;color:var(--warn);font-size:15px}
  .dlg .box .cmd{color:var(--acc);word-break:break-all;margin:8px 0}
  footer{padding:12px 20px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
  .plug-result{margin-top:10px}
</style>
</head>
<body>
<header>
  <h1>◈ WxNodus 配置面板</h1><span class="v"></span>
  <div class="modes" id="modes"></div>
</header>
<nav>
  <button data-tab="cmd" class="on">命令面板</button>
  <button data-tab="plug">插件中心</button>
  <button data-tab="cfg">配置</button>
</nav>
<main>
  <section id="tab-cmd">
    <input class="search" id="q" placeholder="搜索命令（名称/描述）… 共 0 条">
    <div class="chips" id="chips"></div>
    <div class="cards" id="cards"></div>
  </section>
  <section id="tab-plug" style="display:none">
    <div class="row" style="display:flex;gap:8px">
      <input class="search" id="pq" placeholder="搜索生态目录（npm/GitHub：MCP / 技能）…" style="margin-bottom:0">
      <button class="btn" id="psearch">搜索</button>
    </div>
    <pre class="out plug-result" id="pout" style="display:none"></pre>
    <p style="color:var(--dim);font-size:12px">安装/卸载在命令面板执行（/market install、/plugin uninstall——危险面二次确认）。</p>
  </section>
  <section id="tab-cfg" style="display:none">
    <div class="row" style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn ghost" id="cfg-load">读取当前配置（/config export）</button>
      <button class="btn ghost" id="plug-list">已装插件（/plugins）</button>
      <button class="btn ghost" id="doctor">全组件体检（/doctor）</button>
    </div>
    <pre class="out" id="cfgout" style="display:none"></pre>
  </section>
</main>
<div class="toast" id="toast"></div>
<div class="dlg" id="dlg"><div class="box">
  <h3 id="dlg-title">危险操作确认</h3>
  <div id="dlg-body"></div>
  <div class="cmd" id="dlg-cmd"></div>
  <div class="row" style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
    <button class="btn ghost" id="dlg-no">取消</button>
    <button class="btn" id="dlg-yes" style="background:var(--err);color:#1a0505">确认执行</button>
  </div>
</div></div>
<footer>所有执行经本机回环 → CommandBus（权限模式 / 硬红线 / 审计哈希链照常生效）· 面板 token 仅存本页 sessionStorage · 关闭 TUI 即失效</footer>
<script>
const D = ${json};
// token：URL ?t= → sessionStorage（后续 fetch 复用；TUI /panel 打开时自动携带）
(() => { const t = new URLSearchParams(location.search).get('t'); if (t) sessionStorage.setItem('wxn-panel-token', t); })();
const TOKEN = sessionStorage.getItem('wxn-panel-token') || '';
document.querySelector('header .v').textContent = D.version ? 'v' + D.version : '';
document.getElementById('q').placeholder = '搜索命令（名称/描述）… 共 ' + D.slash.length + ' 条';

let curCat = '全部', curMode = '';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ── 模式切换（/perm <mode>——内核裁决照常）──
function renderModes() {
  const el = document.getElementById('modes'); el.innerHTML = '';
  for (const m of D.modes) {
    const b = document.createElement('span');
    b.className = 'mode' + (m.id === 'yolo' ? ' yolo' : '') + (m.id === curMode ? ' on' : '');
    b.textContent = m.label;
    b.onclick = () => {
      if (m.id === curMode) return;
      const cmd = '/perm ' + m.id;
      const go = () => rpc(cmd, r => { curMode = m.id; renderModes(); toast('模式已切换：' + m.label); });
      if (m.warn) ask('切换确认', m.warn, cmd, go); else go();
    };
    el.appendChild(b);
  }
}
// 启动拉取当前模式（/status 输出含 mode——诚实展示）
rpcQuiet('/status', out => { const m = /mode[：:]\\s*(smart|auto|manual|plan|yolo|goal)/i.exec(out || ''); if (m) { curMode = m[1].toLowerCase(); renderModes(); } });

// ── 命令面板 ──
const cats = ['全部', ...Object.keys(D.catNames).filter(c => D.slash.some(s => D.cat[s] === c))];
function renderChips() {
  const el = document.getElementById('chips'); el.innerHTML = '';
  for (const c of cats) {
    const s = document.createElement('span');
    s.className = 'chip' + (c === curCat ? ' on' : '');
    s.textContent = c === '全部' ? '全部' : (D.catNames[c] || c) + ' ' + c;
    s.onclick = () => { curCat = c; renderChips(); renderCards(); };
    el.appendChild(s);
  }
}
function dangerOf(cmd) { for (const d of D.dangerous) if (new RegExp(d.re, 'i').test(cmd)) return d.label; return null; }
function renderCards() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const el = document.getElementById('cards'); el.innerHTML = '';
  for (const name of D.slash) {
    const ds = D.desc[name] || '';
    if (curCat !== '全部' && (D.cat[name] || '') !== curCat) continue;
    if (q && !name.includes(q) && !ds.toLowerCase().includes(q)) continue;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="nm">' + esc(name) + (D.core.includes(name) ? ' <span style="color:var(--dim);font-size:11px">core</span>' : '') + '</div>'
      + '<div class="ds">' + esc(ds) + '</div>'
      + '<div class="ex"><input placeholder="参数（可空）——例：search mcp 或 on"><div class="row">'
      + '<button class="btn" style="padding:4px 14px">执行</button><span class="res" style="color:var(--dim);font-size:12px"></span></div>'
      + '<pre class="out" style="display:none"></pre></div>';
    const input = card.querySelector('input'), out = card.querySelector('pre'), res = card.querySelector('.res');
    const btn = card.querySelector('.btn');
    card.addEventListener('click', e => { if (e.target === btn || e.target === input) return; card.classList.toggle('open'); });
    btn.onclick = async () => {
      const cmd = name + (input.value.trim() ? ' ' + input.value.trim() : '');
      const run = () => exec(cmd, out, res, btn);
      const danger = dangerOf(cmd);
      if (danger) ask('危险操作确认', '「' + danger + '」类命令——内核权限链照常裁决，此处仅提示。', cmd, run); else run();
    };
    el.appendChild(card);
  }
  if (!el.children.length) el.innerHTML = '<p style="color:var(--dim)">无匹配命令</p>';
}
document.getElementById('q').addEventListener('input', renderCards);

// ── 插件中心 / 配置 ──
document.getElementById('psearch').onclick = () => {
  const q = document.getElementById('pq').value.trim();
  if (!q) { toast('请输入搜索词'); return; }
  exec('/market search ' + q, document.getElementById('pout'), null, document.getElementById('psearch'));
  document.getElementById('pout').style.display = 'block';
};
document.getElementById('cfg-load').onclick = () => exec('/config export', document.getElementById('cfgout'), null, null) || (document.getElementById('cfgout').style.display = 'block');
document.getElementById('plug-list').onclick = () => { document.getElementById('cfgout').style.display = 'block'; exec('/plugins', document.getElementById('cfgout'), null, null); };
document.getElementById('doctor').onclick = () => { document.getElementById('cfgout').style.display = 'block'; exec('/doctor', document.getElementById('cfgout'), null, null); };
for (const b of document.querySelectorAll('nav button')) b.onclick = () => {
  for (const x of document.querySelectorAll('nav button')) x.classList.toggle('on', x === b);
  for (const s of ['cmd','plug','cfg']) document.getElementById('tab-' + s).style.display = b.dataset.tab === s ? '' : 'none';
};

// ── 通道 ──
async function rpc(method, body) {
  const r = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ method, ...body }) });
  return r.json();
}
async function exec(cmd, outEl, resEl, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '执行中…'; }
  try {
    const j = await rpc('command', { command: cmd });
    if (outEl) { outEl.style.display = 'block'; outEl.textContent = j.ok ? (j.output || '（无输出）') : '✗ ' + (j.error || j.output || '失败'); outEl.className = 'out ' + (j.ok ? 'ok' : 'err'); }
    if (resEl) resEl.textContent = j.ok ? '✓ 完成' : '✗ 失败';
    return j;
  } catch (e) {
    if (outEl) { outEl.style.display = 'block'; outEl.textContent = '✗ 通道错误：' + (e && e.message || e); outEl.className = 'out err'; }
    if (resEl) resEl.textContent = '✗ 通道错误';
  } finally { if (btn) { btn.disabled = false; btn.textContent = '执行'; } }
}
async function rpcQuiet(cmd, cb) { try { const j = await rpc('command', { command: cmd }); if (j && j.ok) cb(j.output || ''); } catch {} }
function toast(t) { const el = document.getElementById('toast'); el.textContent = t; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 2600); }
let dlgFn = null;
function ask(title, body, cmd, yes) {
  document.getElementById('dlg-title').textContent = title;
  document.getElementById('dlg-body').textContent = body;
  document.getElementById('dlg-cmd').textContent = cmd;
  document.getElementById('dlg').style.display = 'flex';
  dlgFn = yes;
}
document.getElementById('dlg-no').onclick = () => { document.getElementById('dlg').style.display = 'none'; dlgFn = null; };
document.getElementById('dlg-yes').onclick = () => { document.getElementById('dlg').style.display = 'none'; const f = dlgFn; dlgFn = null; if (f) f(); };
if (!TOKEN) toast('未携带 token——只读页面（从 TUI 执行 /panel 自动带 token 打开）');

renderModes(); renderChips(); renderCards();
</script>
</body>
</html>`;
}
