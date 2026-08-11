import { Box, Text, useInput, useStdout } from '@wxnodus/ink'
import { useEffect, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import { rpcErrorMessage } from '../lib/rpc.js'
import type { Theme } from '../theme.js'

import { OverlayHint, useOverlayKeys, windowItems, windowOffset } from './overlayControls.js'

const VISIBLE = 12
const MIN_WIDTH = 40
const MAX_WIDTH = 90

export function SkillsHub({ gw, onClose, t }: SkillsHubProps) {
  const [skillsByCat, setSkillsByCat] = useState<Record<string, string[]>>({})
  const [selectedCat, setSelectedCat] = useState('')
  const [catIdx, setCatIdx] = useState(0)
  const [skillIdx, setSkillIdx] = useState(0)
  const [stage, setStage] = useState<'actions' | 'category' | 'skill'>('category')
  const [info, setInfo] = useState<null | SkillInfo>(null)
  const [installing, setInstalling] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const { stdout } = useStdout()
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (stdout?.columns ?? 80) - 6))

  useEffect(() => {
    gw.request<{ skills?: Record<string, string[]> }>('skills.manage', { action: 'list' })
      .then(r => {
        setSkillsByCat(r?.skills ?? {})
        setErr('')
        setLoading(false)
      })
      .catch((e: unknown) => {
        setErr(rpcErrorMessage(e))
        setLoading(false)
      })
  }, [gw])

  const cats = Object.keys(skillsByCat).sort()
  const skills = selectedCat ? (skillsByCat[selectedCat] ?? []) : []
  const skillName = skills[skillIdx] ?? ''

  const back = () => {
    if (stage === 'actions') {
      setStage('skill')
      setInfo(null)
      setErr('')

      return
    }

    if (stage === 'skill') {
      setStage('category')
      setSkillIdx(0)

      return
    }

    onClose()
  }

  useOverlayKeys({ disabled: installing, onBack: back, onClose })

  const inspect = (name: string) => {
    setInfo(null)
    setErr('')

    gw.request<{ info?: SkillInfo }>('skills.manage', { action: 'inspect', query: name })
      .then(r => setInfo(r?.info ?? { name }))
      .catch((e: unknown) => setErr(rpcErrorMessage(e)))
  }

  const install = (name: string) => {
    setInstalling(true)
    setErr('')

    gw.request<{ installed?: boolean; name?: string }>('skills.manage', { action: 'install', query: name })
      .then(() => onClose())
      .catch((e: unknown) => setErr(rpcErrorMessage(e)))
      .finally(() => setInstalling(false))
  }

  useInput((ch, key) => {
    if (installing) {
      return
    }

    if (stage === 'actions') {
      if (key.return) {
        setStage('skill')
        setInfo(null)
        setErr('')

        return
      }

      if (ch.toLowerCase() === 'x' && skillName) {
        install(skillName)

        return
      }

      if (ch.toLowerCase() === 'i' && skillName) {
        inspect(skillName)
      }

      return
    }

    const count = stage === 'category' ? cats.length : skills.length
    const sel = stage === 'category' ? catIdx : skillIdx
    const setSel = stage === 'category' ? setCatIdx : setSkillIdx

    if (key.upArrow && sel > 0) {
      setSel(v => v - 1)

      return
    }

    if (key.downArrow && sel < count - 1) {
      setSel(v => v + 1)

      return
    }

    if (key.return) {
      if (stage === 'category') {
        const cat = cats[catIdx]

        if (!cat) {
          return
        }

        setSelectedCat(cat)
        setSkillIdx(0)
        setStage('skill')

        return
      }

      const name = skills[skillIdx]

      if (name) {
        setStage('actions')
        inspect(name)
      }

      return
    }

    const n = ch === '0' ? 10 : parseInt(ch, 10)

    if (!Number.isNaN(n) && n >= 1 && n <= Math.min(10, count)) {
      const next = windowOffset(count, sel, VISIBLE) + n - 1

      if (stage === 'category') {
        const cat = cats[next]

        if (cat) {
          setSelectedCat(cat)
          setCatIdx(next)
          setSkillIdx(0)
          setStage('skill')
        }

        return
      }

      const name = skills[next]

      if (name) {
        setSkillIdx(next)
        setStage('actions')
        inspect(name)
      }
    }
  })

  if (loading) {
    return <Text color={t.color.muted}>loading skills…</Text>
  }

  if (err && stage === 'category') {
    return (
      <Box flexDirection="column" width={width}>
        <Text color={t.color.label}>error: {err}</Text>
        <OverlayHint t={t}>Esc/q 取消</OverlayHint>
      </Box>
    )
  }

  if (!cats.length) {
    return (
      <Box flexDirection="column" width={width}>
        <Text color={t.color.muted}>无可用技能</Text>
        <OverlayHint t={t}>Esc/q 取消</OverlayHint>
      </Box>
    )
  }

  if (stage === 'category') {
    const rows = cats.map(c => `${c} · ${skillsByCat[c]?.length ?? 0} skills`)
    const { items, offset } = windowItems(rows, catIdx, VISIBLE)

    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent}>
          Skills Hub
        </Text>

        <Text color={t.color.muted}>select a category</Text>
        {offset > 0 && <Text color={t.color.muted}> ↑ {offset} 更多</Text>}

        {items.map((row, i) => {
          const idx = offset + i

          return (
            // A22 鼠标化：点击分类行 = 打开该分类（Enter 同语义）
            <Box
              key={row}
              onClick={() => {
                const cat = cats[idx]

                if (cat) {
                  setSelectedCat(cat)
                  setCatIdx(idx)
                  setSkillIdx(0)
                  setStage('skill')
                }
              }}
            >
              <Text
                bold={catIdx === idx}
                color={catIdx === idx ? t.color.accent : t.color.muted}
                inverse={catIdx === idx}
                wrap="truncate-end"
              >
                {catIdx === idx ? '▸ ' : '  '}
                {i + 1}. {row}
              </Text>
            </Box>
          )
        })}

        {offset + VISIBLE < rows.length && <Text color={t.color.muted}> ↓ {rows.length - offset - VISIBLE} 更多</Text>}
        <OverlayHint t={t}>↑/↓ 选择 · Enter 打开 · 1-9,0 快捷 · 鼠标点击直达 · Esc/q 取消</OverlayHint>
      </Box>
    )
  }

  if (stage === 'skill') {
    const { items, offset } = windowItems(skills, skillIdx, VISIBLE)

    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent}>
          {selectedCat}
        </Text>

        <Text color={t.color.muted}>{skills.length} skill(s)</Text>
        {!skills.length ? <Text color={t.color.muted}>该分类暂无技能</Text> : null}
        {offset > 0 && <Text color={t.color.muted}> ↑ {offset} 更多</Text>}

        {items.map((row, i) => {
          const idx = offset + i

          return (
            // A22 鼠标化：点击技能行 = 打开详情（Enter 同语义）
            <Box
              key={row}
              onClick={() => {
                const name = skills[idx]

                if (name) {
                  setSkillIdx(idx)
                  setStage('actions')
                  inspect(name)
                }
              }}
            >
              <Text
                bold={skillIdx === idx}
                color={skillIdx === idx ? t.color.accent : t.color.muted}
                inverse={skillIdx === idx}
                wrap="truncate-end"
              >
                {skillIdx === idx ? '▸ ' : '  '}
                {i + 1}. {row}
              </Text>
            </Box>
          )
        })}

        {offset + VISIBLE < skills.length && (
          <Text color={t.color.muted}> ↓ {skills.length - offset - VISIBLE} 更多</Text>
        )}
        <OverlayHint t={t}>
          {skills.length ? '↑/↓ 选择 · Enter 打开 · 1-9,0 快捷 · 鼠标点击直达 · Esc 返回 · q 关闭' : 'Esc 返回 · q 关闭'}
        </OverlayHint>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent}>
        {info?.name ?? skillName}
      </Text>

      <Text color={t.color.muted}>{info?.category ?? selectedCat}</Text>
      {info?.description ? <Text color={t.color.text}>{info.description}</Text> : null}
      {info?.path ? <Text color={t.color.muted}>path: {info.path}</Text> : null}
      {!info && !err ? <Text color={t.color.muted}>loading…</Text> : null}
      {err ? <Text color={t.color.label}>error: {err}</Text> : null}
      {installing ? <Text color={t.color.accent}>installing…</Text> : null}

      {/* A22 鼠标化：详情页动作按钮（i 复查 / x 重装 / Enter 返回） */}
      <Box flexDirection="row" marginTop={1}>
        <Box onClick={() => skillName && inspect(skillName)}>
          <Text bold color={t.color.accent}>
            i 复查
          </Text>
        </Box>
        <Text>{'  '}</Text>
        {!installing ? (
          <Box onClick={() => skillName && install(skillName)}>
            <Text color={t.color.muted}>x 重装</Text>
          </Box>
        ) : null}
        <Text>{'  '}</Text>
        <Box onClick={() => setStage('skill')}>
          <Text color={t.color.muted}>Enter 返回</Text>
        </Box>
      </Box>

      <OverlayHint t={t}>i 复查 · x 重装 · Enter/Esc 返回 · q 关闭 · 鼠标点击按钮</OverlayHint>
    </Box>
  )
}

interface SkillInfo {
  category?: string
  description?: string
  name?: string
  path?: string
}

interface SkillsHubProps {
  gw: GatewayClient
  onClose: () => void
  t: Theme
}
