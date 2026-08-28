// src/wxnodus-ui/components/blackHolePet.tsx — 角落黑洞情绪小宠物 + 模式徽章 + 启动欢迎卡片
// 趣味性拉满但保持简约：宠物 5 列宽常驻状态栏左缘（busy 吸积盘 / error 坍缩 / idle 呼吸），
// 欢迎卡片只在启动播 6 帧吸积盘后消散（WXNODUS_NO_INTRO=1 或非 full 动效档直接跳过）。
// 纯函数（petFace/modeBadgeSpec/welcomeLines）与渲染组件分离——全部可单测。
import { Box, Text } from '@wxnodus/ink'
import { useEffect, useState } from 'react'

import { accretionRing, breatheColor, motionTier } from '../lib/motion.js'
import type { Theme } from '../theme.js'
import { WXNODUS_VERSION } from '../../kernel/version.js'

export type PetMood = 'busy' | 'error' | 'idle'

/** 宠物脸（纯函数）：busy 吸积盘 4 帧循环 / error 坍缩警示 / idle 二拍呼吸。 */
export function petFace(mood: PetMood, i: number): string {
  if (mood === 'error') return '⚠ ◐ ◐'
  if (mood === 'busy') return accretionRing(i)[0] ?? '●'
  return i % 2 === 0 ? '◉  ·' : '◉ ·'
}

export type BadgeTone = 'accent' | 'error' | 'good' | 'muted' | 'warn'

/** 模式徽章语义（Kimi 同款模式着色）：风险越高 tone 越醒目；未知诚实回退 SMART。 */
export function modeBadgeSpec(mode: string): { label: string; tone: BadgeTone } {
  switch (mode) {
    case 'yolo': return { label: 'YOLO', tone: 'error' }
    case 'auto': return { label: 'AUTO', tone: 'good' }
    case 'manual': return { label: 'MANUAL', tone: 'warn' }
    case 'plan': return { label: 'PLAN', tone: 'accent' }
    case 'goal': return { label: 'GOAL', tone: 'warn' }
    default: return { label: 'SMART', tone: 'muted' }
  }
}

/** 括号键帽形式标签：[MANUAL] */
export function permBadgeLabel(mode: string): string {
  return `[${modeBadgeSpec(mode).label}]`
}

/** 欢迎卡片帧内容（纯函数）：吸积盘 + 版本 + 模式徽章——每帧确定性。
 * V4 附加：版本号上卡（claude code/codex 启动显版本对齐——此前升级后 TUI 零版本反馈）。 */
export function welcomeLines(i: number, mode: string, version?: string): string[] {
  const ring = accretionRing(i)
  return [
    `${ring[0]}  wxnodus${version ? ` v${version}` : ''}`,
    `${(ring[1] ?? '').padEnd(7)}  ${permBadgeLabel(mode)} · /help 查看命令`
  ]
}

const PET_WIDTH = 5
const WELCOME_FRAMES = 6
const WELCOME_FRAME_MS = 250

export function BlackHolePet({ mood, t }: { mood: PetMood; t: Theme }) {
  const tier = motionTier()
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (tier === 'off') {
      return
    }

    // subtle 档降帧率（800ms——conhost 慢刷新也能跟上）；full 档 400ms
    const id = setInterval(() => setTick(x => x + 1), tier === 'subtle' ? 800 : 400)
    return () => clearInterval(id)
  }, [tier])

  if (tier === 'off') {
    return null
  }

  const color = mood === 'error' ? t.color.error : mood === 'busy' ? t.color.accent : breatheColor(tick)

  return (
    <Box flexShrink={0} width={PET_WIDTH}>
      <Text color={color}>{petFace(mood, tick)}</Text>
    </Box>
  )
}

export function WelcomeCard({ mode, t }: { mode: string; t: Theme }) {
  const tier = motionTier()
  const [i, setI] = useState(0)

  useEffect(() => {
    // 只在 full 动效档播放（modern 终端）；NO_INTRO 与动效 off 由渲染短路跳过
    if (tier !== 'full') {
      return
    }

    if (i >= WELCOME_FRAMES) {
      return
    }

    const id = setTimeout(() => setI(x => x + 1), WELCOME_FRAME_MS)
    return () => clearTimeout(id)
  }, [i, tier])

  if (tier !== 'full' || process.env.WXNODUS_NO_INTRO === '1' || i >= WELCOME_FRAMES) {
    return null
  }

  const lines = welcomeLines(i, mode, WXNODUS_VERSION)
  const badge = modeBadgeSpec(mode)
  const badgeText = permBadgeLabel(mode)
  const badgeColor =
    badge.tone === 'error'
      ? t.color.error
      : badge.tone === 'warn'
        ? t.color.warn
        : badge.tone === 'accent'
          ? t.color.accent
          : badge.tone === 'good'
            ? t.color.statusGood
            : t.color.muted
  const line2 = lines[1] ?? ''
  const idx = line2.indexOf(badgeText)

  return (
    <Box flexShrink={0} marginTop={1} paddingX={2} borderStyle="round" borderColor={t.color.border}>
      <Text color={t.color.accent}>{lines[0]}</Text>
      <Text color={t.color.muted}>
        {idx >= 0 ? line2.slice(0, idx) : line2}
        <Text color={badgeColor} bold>{badgeText}</Text>
        {idx >= 0 ? line2.slice(idx + badgeText.length) : ''}
      </Text>
    </Box>
  )
}
