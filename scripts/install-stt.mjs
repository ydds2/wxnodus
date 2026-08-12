// scripts/install-stt.mjs — 一键安装 STT 组件（本地 whisper.cpp，完全离线转写）
// 安装内容（目标：<dataDir>/voice/，默认 data/）：
//   1. whisper-cli 二进制（whisper.cpp 官方 release：whisper-bin-x64.zip，GitHub）
//   2. ggml 模型（默认 ggml-small.bin 487MB；GitHub 镜像 CDN——HF 直连在部分网络不可达）
// 用法：node scripts/install-stt.mjs [model]
//   model 可选：tiny | base | small（默认 small；tiny/base 更快更小、中文准确率更低）
// 幂等：已存在组件自动跳过；中断后重跑续装。绝不删除已有文件。
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const WHISPER_VERSION = 'v1.9.2'
const BIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`
// 模型镜像（GitHub media CDN——HF 直连不通时的可用源；大小与官方一致）
const MODEL_MIRRORS = {
  tiny: 'https://media.githubusercontent.com/media/OpenAEC-Foundation/open-speech-studio/main/models/ggml-tiny.bin',
  base: 'https://media.githubusercontent.com/media/OpenAEC-Foundation/open-speech-studio/main/models/ggml-base.bin',
  small: 'https://media.githubusercontent.com/media/OpenAEC-Foundation/open-speech-studio/main/models/ggml-small.bin',
}
const EXPECTED_SIZES = { tiny: 75517318, base: 141974130, small: 487601967 }

const isWin = process.platform === 'win32'
const dataDir = resolve(process.argv[2] ?? 'data')
const modelName = (process.argv[3] ?? 'small').toLowerCase()

const log = (msg) => console.log(`[install-stt] ${msg}`)

async function download(url, dest, expectedSize) {
  log(`下载 ${url.split('/').pop()} → ${dest}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`)
  const total = Number(res.headers.get('content-length') ?? expectedSize)
  let got = 0
  const ws = createWriteStream(dest)
  await pipeline(
    Readable.fromWeb(res.body),
    new (await import('node:stream')).Writable({
      write(chunk, _enc, cb) {
        got += chunk.length
        const pct = Math.min(100, Math.round((got / total) * 100))
        process.stdout.write(`\r  ${pct}% (${(got / 1024 / 1024).toFixed(0)}MB)`)
        cb(null, chunk)
      },
    }),
    ws
  )
  process.stdout.write('\n')
  const size = statSync(dest).size
  if (expectedSize && Math.abs(size - expectedSize) > 1024 * 1024) {
    log(`⚠ 尺寸不符（${size} vs 预期 ${expectedSize}）——可能镜像变动，继续使用`)
  }
}

// ── 1. whisper-cli 二进制 ──
const binDir = join(dataDir, 'voice', 'bin')
mkdirSync(binDir, { recursive: true })
const releaseDir = join(binDir, 'Release')
let cliPath = join(releaseDir, 'whisper-cli.exe')
if (!isWin) cliPath = join(releaseDir, 'whisper-cli')

if (existsSync(cliPath)) {
  log(`✓ whisper-cli 已存在：${cliPath}`)
} else {
  log('whisper-cli 缺失——下载官方 release')
  const zipPath = join(binDir, 'whisper-bin-x64.zip')
  await download(BIN_URL, zipPath, 8194445)
  if (isWin) {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${binDir}'`], { stdio: 'pipe' })
  } else {
    spawnSync('unzip', ['-o', zipPath, '-d', binDir], { stdio: 'pipe' })
  }
  try { readdirSync(binDir) } catch {}
  if (!existsSync(cliPath)) {
    // 解压结构可能是 Release/ 子目录——移动失败则如实报错
    throw new Error('解压后未找到 whisper-cli——请手动检查 ' + binDir)
  }
  log(`✓ whisper-cli 就绪：${cliPath}`)
}

// ── 2. ggml 模型 ──
const modelsDir = join(dataDir, 'voice', 'models')
mkdirSync(modelsDir, { recursive: true })
const modelPath = join(modelsDir, `ggml-${modelName}.bin`)

if (existsSync(modelPath) && statSync(modelPath).size > 1024 * 1024) {
  log(`✓ 模型已存在：${modelPath} (${(statSync(modelPath).size / 1024 / 1024).toFixed(0)}MB)`)
} else {
  const url = MODEL_MIRRORS[modelName]
  if (!url) throw new Error(`未知模型：${modelName}（可选 tiny/base/small）`)
  await download(url, modelPath, EXPECTED_SIZES[modelName])
  log(`✓ 模型就绪：${modelPath}`)
}

log('安装完成——运行 /voice status 验证 STT 就绪（sttAvailable: true）')
