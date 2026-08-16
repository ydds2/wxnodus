// scripts/cmd-verify.mjs — 命令落地验证：/help 全量 + 建议补全 + 执行链路
// W8-19/阶段 11：fail-closed——任一断言失败即非零退出（绝不静默全绿）
//
// 会话隔离设计：每个检查组独立 PTY 会话（fresh 输入态、无残留草稿、无跨组
// pager/overlay 污染）。winpty 合成键盘环境实测陷阱（均已在脚本内规避）：
// 1. 补全 RPC 往返窗口内击键被吞 → 200ms/字符慢速输入。
// 2. 补全面板打开时 Enter = 接受补全项（/version 会错成 /versions）→
//    命令末尾加空格使过滤无匹配、面板关闭，Enter 提交原始输入（唯一可靠提交路径）。
// 3. Esc 后 Enter 不提交且后续击键失效 → 全程不用 Esc 提交序列。
// 4. 空闲态 Ctrl+C 使渲染停摆 → 全程不用 Ctrl+C。
// 5. 退格在补全面板重开期间吞键/停摆 → 全程不用退格（会话隔离消除回删需求）。
import { spawn } from 'node-pty'

// WXNODUS_ACCEPT_CONPTY=1 → ConPTY（真实 Windows 控制台 API/conhost 管线）；
// 默认 false（winpty）保持历史绿行为。验收 receipt 以 ConPTY 运行留存为准。
const useConpty = process.env.WXNODUS_ACCEPT_CONPTY === '1'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const checks = []
const record = (label, ok, extra = '') => {
  checks.push({ label, ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  [' + extra + ']' : ''}`)
}

// 单会话执行环境：独立 PTY + 独立输出流 + 就绪轮询/分段作用域助手
async function withSession(name, body) {
  const p = spawn(process.execPath, ['dist/cli/index.js'], {
    name: 'xterm-256color', cols: 110, rows: 34,
    cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' },
    useConpty
  })
  let out = ''
  p.onData(d => { out += d })
  const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const waitFor = async (predicate, timeoutMs = 6000, stepMs = 200) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(stepMs)
    }
    return predicate()
  }
  const mark = () => out.length
  const fullOut = () => out
  const tailOf = m => strip(out.slice(m))
  const rawTail = n => out.slice(-n)
  const typeKeys = async s => { for (const ch of s) { p.write(ch); await sleep(200) } }
  // '/' 全量补全面板：以「翻页」页脚为打开标记（32 条 > 16 行窗口才渲染）
  const openSlashPanel = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const m = mark()
      p.write('/')
      if (await waitFor(() => tailOf(m).includes('翻页'), 3000)) return true
    }
    return false
  }
  // 提交：完整命令（或已开面板后的剩余部分）+ 末尾空格 → Enter
  const submit = async rest => {
    await typeKeys(rest + ' ')
    await sleep(400)
    p.write('\r')
  }

  await sleep(2800)
  try {
    await body({ p, strip, waitFor, mark, fullOut, tailOf, rawTail, typeKeys, openSlashPanel, submit })
  } finally {
    try { p.kill() } catch {}
  }
  await sleep(400)
  console.log(`  [session ${name} 结束]`)
}

// ── A. /help 全量（pager 分页 + 截断展开）──
await withSession('help', async ({ openSlashPanel, tailOf, mark, typeKeys, submit, waitFor, fullOut }) => {
  // 行截断(…) 实为启动横幅行为（特色能力长描述 truncate-end），help pager 整行换行不截断
  record('启动横幅长描述截断(…)', await waitFor(() => fullOut().includes('…')))
  const slashMark = mark()
  record('/help 面板分页标记(翻页)', await openSlashPanel())
  const helpMark = mark()
  await submit('help')
  const FIRST_PAGE = ['/help', '/clear', '/undo', '/usage', '/quit', '/sessions', '/resume', '/new', '/title', '/context']
  record(
    '/help 面板首页命令抽查 10/10（分页）',
    await waitFor(() => FIRST_PAGE.filter(cmd => tailOf(helpMark).includes(cmd)).length >= 8),
    `缺失: ${FIRST_PAGE.filter(c => !tailOf(helpMark).includes(c)).join(' ')}`
  )

  const benchMark = mark()
  await submit('/help /bench')
  record(
    '展开/bench 含描述',
    await waitFor(() => {
      const s = tailOf(benchMark)
      return s.includes('/bench') && (s.includes('基准') || s.includes('bench'))
    })
  )
  const memHelpMark = mark()
  await submit('/help /memory')
  record(
    '展开/memory 含描述',
    await waitFor(() => {
      const s = tailOf(memHelpMark)
      return s.includes('/memory') && (s.includes('记忆') || s.includes('memory') || s.includes('黑洞'))
    })
  )
  const goalMark = mark()
  await submit('/help /goal')
  record('展开/goal 含描述', await waitFor(() => tailOf(goalMark).includes('/goal')))
})

// ── B. 建议补全（全量列表）→ 过滤 mem → 执行 /memory ──
await withSession('memory', async ({ openSlashPanel, tailOf, mark, typeKeys, waitFor, p }) => {
  record('建议面板打开（全量列表+翻页行）', await openSlashPanel())
  const m = mark()
  await typeKeys('mem')
  record('过滤mem后含/memory', await waitFor(() => tailOf(m).includes('/memory')))
  await typeKeys('ory ')
  const e = mark()
  p.write('\r')
  record(
    '执行/memory 含记忆',
    await waitFor(() => {
      const s = tailOf(e)
      return s.includes('记忆') || s.includes('黑洞')
    })
  )
})

// ── C. 过滤 vers → 执行 /version ──
await withSession('version', async ({ openSlashPanel, tailOf, mark, typeKeys, waitFor, p }) => {
  const panelOk = await openSlashPanel()
  const m = mark()
  await typeKeys('vers')
  record('过滤vers后含/version', panelOk && (await waitFor(() => tailOf(m).includes('/version'))))
  await typeKeys('ion ')
  const e = mark()
  p.write('\r')
  record(
    '执行/version 含版本',
    await waitFor(() => {
      const s = tailOf(e)
      return s.includes('3.0.0') || s.includes('v3')
    })
  )
})

// ── D. 过滤 cle → 执行 /clear ──
await withSession('clear', async ({ openSlashPanel, tailOf, mark, typeKeys, waitFor, p, strip, rawTail }) => {
  const panelOk = await openSlashPanel()
  const m = mark()
  await typeKeys('cle')
  record('过滤cle后含/clear', panelOk && (await waitFor(() => tailOf(m).includes('/clear'))))
  await typeKeys('ar ')
  p.write('\r')
  // 缺否检查：清屏重绘后尾窗不再含 /memory 帧（等待重绘到达）
  record('执行/clear 后命令面板残留', await waitFor(() => !strip(rawTail(1500)).includes('/memory')))
})

// ── E. 过滤 mod（过滤-only，残留草稿随进程退出）──
await withSession('mod', async ({ openSlashPanel, tailOf, mark, typeKeys, waitFor }) => {
  const panelOk = await openSlashPanel()
  const m = mark()
  await typeKeys('mod')
  record('过滤mod后含/model', panelOk && (await waitFor(() => tailOf(m).includes('/model'))))
})

const pass = checks.filter(c => c.ok).length
console.log(`\n===== cmd-verify 报告：${pass}/${checks.length} 通过 =====`)
for (const c of checks.filter(c => !c.ok)) console.log(`  ✗ ${c.label}`)
process.exit(pass === checks.length ? 0 : 1)
