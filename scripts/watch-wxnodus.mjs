// scripts/watch-wxnodus.mjs — wxnodus 错误/心跳日志实时监听（诊断 cmd 卡死/报错用）
// 用法：node scripts/watch-wxnodus.mjs   （每 3s 扫描一次，Ctrl+C 退出）
// 监听：~/.wxnodus/logs/error-<日期>.log（未捕获异常/拒绝/console.error）
//       ~/.wxnodus/logs/heartbeat-<日期>.log（B1：心跳默认开启 2s 一写；
//       行尾 pid=<进程>——心跳断档 = 卡死发生点，/doctor「心跳探针」项自动关联存活进程）
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), '.wxnodus', 'logs')
const seen = new Map() // 文件路径 -> 已读字节数

const scan = () => {
  let files = []
  try {
    files = readdirSync(dir).filter(f => f.startsWith('error-') || f.startsWith('heartbeat-'))
  } catch {
    // logs 目录尚未创建——首次运行 wxnodus 后出现
    return
  }

  for (const f of files) {
    const p = join(dir, f)
    try {
      const size = statSync(p).size
      const prev = seen.get(p) ?? 0
      if (size > prev) {
        const chunk = readFileSync(p, 'utf8').slice(prev)
        const lines = chunk.split('\n').filter(Boolean).slice(-80)
        console.log(`\n[${f}] +${size - prev} 字节：\n${lines.join('\n')}`)
      } else if (size < prev) {
        console.log(`\n[${f}] 文件被截断/轮转（${prev} → ${size} 字节）`)
      }
      seen.set(p, size)
    } catch { /* 单文件读取失败不阻断扫描 */ }
  }
}

console.log(`监听 ${dir}（每 3s 扫描 error-*.log / heartbeat-*.log；Ctrl+C 退出）`)
scan()
setInterval(scan, 3000)
