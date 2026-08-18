// packages/vscode-ext/src/extension.ts — WxNodus VS Code 伴侣插件（supremacy 2.1）
// 架构（参考 codex vscode 扩展 + wxnodus --wire 协议，实现原创）：
//   spawn `wxnodus -p <提问> --wire --data-dir <globalStorage>` → stdout JSONL 事件流 → webview 渲染；
//   approval.request/clarify.request/secret.request/form.request → vscode 原生模态（showWarningMessage/
//   showInputBox）→ stdin 回 responder 帧（approval.respond/clarify.respond/…）→ wire.response 闭环。
// 契约锚点：docs/wire-protocol.md v1（本仓库根）；本地 vsix 发布不受 S-01 阻塞（上架 marketplace 才需要 token）。
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseWireLine, encodeWireFrame, approvalModalText, approvalAnswer, textAnswer,
  isTerminalEvent, type WireEvent,
} from './wireBridge.js';

let output: vscode.OutputChannel;
let currentChild: import('node:child_process').ChildProcessWithoutNullStreams | null = null;

/** 渲染面板（webview）：agent.token/message/tool 事件 → 消息列表 */
let panel: vscode.WebviewPanel | null = null;

const post = (msg: unknown) => { panel?.webview.postMessage(msg); };
const log = (s: string) => { output.appendLine(s); post({ kind: 'log', text: s }); };

/** spawn --wire 子进程并接线事件流（返回 child；失败弹错误并返回 null） */
function spawnWire(prompt: string, onEvent: (ev: WireEvent) => void): import('node:child_process').ChildProcessWithoutNullStreams | null {
  const cfg = vscode.workspace.getConfiguration('wxnodus');
  const bin: string = cfg.get('bin', 'wxnodus');
  const dataDir: string = cfg.get('dataDir', '') || join(vscode.extensions.getExtension('wxnodus.wxnodus-vscode')?.extensionUri.fsPath ?? '.', 'data');
  const mode: string = cfg.get('mode', 'smart');
  try { mkdirSync(dataDir, { recursive: true }); } catch { /* 目录创建失败继续（CLI 自建） */ }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const isJsPath = bin.endsWith('.js') && existsSync(bin);
  const child = spawn(
    isJsPath ? process.execPath : bin,
    isJsPath ? [bin, '--data-dir', dataDir, '-p', prompt, '--wire', '--mode', mode]
      : ['--data-dir', dataDir, '-p', prompt, '--wire', '--mode', mode],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  currentChild = child;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const ev = parseWireLine(line);
      if (!ev) continue;
      try { onEvent(ev); } catch (e: any) { log(`事件处理异常：${String(e?.message ?? e)}`); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => log(String(c).trim()));
  child.on('close', (code) => { log(`回合结束（退出码 ${code ?? '?'}）`); post({ kind: 'done' }); currentChild = null; });
  child.on('error', (e: any) => {
    const hint = /ENOENT/i.test(String(e?.message ?? e)) ? '——未找到 wxnodus 可执行文件：先 npm link，或在设置 wxnodus.bin 填绝对路径' : '';
    vscode.window.showErrorMessage(`wxnodus 启动失败：${String(e?.message ?? e).slice(0, 200)}${hint}`);
    log(`启动失败：${String(e?.message ?? e)}`);
    currentChild = null;
  });
  return child;
}

/** responder 帧写入（stdin 帧通道） */
const send = (frame: { method: string; params: Record<string, unknown> }) => {
  try { currentChild?.stdin.write(encodeWireFrame(frame)); } catch { /* 子进程已退出静默 */ }
};

/** 请求处理（审批/澄清/密钥/表单 → vscode 模态 → responder 帧） */
async function handleRequest(ev: WireEvent) {
  const id = String(ev.request_id ?? '');
  switch (ev.type) {
    case 'approval.request': {
      const { title, detail } = approvalModalText(ev);
      const pick = await vscode.window.showWarningMessage(title, { modal: true, detail }, { title: 'Allow' }, { title: 'Allow session' }, { title: 'Deny' });
      if (!pick) { send(approvalAnswer(id, 'deny')); return; }
      const ans = pick.title === 'Allow' ? 'allow' : pick.title === 'Allow session' ? 'session' : 'deny';
      send(approvalAnswer(id, ans));
      return;
    }
    case 'clarify.request': {
      const answer = await vscode.window.showInputBox({ prompt: String(ev.question ?? ''), placeHolder: '回答（回车提交）' });
      send(textAnswer('clarify.respond', id, answer ?? ''));
      return;
    }
    case 'secret.request': {
      const answer = await vscode.window.showInputBox({ prompt: String(ev.prompt ?? ''), password: true });
      send(textAnswer('secret.respond', id, answer ?? ''));
      return;
    }
    case 'form.request': {
      const fields = Array.isArray(ev.fields) ? ev.fields as Array<{ name: string; label?: string; kind: string }> : [];
      const values: Record<string, string> = {};
      for (const f of fields) {
        const v = await vscode.window.showInputBox({ prompt: f.label ?? f.name, password: f.kind === 'password' || f.kind === 'key' });
        if (v === undefined) { send({ method: 'credential_form.respond', params: { request_id: id, value: null } }); return; }
        values[f.name] = v;
      }
      send({ method: 'credential_form.respond', params: { request_id: id, value: values } });
      return;
    }
    default: return;
  }
}

/** 事件 → webview 渲染（agent.token 增量 / message 整段 / tool 状态行） */
function renderEvent(ev: WireEvent) {
  switch (ev.type) {
    case 'agent.start': post({ kind: 'start', prompt: ev.prompt }); return;
    case 'agent.token': post({ kind: 'token', text: ev.text }); return;
    case 'agent.message': post({ kind: 'message', content: ev.content }); return;
    case 'agent.tool': post({ kind: 'tool', name: ev.name, phase: ev.phase, ok: ev.ok }); return;
    case 'system.notice': post({ kind: 'notice', text: ev.text }); return;
    case 'agent.error': post({ kind: 'error', text: ev.message }); return;
    case 'wire.response': return; // 应答确认——不打扰用户
    case 'agent.result': post({ kind: 'result', ok: ev.ok, wireFinal: ev.wireFinal, text: ev.text }); return;
    default: return;
  }
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('WxNodus');

  const ensurePanel = () => {
    if (panel) { panel.reveal(); return panel; }
    panel = vscode.window.createWebviewPanel('wxnodus.chat', 'WxNodus', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = webviewHtml();
    panel.onDidDispose(() => { panel = null; });
    return panel;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('wxnodus.run', async () => {
      const prompt = await vscode.window.showInputBox({ prompt: '向 WxNodus 提问（--wire 无头执行）', placeHolder: '帮我分析这个仓库的结构' });
      if (!prompt) return;
      ensurePanel();
      log(`提问：${prompt}`);
      const child = spawnWire(prompt, (ev) => {
        renderEvent(ev);
        if (ev.type === 'approval.request' || ev.type === 'clarify.request' || ev.type === 'secret.request' || ev.type === 'form.request') {
          void handleRequest(ev);
        }
        if (isTerminalEvent(ev)) log('终态：' + String(ev.wireFinal ?? ev.ok));
      });
      void child;
    }),
    vscode.commands.registerCommand('wxnodus.panel', () => { ensurePanel(); }),
    vscode.commands.registerCommand('wxnodus.stop', () => {
      if (currentChild) { currentChild.kill('SIGTERM'); log('已发送停止信号'); }
      else vscode.window.showInformationMessage('当前没有运行中的回合');
    }),
  );
}

export function deactivate() {
  try { currentChild?.kill('SIGTERM'); } catch { /* 忽略 */ }
}

function webviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}
.msg{padding:6px 10px;margin:6px 0;border-radius:6px;background:var(--vscode-editor-background);white-space:pre-wrap}
.notice{color:var(--vscode-descriptionForeground);font-size:12px}
.tool{color:var(--vscode-textLink-foreground);font-size:12px}
.error{color:var(--vscode-errorForeground)}
.result{border-top:1px solid var(--vscode-panel-border);margin-top:10px;padding-top:8px}
</style></head>
<body><div id="log"></div>
<script>
const vscode = acquireVsCodeApi();
const log = document.getElementById('log');
const add = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; log.appendChild(d); };
window.addEventListener('message', (e) => {
  const m = e.data || {};
  switch (m.kind) {
    case 'start': add('notice', '» ' + (m.prompt || ''));
      { const d = document.createElement('div'); d.className = 'msg'; d.id = 'current'; log.appendChild(d); break; }
    case 'token': { const d = document.getElementById('current'); if (d) d.textContent += (m.text || ''); break; }
    case 'message': { const d = document.getElementById('current'); if (d) { d.textContent = m.content || ''; d.id = 'done'; } else add('msg', m.content || ''); break; }
    case 'tool': add('tool', '⚙ ' + m.name + ' ' + (m.phase || '') + (m.ok === false ? ' ✗' : '')); break;
    case 'notice': add('notice', m.text || ''); break;
    case 'error': add('error', m.text || ''); break;
    case 'result': add('result', '终态：' + (m.wireFinal || m.ok) ); break;
    case 'log': add('notice', m.text || ''); break;
    case 'done': break;
  }
});
</script></body></html>`;
}
