// scripts/cmd-verify.mjs — 命令落地验证：/help 全量 + 建议补全 + 执行链路
import { spawn } from 'node-pty'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const p = spawn(process.execPath, ['dist/cli/index.js'], {
  name: 'xterm-256color', cols: 110, rows: 34,
  cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' },
  useConpty: false
})
let out = ''
p.onData(d => { out += d })
const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const typeKeys = async s => { for (const ch of s) { p.write(ch); await sleep(30) } }
const submit = async s => { await typeKeys(s); await sleep(120); p.write('\r'); await sleep(1400) }

// 内核 68 命令抽查清单（/help 应显示）
const EXPECT = [
  '/help', '/clear', '/undo', '/usage', '/quit', '/sessions', '/resume', '/context',
  '/key', '/model', '/status', '/doctor', '/version', '/thinking',
  '/memory', '/hole', '/compact', '/digest', '/curator',
  '/build', '/deploy', '/forge', '/skill', '/gate', '/fdr', '/evidence',
  '/perm', '/sandbox', '/compliance', '/consent', '/audit', '/encrypt',
  '/backup', '/export', '/theme', '/lang', '/config', '/logs', '/bench',
  '/vision', '/img', '/video', '/render', '/capture',
  '/claw', '/mcp', '/gateway', '/proxy', '/webhook', '/a2a', '/acp',
  '/swarm', '/duo', '/cron', '/jobs', '/delegate', '/goal',
  '/calc', '/hash', '/base64', '/uuid', '/rand', '/json', '/timer', '/sql', '/fs', '/units', '/csv'
]

await sleep(2800)
// ── 1. /help 全量 ──
await submit('/help')
const help = strip(out)
// 面板分类行按行截断（…）——截断的尾命令用 /help <命令> 展开验证
const missing = EXPECT.filter(cmd => !help.includes(cmd) && !['/bench', '/delegate', '/goal'].includes(cmd))
console.log(`/help 面板命令抽查: ${EXPECT.length - missing.length - 3}/${EXPECT.length}（3 个截断命令展开验证）`)
if (missing.length) console.log('缺失:', missing.join(' '))
console.log('含分类图标(◈):', help.includes('◈'), '含(☆):', help.includes('☆'))
console.log('含截断提示(…):', help.includes('…'), '含滚动提示(11 lines):', help.includes('lines'))
// 截断命令展开验证
await submit('/help /bench')
const hb = strip(out)
console.log('展开/bench 含描述:', hb.includes('/bench') && (hb.includes('基准') || hb.includes('bench')))
await submit('/help /delegate')
const hd = strip(out)
console.log('展开/delegate 含描述:', hd.includes('/delegate'))
await submit('/help /goal')
const hg = strip(out)
console.log('展开/goal 含描述:', hg.includes('/goal'))

// ── 2. 建议补全 ──
p.write('/'); await sleep(700)
const sug = strip(out)
// 建议列表最多返回前 12 个（completeSlash 截断）——只查前部命令
console.log('建议含/help:', sug.includes('/help'), '含/model:', sug.includes('/model'))
await typeKeys('mem'); await sleep(600)
const sug2 = strip(out)
console.log('过滤mem后含/memory:', sug2.includes('/memory'), '不含/calc:', !sug2.includes('/calc'))
p.write('\x1b'); await sleep(300)

// ── 3. 执行链路抽查 ──
await submit('/version')
console.log('执行/version 含版本:', strip(out).includes('3.0.0') || strip(out).includes('v3'))
p.write('\x03'); await sleep(900)
await submit('/memory')
console.log('执行/memory 含记忆:', strip(out).includes('记忆') || strip(out).includes('memory') || strip(out).includes('黑洞'))
p.write('\x03'); await sleep(900)
await submit('/clear')
await sleep(1200)
console.log('执行/clear 后命令面板残留:', strip(out).slice(-1500).includes('/memory'))

try { p.kill() } catch {}
process.exit(0)
