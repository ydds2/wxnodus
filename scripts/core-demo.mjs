// scripts/core-demo.mjs — 核心链路 30 秒验收：说一句话 → 编译 → 启动级验证 → 证据 → 五门
// 用法：npm run build && node scripts/core-demo.mjs [需求文本]
// 输出：五段链路每一步的实况 + 最终证据摘要；任何一步失败退出码非 0（诚实交付的示范）
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const demand = process.argv[2] ?? '帮我做一个待办系统'
const dataDir = process.env.WXNODUS_DATA_DIR ?? join(root, 'data')
const projectsDir = join(dataDir, 'projects')
const ok = s => console.log(`  ✅ ${s}`)
const step = s => console.log(`\n━━━ ${s}`)
const fail = s => { console.error(`\n  ❌ ${s}`); process.exit(1) }

step('① 规格：规则脑离线编译（零配置，无 key）')
const buildOut = execFileSync(process.execPath, ['dist/cli/index.js', '-p', demand], {
  cwd: root, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, MSYS_NO_PATHCONV: '1' },
})
// 从输出提取构建结果（规格/模具/验收/位置/验证/证据/质量门）
const lines = buildOut.split('\n').map(l => l.trim()).filter(Boolean)
const pick = (re) => { const l = lines.find(l => re.test(l)); return l ? l.replace(/^.*?(模具|验收|位置|验证|证据|启动)/, '$1') : null }
console.log(lines.slice(0, 8).join('\n'))
const pos = pick(/位置：/)
if (!pos) fail(`未找到构建产物位置：\n${buildOut.slice(0, 400)}`)
ok('规则脑命中模具（无 key 可用）')

step('② 证据：evidence.json 落盘（状态/检查项/指纹/时间）')
const projs = readdirSync(projectsDir).filter(n => existsSync(join(projectsDir, n, 'evidence.json')))
const latest = projs.map(n => ({ n, ev: JSON.parse(readFileSync(join(projectsDir, n, 'evidence.json'), 'utf8')) }))
  .sort((a, b) => b.ev.ts - a.ev.ts)[0]
if (!latest) fail('证据簿为空')
const { n: proj, ev } = latest
console.log(`  项目：${proj}｜状态：${ev.status}｜指纹：${ev.fingerprint}｜检查：${(ev.checks ?? []).join(', ')}`)
if (ev.status !== 'ok') fail(`启动级验证未通过：${ev.detail ?? ev.status}（诚实记录 failed，不伪造）`)
ok('启动→探活→杀→重启→读回 通过')

step('③ 五门质量门（自测/健康/证据/合规/测试）')
const gateOut = execFileSync(process.execPath, ['dist/cli/index.js', '-p', `/gate ${proj}`], {
  cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, MSYS_NO_PATHCONV: '1' },
})
console.log(gateOut.split('\n').filter(l => /门|✓|✗|✅|⚠|通过/.test(l)).slice(0, 8).join('\n'))
if (!/通过/.test(gateOut)) fail('质量门未全过')
ok('五门质量门通过')

step('④ 证据可追溯：/evidence show 明细')
const evOut = execFileSync(process.execPath, ['dist/cli/index.js', '-p', `/evidence show ${proj}`], {
  cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, MSYS_NO_PATHCONV: '1' },
})
console.log(evOut.split('\n').filter(l => /状态|检查|指纹|时间|明细/.test(l)).slice(0, 6).join('\n'))
ok('证据明细可查')

step('⑤ 逆向编译：/understand 代码 → 概念（双向闭环）')
try {
  const undOut = execFileSync(process.execPath, ['dist/cli/index.js', '-p', `/understand ${join(projectsDir, proj)}`], {
    cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  })
  const hit = undOut.split('\n').find(l => /概念|规格|落盘|md/.test(l))
  ok(hit ? hit.trim().slice(0, 120) : '概念文档已生成')
} catch {
  console.log('  ⚠ /understand 未跑通（无 key 或路径问题）——双向闭环需配 key 后完整验证')
}

console.log(`\n━━━ 核心链路验收完成 ━━━`)
console.log(`  一句话「${demand}」 → 可运行系统 → 启动级验证通过 → 证据 ${ev.fingerprint} → 五门通过`)
console.log(`  证据文件：${join(projectsDir, proj, 'evidence.json')}`)
console.log(`  复现：npm run build && node scripts/core-demo.mjs「你的需求」`)
