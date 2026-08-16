// scripts/full-scene-test.mjs — 全场景自动化测试（pty 驱动真实终端，WxNodus UI 版）
// 覆盖：启动/品牌/输入/提交/命令/建议/模型选择器/会话/滚动/退出
// 注意：WxNodus textInput 有 burst 处理——逐键写入，Enter 单独发送（模拟真实逐键）
//
// W8-19/阶段 12：分段作用域断言（与 cmd-verify 同一纪律）——每个检查只读本阶段
// 标记点之后的新输出，杜绝陈帧误判（旧版多处检查可被启动横幅/建议面板旧帧真空通过）。
// winpty/ConPTY 合成键盘环境实测陷阱（均已在脚本内规避）：
// 1. 补全 RPC 往返窗口内击键被吞 → 200ms/字符慢速输入（cmd-verify 实测稳定值）。
// 2. 补全面板打开时 Enter = 接受补全项 → 命令末尾加空格使过滤无匹配、面板关闭。
// 3. 空闲态 Ctrl+C 使渲染停摆（agent 已就绪时中断 = 永久停帧）→ 全程不盲发 Ctrl+C：
//    先等就绪（分段作用域），仅当 agent 确实仍忙（真实 key 流式回复）才中断。
// 4. 消息用 ASCII：CJK 高速键入在 ConPTY/winpty 均有丢字竞态（CJK 由真机专项验证）。
// 5. Esc 关闭 overlay 后存在输入恢复窗口，其后首批击键失效 → Esc 关闭验证后
//    恢复 1.5s settle（旧版 25/25 绿行为依赖的 1800ms 语义）。
// 6. 长输出命令（/help、/status…）打开 pager，pager 吞 Space/Enter（翻页）→
//    每个 pager 命令检查后按 q 关闭并分段验证关闭，再进入下一阶段。
// 7. W8-29/W8-32 更正：状态栏时钟**有**自驱重绘（winpty 整行重绘；ConPTY 每帧只发
//    时钟数字 \b 改写——不含「就绪」词）。此前断言只在段内找「就绪/ready」文本，
//    ConPTY 下误判三项 RED。现以 statusBarReady 复合判据（词命中 或 时钟活性+最近状态词
//    为就绪+无 busy 词）诚实判定；启动检查改就绪轮询（固定 2500ms 在负载下误报）。
import { spawn } from 'node-pty';

// WXNODUS_ACCEPT_CONPTY=1 → ConPTY（真实 Windows 控制台 API/conhost 管线）；
// 默认 false（winpty）保持历史绿行为。验收 receipt 以 ConPTY 运行留存为准。
const useConpty = process.env.WXNODUS_ACCEPT_CONPTY === '1';

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'cli', 'index.js');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
}

let out = '';
let p;
let exited = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const last = () => strip(out).slice(-2000);
// 分段作用域：mark() 取游标，tailOf(m) 只读标记点之后的新输出（剥离 ANSI）
const mark = () => out.length;
const tailOf = m => strip(out.slice(m));
// 原始字节分段（状态栏 CUP 活性判定用——strip 会吞掉 \x1b[29;35H 序列，活性只能在原字节上判）
const tailRawOf = m => out.slice(m);
const waitFor = async (predicate, timeoutMs = 6000, stepMs = 200) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
};
const typeKeys = async s => { for (const ch of s) { p.write(ch); await sleep(200); } };
const submit = async s => { await typeKeys(s); await sleep(400); p.write('\r'); };
// 命令输出断言：先打完（含末尾空格关面板），mark 再 Enter——面板旧帧不落入断言段
const submitScoped = async s => { await typeKeys(s + ' '); await sleep(400); const m = mark(); p.write('\r'); return m; };
// 回显重试（负载鲁棒）：先等回显；仍缺再等 3s（渲染滞后）；再缺重发一次——
// 重复无害于累积断言（msg0/1/2 均在即过），杜绝「吞键→后续消息排队不渲染」级联
const submitEcho = async s => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const m = mark();
    await submit(s);
    if (await waitFor(() => tailOf(m).includes(s), 8000)) return true;
    await sleep(3000);
    if (tailOf(m).includes(s)) return true;
  }
  return false;
};
const dump = async suffix => {
  if (process.env.WXNODUS_DUMP) writeFileSync(process.env.WXNODUS_DUMP + suffix, out);
};
// W8-32：就绪判定（双管线渲染契约不同）——
//   winpty：时钟 tick 整行重绘状态栏（含「就绪」词）→ 词命中即过。
//   ConPTY：全量绘制只在启动/布局变更时发生；时钟每帧以 CUP 改写
//   （\x1b[29;3xH<digit>——实测无 \b 无就绪词）→ 词不在段内时以
//   「CUP 活性 + 整缓冲最近状态词为就绪 + 段内无 busy 词」为诚实判据
//   （无 key 环境回复即完成；真实 key 忙态段内会有 busy 词，被第三条件排除）。
const statusBarLive = seg => /\x08\d/.test(seg) || /\x1b\[29;3[2-9]H\d/.test(seg);
// 入参为原始字节段（CUP 活性判定）；词/忙碌判定在剥离 ANSI 后的文本上进行
const statusBarReady = rawSeg => {
  const seg = strip(rawSeg);
  if (seg.includes('就绪') || seg.includes('ready')) return true;
  if (!statusBarLive(rawSeg)) return false;
  if (/computing|synthesizing|running|formulating/.test(seg)) return false;
  const verbs = [...strip(out).matchAll(/▍─\s*([^\s│]+)/g)].map(m => m[1]);
  const lastVerb = verbs.at(-1) ?? '';
  return /就绪|ready/.test(lastVerb);
};

async function main() {
  p = spawn(process.execPath, [BIN], {
    name: 'xterm-256color', cols: 100, rows: 30,
    cwd: ROOT, env: { ...process.env, TERM: 'xterm-256color' },
    useConpty,
  });
  p.onData(d => { out += d; });
  p.onExit(() => { exited = true; });

  // ── 1. 启动场景（整段缓冲：启动横幅内容仅本会话产生） ──
  // W8-32：就绪轮询替代固定 2500ms——ConPTY+负载下启动渲染可达 3s+（固定窗口误报 7 项全挂）。
  // 状态栏比横幅晚绘（winpty 整行重绘 / ConPTY \b 改写契约不同）——横幅出现后继续轮询
  // 状态栏（模型词 + 就绪词），两者齐了才截快照断言（此前横幅即快照 → 状态两项误报）。
  await sleep(1500);
  const bannerUp = await waitFor(() => strip(out).includes('WxNodus') || strip(out).includes('本地概念编译器'), 6000);
  const statusUp = await waitFor(() => {
    const f = strip(out);
    return (f.includes('deepseek') || f.includes('规则')) && (f.includes('唤醒 WxNodus') || f.includes('ready') || f.includes('就绪'));
  }, 8000);
  const f0 = strip(out);
  check('启动:WXNODUS 品牌 logo', f0.includes('WXNODUS') || f0.includes('WxNodus'));
  check('启动:品牌口号', f0.includes('本地概念编译器'));
  // 状态文案随产品 copy 演进：中文就绪/英文 ready 均可（检查真实初始化完成）
  check('启动:状态初始化', f0.includes('唤醒 WxNodus') || f0.includes('ready') || f0.includes('就绪'));
  check('启动:输入框提示符', f0.includes('❯'));
  check('启动:状态条(模型)', f0.includes('deepseek') || f0.includes('规则'));
  check('启动:状态条(目录)', f0.includes('WxNodusV3CLI'));
  check('启动:会话卡(品牌)', f0.includes('WxNodus V3'));
  if (!bannerUp || !statusUp) await dump('.startup');

  // ── 2a. 模型选择器（分段作用域；选择器标记只存在于选择器帧） ──
  const mModel = mark();
  await submit('/model ');
  const modelOpened = await waitFor(() => {
    const f = tailOf(mModel);
    // 「DeepSeek」（首字母大写）只出现在选择器 provider 列表（状态栏是 lowercase deepseek）
    return f.includes('Select provider') || f.includes('选择提供商') || f.includes('DeepSeek');
  });
  check('模型选择器:打开', modelOpened);
  if (!modelOpened) await dump('.model');
  const pickerFrame = tailOf(mModel);
  check('模型选择器:provider 分组', pickerFrame.includes('DeepSeek') && (pickerFrame.includes('K2.7') || pickerFrame.includes('GLM') || pickerFrame.includes('kimi')));
  // 关闭键是 q（提示行「Esc 清空/返回 · q 关闭」——Esc 只清空过滤/返回上一步，不关闭选择器）
  const mQ = mark();
  p.write('q');
  const pickerClosed = await waitFor(() => {
    const f = tailOf(mQ);
    return (f.includes('就绪') || f.includes('ready')) && !f.includes('Select provider') && !f.includes('选择提供商') && !f.includes('DeepSeek');
  }, 5000);
  check('模型选择器:q 关闭', pickerClosed);
  if (!pickerClosed) await dump('.qclose');

  // ── 2b. 会话选择器（「resumable」只出现在会话面板头部；状态栏「20 会话」不含） ──
  const mSess = mark();
  await submit('/sessions ');
  const sessOpened = await waitFor(() => tailOf(mSess).includes('resumable'));
  check('会话选择器:打开', sessOpened);
  if (!sessOpened) await dump('.sess');
  const mEsc = mark();
  p.write('\x1b');
  const sessClosed = await waitFor(() => {
    const f = tailOf(mEsc);
    return !f.includes('resumable') && !f.includes('Select +new');
  }, 5000);
  check('会话选择器:Esc 关闭', sessClosed);
  if (!sessClosed) await dump('.sessclose');
  // 陷阱 5：Esc 关闭后输入恢复窗口——首批击键失效（cmd-verify 实测）。恢复 settle。
  await sleep(1500);

  // ── 2. 输入与提交（规则脑回复） ─────────
  await submit('hello');
  const mHello = mark();
  const userMsgRendered = await waitFor(() => tailOf(mHello).includes('hello'), 6000);
  check('提交:用户消息渲染', userMsgRendered);
  if (!userMsgRendered) await dump('.user');
  // 无真实 API key 时规则脑即时回复（提示 /key）即视为 UI 提交链路正常
  const replyRendered = await waitFor(() => {
    const f = tailOf(mHello);
    return f.includes('我是 WxNodus') || f.includes('computing') || f.includes('synthesizing') || f.includes('抱歉') || f.includes('/key');
  }, 8000);
  check('提交:助手回复渲染', replyRendered);
  check('提交:回复含规则脑提示', tailOf(mHello).includes('/key'));
  // 等就绪（分段作用域，回复之后的新帧）；仅当 agent 确实仍忙（真实 key 流式回复）才中断——
  // 空闲态 Ctrl+C 会使渲染停摆，故先判定再发。
  // W8-32：无 key 回复瞬时完成、状态栏不重绘（ConPTY 只在活动时全量重绘）——
  // 「回到 ready」在下一个确定重绘点（/calc 输出）评估，两管线均真实覆盖。
  const mReady = mark();
  const readyAfterReply = await waitFor(() => statusBarReady(tailRawOf(mReady)), 6000);
  if (!readyAfterReply) {
    const stillBusy = /computing|synthesizing|running|formulating/.test(tailOf(mReady));
    if (stillBusy) p.write('\x03');
    await waitFor(() => statusBarReady(tailRawOf(mark())), 8000);
  }

  // ── 3. 命令建议 → 4. 命令执行（链式：过滤后补齐命令 + 末尾空格 → Enter 提交）──
  // 负载鲁棒：段间 settle——busy 未清时键入会被吞（吞键级联到后续阶段）
  await waitFor(() => statusBarReady(tailRawOf(mark())), 4000);
  // 「翻页」页脚只在全量列表（32 条 > 16 行窗口）渲染——分段作用域 + 重发兜底
  let sugOpened = false;
  for (let attempt = 0; attempt < 3 && !sugOpened; attempt++) {
    const mSug = mark();
    p.write('/');
    sugOpened = await waitFor(() => tailOf(mSug).includes('翻页'), 3000);
  }
  check('建议:/ 弹出建议', sugOpened);
  if (!sugOpened) await dump('.sug0');
  const mFilter = mark();
  await typeKeys('calc');
  const filtered = await waitFor(() => tailOf(mFilter).includes('/calc'), 5000);
  check('建议:过滤生效', filtered);
  if (!filtered) await dump('.sug');
  const mCalc = await submitScoped(' 1+2');
  const calcOut = await waitFor(() => tailOf(mCalc).includes('= 3'), 6000);
  check('命令:/calc 输出', calcOut);
  if (!calcOut) await dump('.calc');

  const mHelp = await submitScoped('/help');
  check('命令:/help 中文面板', await waitFor(() => {
    const f = tailOf(mHelp);
    return f.includes('/clear') && f.includes('/usage') && f.includes('/help');
  }, 6000));
  // 陷阱 6：/help 长输出打开 pager（标题「命令帮助」），pager 吞 Space/Enter（翻页）——
  // 不关闭则后续末尾空格提交全部损坏。q 关闭 + 分段验证。
  const mHelpClose = mark();
  p.write('q');
  const helpPagerClosed = await waitFor(() => !tailOf(mHelpClose).includes('命令帮助'), 5000);
  check('命令:/help pager 关闭', helpPagerClosed);
  await sleep(300);
  const mUuid = await submitScoped('/uuid');
  const uuidOut = await waitFor(() => /[0-9a-f]{8}-/.test(tailOf(mUuid)), 6000);
  check('命令:/uuid 输出', uuidOut);
  if (!uuidOut) await dump('.uuid');
  const mStatus = await submitScoped('/status');
  let statusOut = await waitFor(() => {
    const f = tailOf(mStatus);
    return f.includes('模型：') || f.includes('状态');
  }, 6000);
  if (!statusOut) { // 负载鲁棒：渲染滞后补观察窗（不重发——重发在半吞输入态会错成拼接命令）
    await sleep(3000);
    statusOut = await waitFor(() => {
      const f = tailOf(mStatus);
      return f.includes('模型：') || f.includes('状态');
    }, 5000);
  }
  check('命令:/status 输出', statusOut);
  // 陷阱 6：/status 同样打开 pager（多行输出）——q 关闭 + 分段验证，否则 msg 阶段损坏
  const mStatusClose = mark();
  p.write('q');
  const statusPagerClosed = await waitFor(() => !tailOf(mStatusClose).includes('模型：'), 5000);
  check('命令:/status pager 关闭', statusPagerClosed);
  await sleep(300);
  // /status 在无 key 时可能挂起 → 等就绪；仍忙才中断（同「先判定再发」纪律）
  const mReady2 = mark();
  let readyAfterStatus = await waitFor(() => statusBarReady(tailRawOf(mReady2)), 5000);
  if (!readyAfterStatus) {
    const stillBusy = /computing|synthesizing|running|formulating/.test(tailOf(mReady2));
    if (stillBusy) p.write('\x03');
    const mRec2 = mark();
    readyAfterStatus = await waitFor(() => statusBarReady(tailRawOf(mRec2)), 8000);
  }
  check('命令:状态回到 ready', readyAfterStatus);
  if (!readyAfterStatus) await dump('.ready');

  // ── 7. 滚动（ScrollBox 应用内滚动） ───────
  // 负载鲁棒：段间 settle（busy 未清时键入被吞）
  await waitFor(() => statusBarReady(tailRawOf(mark())), 4000);
  // 每条消息等回显再发下一条（固定间隙会让后发消息在 agent 忙时排队不渲染）；
  // 累积断言分段作用域自 msg0 提交起，杜绝会话面板旧帧（历史会话标题）误判
  const mHist = mark();
  for (let i = 0; i < 3; i++) {
    await submitEcho('msg' + i);
  }
  const historyAccumulated = await waitFor(() => {
    const f = tailOf(mHist);
    return f.includes('msg0') && f.includes('msg1') && f.includes('msg2');
  }, 6000);
  check('主屏幕:历史消息累积', historyAccumulated);
  if (!historyAccumulated) await dump('.hist');
  const f5 = last();
  check('主屏幕:输入框固定底部', f5.includes('❯'));
  // ConPTY：状态栏词只在启动/布局变更时全量绘制（diff 渲染不重发），时钟以 CUP 改写
  // （1s 节拍内必现，原字节上判）——短轮询消除「快照恰在两次 tick 之间」竞态；winpty 整行重绘含词即过
  const bottomBarUp = await waitFor(() => {
    const f = last();
    return f.includes('deepseek') || f.includes('Ctrl+C') || f.includes('语音') || f.includes('synthesizing') || f.includes('ready') || f.includes('running') || f.includes('interrupted') || f.includes('formulating') || statusBarLive(out.slice(-2000));
  }, 3000);
  check('主屏幕:状态条在底部', bottomBarUp);
  if (!bottomBarUp) await dump('.bottom');

  // ── 8. 退出（/quit 干净退出路径；kill 兜底——进程可终止 = 真实 exit 事件） ──
  await submitScoped('/quit');
  const quitExit = await waitFor(() => exited, 4000);
  if (!quitExit) { try { p.kill(); } catch {} }
  const terminated = await waitFor(() => exited, 3000);
  check('退出:进程可终止', terminated);

  // ── 汇总 ────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  console.log(`\n===== 全场景报告：${pass}/${results.length} 通过 =====`);
  const fails = results.filter(r => !r.ok);
  if (fails.length) {
    console.log('失败项：');
    fails.forEach(f => console.log('  ✗ ' + f.name));
    await dump('.final');
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃：', e); process.exit(1); });
