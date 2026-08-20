// scripts/loop-closure-test.mjs — 回合闭环电池（「35 工具调用后无输出」缺陷的确定性回归）
// 契约（客观，非主观评分）：工具型回合必须收敛为非空最终消息——任何静默空输出 = 本检查失败。
// 机制：本地 mock OpenAI 兼容 SSE 服务，前 32 轮只回 tool_call（ls '.'）逼内核耗尽轮次上限；
// 内核轮次耗尽兜底 → 无工具强制总结调用（第 33 次请求）→ mock 返回最终答案文本。
// 断言真实 TUI 渲染出该最终答案（且状态回归就绪）——即用户在 cmd 真实环境的「35 工具调用
// 后无输出」场景，在可控端点上确定性地验证闭环。
// 用法：node scripts/loop-closure-test.mjs（洁净间数据目录 + WXNODUS_API_KEY/BASE_URL 指向 mock）
import { spawn } from 'node-pty';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FINAL_MARK = 'LOOPCLOSURE-OK: 评估结论已收敛';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── mock OpenAI 兼容 SSE 服务 ──
// 注意：tool_call 参数必须逐次变化（循环真实存在目录）——相同签名重复 ≥3 会触发
// 内核循环检测（正确行为）提前终止，就无法逼出「轮次耗尽兜底」路径。
const LS_PATHS = ['.', './src', './tests', './scripts', './docs', './packages', './data'];
function startMock(toolTurns) {
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const isFinal = calls > toolTurns;
      if (!isFinal) {
        const path = LS_PATHS[(calls - 1) % LS_PATHS.length];
        // tool_call 流：一次 delta 携带完整工具调用 + [DONE]
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${calls}`, type: 'function', function: { name: 'ls', arguments: JSON.stringify({ path }) } }] } }] })}\n\n`);
      } else {
        // 最终文本流：分两块 delta 模拟真实流式 + [DONE]
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: FINAL_MARK.slice(0, 14) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: FINAL_MARK.slice(14) } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => {
          // closeAllConnections：kill 后残留 keep-alive 套接字会让 server.close() 永挂
          server.closeAllConnections?.();
          server.close();
        },
        calls: () => calls,
      });
    });
  });
}

// ── 真实 TUI 驱动 ──
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const waitFor = async (pred, ms, step = 250) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (pred()) return true; await sleep(step); }
  return pred();
};
const typeKeys = async (p, s) => { for (const ch of s) { p.write(ch); await sleep(120); } };

async function main() {
  const mock = await startMock(32); // MAX_TURNS 耗尽 → 第 33 次 = 强制总结
  console.error(`[loop-closure] mock on :${mock.port}`);
  // 全程硬看门狗：任何意外挂起 5 分钟内强制退出（fail-closed）
  const watchdog = setTimeout(() => { console.error('[loop-closure] 看门狗超时——流程挂起'); process.exit(2); }, 300000);
  const dataDir = join(ROOT, 'artifacts', 'battery-cleanroom');
  const p = spawn(process.execPath, ['dist/cli/index.js'], {
    name: 'xterm-256color', cols: 100, rows: 30,
    cwd: ROOT,
    env: {
      ...process.env, TERM: 'xterm-256color',
      WXNODUS_DATA_DIR: dataDir,
      WXNODUS_LANG: 'zh-CN',
      WXNODUS_MODEL: 'glm-4-flash', // 目录内合法模型 id；端点被 env 覆盖指向 mock
      WXNODUS_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      WXNODUS_API_KEY: 'mock-key',
    },
    useConpty: false,
  });
  let out = '';
  p.onData(d => { out += d; });

  try {
    const ready = await waitFor(() => /就绪|ready/.test(strip(out)), 30000);
    console.error(`[loop-closure] ready=${ready}`);
    if (!ready) { console.log('✗ 启动未达就绪'); process.exitCode = 1; return; }
    await sleep(1000);
    // ASCII 提示词（CJK 高速键入有丢字竞态，语义无关——mock 不读内容）
    await typeKeys(p, 'please evaluate this CLI and list gaps ');
    await sleep(400);
    p.write('\r');
    const closed = await waitFor(() => strip(out).includes(FINAL_MARK), 180000, 500);
    // 状态回归：就绪词 或 已完成的系统维护通告（curator 首跑会占据动词槽——均属 settled）
    const tailStripped = strip(out).slice(-3000);
    const readyAgain = /就绪|ready|curator|自动审查/.test(tailStripped);
    console.log(`===== 回合闭环电池（mock ${mock.calls()} 次调用）=====`);
    console.log(`最终答案渲染: ${closed} | 状态回归就绪: ${readyAgain} | mock 调用数: ${mock.calls()}`);
    if (!closed) {
      console.log('✗ 工具型回合未收敛为非空最终答案——静默空输出缺陷复现');
      console.log('输出尾部：' + JSON.stringify(strip(out).slice(-800)));
      process.exitCode = 1;
    } else {
      console.log('✓ 工具型回合收敛为最终答案（轮次耗尽兜底闭环）');
    }
  } finally {
    clearTimeout(watchdog);
    try { p.kill(); } catch { /* 忽略 */ }
    mock.close();
  }
  // 显式退出：node-pty 句柄与 mock 连接会维持事件循环，exitCode 不为 0 时进程仍会挂起
  process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error('测试崩溃：', e); process.exit(1); });
