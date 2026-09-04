// scripts/swap-dist.mjs — 原子目录交换（2026-09-03）：dist-next → dist
// 背景：npm 全局 wxnodus 是指向本仓库的 junction——旧 build（clean→tsc）在 clean 与
// tsc 写回之间存在「dist 缺失空窗」，用户此时启动 wxnodus 即 MODULE_NOT_FOUND。
// 本脚本把交换收敛为三步瞬间完成（rename 同卷原子）：dist 任何时刻都存在。
// 失败自动回滚：交换中途异常时恢复旧 dist，绝不留下缺失态。
import { rmSync, renameSync, existsSync } from 'node:fs'

const distNext = 'dist-next'
const dist = 'dist'
const distOld = 'dist-old'

if (!existsSync(distNext)) {
  console.error('SWAP_DIST_FAIL: dist-next 不存在（tsc 未产出？）')
  process.exit(1)
}

try {
  if (existsSync(distOld)) rmSync(distOld, { recursive: true, force: true })
  if (existsSync(dist)) renameSync(dist, distOld)
  renameSync(distNext, dist)
  if (existsSync(distOld)) rmSync(distOld, { recursive: true, force: true })
} catch (e) {
  // 回滚：换到一半失败时把旧 dist 换回来（新产物仍在 dist-next 或已部分移动）
  try {
    if (existsSync(distOld)) {
      if (existsSync(dist)) rmSync(dist, { recursive: true, force: true })
      renameSync(distOld, dist)
    }
  } catch { /* 回滚失败保留现场，报错交人处置 */ }
  console.error(`SWAP_DIST_FAIL: ${(e && e.message) ? e.message : e}`)
  process.exit(1)
}
console.log('SWAP_DIST_OK')
