// src/presentation/http/flowPage.ts — /flow 管线流图可视化（2026-08-27）
// 理念参考：deepseek flow 等可视化插件——把 pipeline 画成流图并随事件实时点亮；实现原创：
//   - 纯静态单文件页面（零外部资源、CSP 严格内联、Cache-Control no-store）——零网络泄漏、气隙可用；
//   - 六阶段 = wxnodus 真实管线（durable queue → 策略裁决 → 模型调用 → 工具执行 → 事件流 → 审计），
//     每阶段标注真实实现文件路径（证据可复核）；
//   - 实时模式：页面内输入 --serve token（仅存 sessionStorage、同源 fetch 流式读取 /events SSE——
//     浏览器 EventSource 无法携带 Authorization 头，故用 fetch 流，网关认证面不变、不弱化）；
//   - 无 token = 纯静态浏览（不发起任何网络连接）。
export interface FlowPageOptions {
  version?: string;
}

/** 六阶段管线模型（与 README/协议文档口径一致；file 为真实实现锚点） */
export const FLOW_STAGES = [
  { id: 'queue', title: '① 用户输入入队', file: 'kernel/durableQueue.ts', note: '持久队列 · 崩溃恢复' },
  { id: 'policy', title: '② 策略裁决', file: 'infrastructure/policy/policyLayers.ts', note: '三层策略 · deny>ask>allow' },
  { id: 'llm', title: '③ 模型调用', file: 'kernel/llmStream.ts', note: 'DSH 1–4 横切 · 私有端点' },
  { id: 'tools', title: '④ 工具执行', file: 'kernel/agent.ts', note: 'canonical 缓存 · 沙盒' },
  { id: 'events', title: '⑤ 事件流', file: 'protocol/events.ts', note: 'wire/serve SSE 广播' },
  { id: 'audit', title: '⑥ 审计', file: 'kernel/audit.ts', note: '哈希链 · 本地落盘' },
] as const;

/** 事件类型 → 阶段映射（/events SSE 已订阅事件集） */
export const FLOW_EVENT_STAGE: Record<string, string> = {
  'agent.start': 'queue',
  'agent.token': 'llm',
  'agent.message': 'llm',
  'agent.tool': 'tools',
  'agent.end': 'audit',
  'agent.error': 'events',
  'run.final': 'audit',
  'system.notice': 'audit',
  'voice.transcript': 'events',
  'session.changed': 'events',
};

export const FLOW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

/** 渲染 /flow 单文件页面（纯函数；不注入任何请求参数——session_id 由页面 JS 从自身 URL 读取并转交） */
export function renderFlowHtml(opts: FlowPageOptions = {}): string {
  const version = String(opts.version ?? '').replace(/[<>&"]/g, '');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${FLOW_CSP}">
<title>wxnodus 管线流图</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 24px; background: #0d1117; color: #c9d1d9;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; color: #f0f6fc; }
.sub { color: #8b949e; font-size: 12px; margin-bottom: 20px; }
.chain { display: flex; flex-wrap: wrap; align-items: stretch; gap: 0; }
.stage { flex: 1 1 150px; min-width: 140px; border: 1px solid #30363d; border-radius: 8px;
  background: #161b22; padding: 12px 10px; margin: 6px 0; position: relative; transition: box-shadow .25s, border-color .25s; }
.stage .t { font-size: 13px; color: #f0f6fc; }
.stage .f { font-family: Consolas, monospace; font-size: 10px; color: #58a6ff; margin: 6px 0 4px; word-break: break-all; }
.stage .n { font-size: 11px; color: #8b949e; }
.stage .cnt { position: absolute; top: 8px; right: 10px; font-size: 11px; color: #8b949e; }
.stage.flash { border-color: #58a6ff; box-shadow: 0 0 12px rgba(88,166,255,.45); }
.arrow { align-self: center; padding: 0 4px; color: #484f58; font-size: 18px; }
.panel { margin-top: 24px; border: 1px solid #30363d; border-radius: 8px; background: #161b22; padding: 12px 14px; }
.panel h2 { font-size: 13px; margin: 0 0 8px; color: #f0f6fc; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
input[type=password], input[type=text] { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d;
  border-radius: 6px; padding: 6px 8px; font-size: 12px; min-width: 220px; }
button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px;
  padding: 6px 14px; font-size: 12px; cursor: pointer; }
button:hover { background: #30363d; }
button:disabled { opacity: .5; cursor: not-allowed; }
.status { font-size: 12px; color: #8b949e; }
.status.ok { color: #3fb950; }
.status.err { color: #f85149; }
#log { font-family: Consolas, monospace; font-size: 11px; color: #8b949e; max-height: 220px;
  overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
#log b { color: #58a6ff; font-weight: normal; }
.foot { margin-top: 16px; font-size: 11px; color: #484f58; }
</style>
</head>
<body>
<h1>wxnodus 管线流图</h1>
<div class="sub">六阶段管线 = 真实执行路径（每阶段标注实现文件锚点）· 实时模式经 /events SSE 点亮 · 数据不出机</div>
<div class="chain" id="chain"></div>

<div class="panel">
  <h2>实时模式（可选）</h2>
  <div class="row">
    <span class="status" id="st">静态浏览：未连接事件流</span>
    <input id="token" type="password" placeholder="--serve token（仅存本页 sessionStorage）" autocomplete="off">
    <button id="go">连接 /events</button>
    <button id="stop" disabled>断开</button>
  </div>
  <div class="sub" style="margin-top:6px">浏览器 EventSource 无法携带 Authorization 头，实时流使用同源 fetch 流式读取；token 不落盘、不跨源、刷新后需重输。</div>
</div>

<div class="panel">
  <h2>事件日志（最近 50 条）</h2>
  <div id="log">（暂无）</div>
</div>

<div class="foot">wxnodus ${version} · 本页零外部资源 · 事件经同源 /events（Bearer）</div>

<script>
const STAGES = ${JSON.stringify(FLOW_STAGES.map(s => ({ id: s.id, title: s.title, file: s.file, note: s.note })))};
const EVENT_STAGE = ${JSON.stringify(FLOW_EVENT_STAGE)};
const chain = document.getElementById('chain');
const logBox = document.getElementById('log');
const st = document.getElementById('st');
const tokenInput = document.getElementById('token');
const goBtn = document.getElementById('go');
const stopBtn = document.getElementById('stop');
const counts = Object.fromEntries(STAGES.map(s => [s.id, 0]));
const logLines = [];

STAGES.forEach((s, i) => {
  if (i > 0) { const a = document.createElement('span'); a.className = 'arrow'; a.textContent = '\\u2192'; chain.appendChild(a); }
  const box = document.createElement('div');
  box.className = 'stage';
  box.id = 'stage-' + s.id;
  box.innerHTML = '<div class="t"></div><div class="f"></div><div class="n"></div><div class="cnt">0</div>';
  box.querySelector('.t').textContent = s.title;
  box.querySelector('.f').textContent = s.file;
  box.querySelector('.n').textContent = s.note;
  chain.appendChild(box);
});

function setStatus(text, cls) { st.textContent = text; st.className = 'status' + (cls ? ' ' + cls : ''); }
function addLog(eventName, detail) {
  logLines.push(eventName + '  ' + detail);
  if (logLines.length > 50) logLines.shift();
  logBox.innerHTML = logLines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/^(\\S+)/, '<b>$1</b>')).join('\\n') || '（暂无）';
}
function flash(stageId) {
  const el = document.getElementById('stage-' + stageId);
  if (!el) return;
  counts[stageId]++;
  el.querySelector('.cnt').textContent = String(counts[stageId]);
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 600);
}

let ctrl = null;
let reconnectDelay = 500;
function disconnect() {
  if (ctrl) { ctrl.abort(); ctrl = null; }
  goBtn.disabled = false;
  stopBtn.disabled = true;
}
stopBtn.onclick = disconnect;

async function connect() {
  disconnect();
  const token = tokenInput.value.trim();
  const sid = new URLSearchParams(window.location.search).get('session_id') || '';
  if (!token) { setStatus('需要 --serve token 才能订阅事件流', 'err'); return; }
  if (!sid) { setStatus('URL 缺少 session_id 参数（如 /flow?session_id=xxx）', 'err'); return; }
  try { sessionStorage.setItem('wxn-flow-token', token); } catch { /* 忽略存储失败 */ }
  goBtn.disabled = true;
  stopBtn.disabled = false;
  ctrl = new AbortController();
  setStatus('连接中…');
  const connectOnce = async () => {
    try {
      const url = '/events?' + new URLSearchParams({ session_id: sid }).toString();
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal });
      if (!res.ok || !res.body) {
        setStatus('连接失败：HTTP ' + res.status + (res.status === 401 ? '（token 无效）' : ''), 'err');
        disconnect();
        return;
      }
      setStatus('已连接：事件流实时点亮中', 'ok');
      reconnectDelay = 500;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\\n\\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventMatch = /^event: (\\S+)/m.exec(chunk);
          const dataMatch = /^data: (.+)$/m.exec(chunk);
          if (!eventMatch) continue;
          const name = eventMatch[1];
          const stage = EVENT_STAGE[name];
          if (stage) flash(stage);
          let detail = '';
          if (dataMatch) {
            try {
              const d = JSON.parse(dataMatch[1]);
              const cand = d.text ?? d.type ?? d.reason ?? (d.connected === true ? 'connected' : null);
              detail = cand !== null && cand !== undefined ? String(cand).slice(0, 80) : dataMatch[1].slice(0, 80);
            } catch { detail = dataMatch[1].slice(0, 80); }
          }
          addLog(name, detail);
        }
      }
      if (ctrl) { setStatus('事件流已结束（可重新连接）'); disconnect(); }
    } catch (e) {
      if (ctrl && e.name !== 'AbortError') {
        setStatus('连接中断，' + (reconnectDelay / 1000) + 's 后重连…', 'err');
        await new Promise(r => setTimeout(r, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, 8000);
        if (ctrl) connectOnce();
      }
    }
  };
  void connectOnce();
}
goBtn.onclick = connect;

try {
  const saved = sessionStorage.getItem('wxn-flow-token');
  if (saved) tokenInput.value = saved;
} catch { /* 忽略 */ }
</script>
</body>
</html>
`;
}
