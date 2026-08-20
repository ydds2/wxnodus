import { Box, Text, useInput, useStdout } from '@wxnodus/ink'
import { topEntry } from '../runtime/overlayStack.js'
import { getOverlayState } from '../runtime/promptStore.js'
import { useEffect, useMemo, useState } from 'react'

import { providerDisplayNames } from '../domain/providers.js'
import { TUI_SESSION_MODEL_FLAG } from '../domain/slash.js'
import type { GatewayClient } from '../gatewayClient.js'
import type { ModelOptionProvider, ModelOptionsResponse } from '../gatewayTypes.js'
import { fuzzyRank } from '../lib/fuzzy.js'
import { asRpcResult, rpcErrorMessage } from '../lib/rpc.js'
import type { Theme } from '../theme.js'

import { OverlayHint, useOverlayKeys, windowItems } from './overlayControls.js'
import { icon } from '../glyphs.js'

const VISIBLE = 12
const MIN_WIDTH = 40
const MAX_WIDTH = 90

type Stage = 'provider' | 'key' | 'model' | 'disconnect' | 'add'

/** 添加自定义接口表单：四字段顺序（名称 → 地址 → 模型ID → 密钥可空） */
const ADD_FIELDS = [
  { label: '名称（显示名）', hint: '如：我的中转站', required: true },
  { label: '接口地址（OpenAI 兼容）', hint: '如：https://relay.example.com/v1', required: true },
  { label: '模型ID（逗号分隔）', hint: '如：gpt-4o-mini,o3-mini', required: true },
  { label: 'API 密钥（可选，Enter 跳过）', hint: 'sk-…（可留空，稍后 ^k 配置）', required: false },
] as const

export function ModelPicker({ allowPersistGlobal = true, gw, onCancel, onSelect, sessionId, t }: ModelPickerProps) {
  const [providers, setProviders] = useState<ModelOptionProvider[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [persistGlobal, setPersistGlobal] = useState(false)
  const [providerIdx, setProviderIdx] = useState(0)
  const [modelIdx, setModelIdx] = useState(0)
  const [stage, setStage] = useState<Stage>('provider')
  const [keyInput, setKeyInput] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [keyError, setKeyError] = useState('')
  // 添加自定义接口表单状态（四字段顺序推进；提交经 model.add RPC——与 /model add 同一写入路径）
  const [addField, setAddField] = useState(0)
  const [addInput, setAddInput] = useState('')
  const [addValues, setAddValues] = useState({ name: '', baseURL: '', models: '', key: '' })
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState('')
  // 添加成功后的一次性提示（provider 阶段展示，下次打开清空）
  const [notice, setNotice] = useState('')
  // Type-to-filter query, scoped per stage (cleared on stage change).
  const [filter, setFilter] = useState('')
  // A13 修复：过滤前选中位置（清过滤后恢复，参考 providerIndexAfterClearingFilter 同款）
  const [preFilterProviderIdx, setPreFilterProviderIdx] = useState(0)
  const [preFilterModelIdx, setPreFilterModelIdx] = useState(0)

  const { stdout } = useStdout()
  // Pin the picker to a stable width so the FloatBox parent (which shrinks-
  // to-fit with alignSelf="flex-start") doesn't resize as long provider /
  // model names scroll into view, and so `wrap="truncate-end"` on each row
  // has an actual constraint to truncate against.
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (stdout?.columns ?? 80) - 6))

  useEffect(() => {
    gw.request<ModelOptionsResponse>('model.options', sessionId ? { session_id: sessionId } : {})
      .then(raw => {
        const r = asRpcResult<ModelOptionsResponse>(raw)

        if (!r) {
          setErr('invalid response: model.options')
          setLoading(false)

          return
        }

        const next = r.providers ?? []
        setProviders(next)
        setCurrentModel(String(r.model ?? ''))
        setProviderIdx(
          Math.max(
            0,
            next.findIndex(p => p.is_current)
          )
        )
        setModelIdx(0)
        setStage('provider')
        setErr('')
        setLoading(false)
      })
      .catch((e: unknown) => {
        setErr(rpcErrorMessage(e))
        setLoading(false)
      })
  }, [gw, sessionId])

  const names = useMemo(() => providerDisplayNames(providers), [providers])

  // Provider rows carry their display name so fuzzy filtering can match on
  // name + slug while keeping the name/provider pairing intact across ranking.
  const providerRows = useMemo(
    () => providers.map((p, i) => ({ provider: p, name: names[i] ?? p.name ?? p.slug })),
    [providers, names]
  )

  // providerIdx / modelIdx always index into the *displayed* (filtered) lists.
  // With an empty filter the filtered list equals the full list, so navigation
  // behaves exactly as before. Filtering only applies on the relevant stage.
  const filteredProviderRows = useMemo(() => {
    if (stage !== 'provider' || !filter.trim()) {
      return providerRows
    }

    return fuzzyRank(
      providerRows,
      filter,
      row => `${row.name} ${row.provider.slug} ${(row.provider.models ?? []).join(' ')}`
    ).map(r => r.item)
  }, [providerRows, filter, stage])

  const provider = filteredProviderRows[providerIdx]?.provider
  const allModels = useMemo(() => provider?.models ?? [], [provider])

  const filteredModels = useMemo(() => {
    if (stage !== 'model' || !filter.trim()) {
      return allModels
    }

    return fuzzyRank(allModels, filter, m => m).map(r => r.item)
  }, [allModels, filter, stage])

  const models = filteredModels

  // Keep the active selection within the (possibly filtered) list bounds.
  useEffect(() => {
    if (providerIdx >= filteredProviderRows.length && filteredProviderRows.length > 0) {
      setProviderIdx(0)
    }
  }, [filteredProviderRows.length, providerIdx])

  useEffect(() => {
    if (modelIdx >= models.length && models.length > 0) {
      setModelIdx(0)
    }
  }, [models.length, modelIdx])

  const back = () => {
    // Esc first clears an active filter on the list stages, before navigating.
    if ((stage === 'provider' || stage === 'model') && filter.trim()) {
      // A13：清过滤后恢复过滤前选中
      setFilter('')
      if (stage === 'provider') setProviderIdx(preFilterProviderIdx)
      else setModelIdx(preFilterModelIdx)

      return
    }

    if (stage === 'model' || stage === 'key' || stage === 'disconnect' || stage === 'add') {
      setStage('provider')
      setModelIdx(0)
      setKeyInput('')
      setKeyError('')
      setKeySaving(false)
      setAddInput('')
      setAddError('')
      setAddSaving(false)
      setFilter('')

      return
    }

    onCancel()
  }

  // On the list stages we capture printable keys (including 'q') into the
  // filter, so the shared overlay q/Esc handler must yield to our own handler.
  const listStage = stage === 'provider' || stage === 'model'
  useOverlayKeys({ disabled: listStage, onBack: back, onClose: onCancel })

  // A22 鼠标化：接受动作提取（键盘 Enter 与鼠标点击行共用同一语义——
  // 点击其它提供商行时先切选中再前进，保证 stage 切换读到正确 provider）
  const acceptProviderAt = (idx: number) => {
    const p = filteredProviderRows[idx]?.provider

    if (!p) {
      return
    }

    if (p.authenticated === false) {
      if (p.auth_type === 'api_key' && p.key_env) {
        setProviderIdx(idx)
        setStage('key')
        setKeyInput('')
        setKeyError('')
        setFilter('')
      }

      return
    }

    setProviderIdx(idx)
    setStage('model')
    setModelIdx(0)
    setFilter('')
  }

  const acceptModelAt = (idx: number) => {
    const model = models[idx]

    if (provider && model) {
      onSelect(
        `${model} --provider ${provider.slug}${allowPersistGlobal && persistGlobal ? ' --global' : ` ${TUI_SESSION_MODEL_FLAG}`}`
      )
    } else {
      setStage('provider')
    }
  }

  // A24：密钥保存（键盘 Enter 与鼠标按钮共用）——真实 RPC model.save_key
  const saveKey = () => {
    if (!keyInput.trim() || keySaving || !provider) {
      return
    }
    setKeySaving(true)
    setKeyError('')
    gw.request<{ provider?: ModelOptionProvider }>('model.save_key', {
      slug: provider.slug,
      api_key: keyInput.trim(),
      ...(sessionId ? { session_id: sessionId } : {})
    })
      .then(raw => {
        const r = asRpcResult<{ provider?: ModelOptionProvider }>(raw)

        if (!r?.provider) {
          setKeyError('密钥保存失败')
          setKeySaving(false)

          return
        }

        setProviders(prev => prev.map(p => (p.slug === r.provider!.slug ? r.provider! : p)))
        setKeyInput('')
        setKeySaving(false)
        setStage('model')
        setModelIdx(0)
      })
      .catch((e: unknown) => {
        setKeyError(rpcErrorMessage(e))
        setKeySaving(false)
      })
  }

  /** 添加表单：Enter 推进字段（校验就地报错）；最后一字段 Enter → model.add 提交 */
  const addAdvance = () => {
    const field = ADD_FIELDS[addField]!
    const value = addInput.trim()
    const next = { ...addValues }
    if (addField === 0) next.name = value
    else if (addField === 1) next.baseURL = value
    else if (addField === 2) next.models = value
    else next.key = addInput.trim()

    if (field.required && !value) {
      setAddError(`「${field.label}」不能为空`)
      return
    }
    if (addField === 1 && !/^https?:\/\//i.test(value)) {
      setAddError('接口地址需以 http(s):// 开头')
      return
    }

    setAddError('')
    setAddValues(next)

    if (addField < ADD_FIELDS.length - 1) {
      setAddField(f => f + 1)
      setAddInput('')
      return
    }

    // 最后字段提交（密钥可为空）
    const modelIds = next.models.split(',').map(s => s.trim()).filter(Boolean)
    if (!modelIds.length) {
      setAddError('「模型ID」不能为空')
      return
    }
    setAddSaving(true)
    gw.request<{ ok?: boolean; id?: string; message?: string; provider?: ModelOptionProvider; error?: string }>('model.add', {
      name: next.name,
      base_url: next.baseURL,
      models: modelIds,
      ...(next.key ? { api_key: next.key } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    })
      .then(raw => {
        const r = asRpcResult<{ ok?: boolean; id?: string; message?: string; provider?: ModelOptionProvider; error?: string }>(raw)
        if (!r?.ok || !r.provider) {
          setAddError(r?.error || '添加失败（参数不完整）')
          setAddSaving(false)
          return
        }
        // 刷新列表 → 新档案分组可见；提示一次性成功消息
        setNotice(`已添加 ${r.provider.name}（${(r.provider.models ?? []).join('、')}）并切换为 ${r.provider.models?.[0] ?? ''}`)
        setAddSaving(false)
        setAddField(0)
        setAddInput('')
        setAddValues({ name: '', baseURL: '', models: '', key: '' })
        setStage('provider')
        setFilter('')
        setProviderIdx(prev => prev)
        // 重新拉取 model.options（新档案立即出现在列表）
        gw.request<ModelOptionsResponse>('model.options', sessionId ? { session_id: sessionId } : {})
          .then(raw2 => {
            const r2 = asRpcResult<ModelOptionsResponse>(raw2)
            if (r2) {
              setProviders(r2.providers ?? [])
              setCurrentModel(String(r2.model ?? ''))
              const cur = Math.max(0, (r2.providers ?? []).findIndex(p => p.is_current))
              setProviderIdx(cur)
            }
          })
          .catch(() => { /* 刷新失败保留旧列表 */ })
      })
      .catch((e: unknown) => {
        setAddError(rpcErrorMessage(e))
        setAddSaving(false)
      })
  }

  // A24：断开确认（键盘 y/Enter 与鼠标按钮共用）——真实 RPC model.disconnect
  const confirmDisconnect = () => {    if (!provider) {
      setStage('provider')

      return
    }
    setKeySaving(true)
    gw.request<{ disconnected?: boolean }>('model.disconnect', {
      slug: provider.slug,
      ...(sessionId ? { session_id: sessionId } : {})
    })
      .then(raw => {
        const r = asRpcResult<{ disconnected?: boolean }>(raw)

        if (r?.disconnected) {
          setProviders(prev =>
            prev.map(p =>
              p.slug === provider.slug
                ? {
                    ...p,
                    authenticated: false,
                    models: [],
                    total_models: 0,
                    warning: p.key_env ? `粘贴 ${p.key_env} 以激活` : '运行 `wxnodus model` 配置'
                  }
                : p
            )
          )
        }

        setKeySaving(false)
        setStage('provider')
      })
      .catch(() => {
        setKeySaving(false)
        setStage('provider')
      })
  }

  useInput((ch, key) => {
    // P1 收尾：Esc 仅当本面板为栈顶时消费——pager/工作台盖在上方时 Esc 归顶层
    // （防一次 Esc 弹两层 / 静默改内部 stage 状态）
    if (key.escape && topEntry(getOverlayState())?.kind !== 'modelPicker') {
      return
    }
    // Add-custom-interface form stage handles its own input
    if (stage === 'add') {
      if (addSaving) {
        return
      }

      if (key.return) {
        addAdvance()

        return
      }

      if (key.backspace || key.delete) {
        setAddInput(v => v.slice(0, -1))

        return
      }

      // ctrl+u clears input
      if (ch === '\u0015') {
        setAddInput('')

        return
      }

      if (ch && !key.ctrl && !key.meta) {
        setAddInput(v => v + ch)
      }

      return
    }

    // Key entry stage handles its own input
    if (stage === 'key') {
      if (keySaving) {
        return
      }

      if (key.return) {
        saveKey()

        return
      }

      if (key.backspace || key.delete) {
        setKeyInput(v => v.slice(0, -1))

        return
      }

      // ctrl+u clears input
      if (ch === '\u0015') {
        setKeyInput('')

        return
      }

      if (ch && !key.ctrl && !key.meta) {
        setKeyInput(v => v + ch)
      }

      return
    }

    // Disconnect confirmation stage
    if (stage === 'disconnect') {
      if (ch.toLowerCase() === 'y' || key.return) {
        confirmDisconnect()

        return
      }

      if (ch.toLowerCase() === 'n' || key.escape) {
        setStage('provider')

        return
      }

      return
    }

    // List-stage Esc/q handling (overlay keys are disabled while on a list
    // stage so 'q' can be typed into the filter).
    if (key.escape) {
      back()

      return
    }

    if (ch === 'q' && !filter) {
      onCancel()

      return
    }

    const count = stage === 'provider' ? filteredProviderRows.length : models.length
    const sel = stage === 'provider' ? providerIdx : modelIdx
    const setSel = stage === 'provider' ? setProviderIdx : setModelIdx

    if (key.upArrow && sel > 0) {
      setSel(v => v - 1)

      return
    }

    if (key.downArrow && sel < count - 1) {
      setSel(v => v + 1)

      return
    }

    if (key.return) {
      if (stage === 'provider') {
        acceptProviderAt(providerIdx)
      } else {
        acceptModelAt(modelIdx)
      }

      return
    }

    // Backspace removes the last filter character; Esc (above) clears a
    // non-empty filter before navigating back.
    if (key.backspace || key.delete) {
      setFilter(v => v.slice(0, -1))
      setSel(0)

      return
    }

    // Ctrl+U clears the filter. (Ctrl held → ch is the key name 'u'.)
    if (key.ctrl && ch === 'u') {
      setFilter('')
      setSel(0)

      return
    }

    // Persist-global toggle moved to Ctrl+G so 'g' can be typed into the
    // filter. With Ctrl held, @wxnodus/ink reports `ch` as the key name ('g'),
    // not the raw control byte (see input-event.ts: input = ctrl ? name : seq).
    if (allowPersistGlobal && key.ctrl && ch === 'g') {
      setPersistGlobal(v => !v)

      return
    }

    // Disconnect (Ctrl+D): only in provider stage, only for authenticated providers.
    if (key.ctrl && ch === 'd' && stage === 'provider' && provider?.authenticated !== false) {
      setStage('disconnect')

      return
    }

    // 添加自定义接口（Ctrl+A）：provider 阶段直达 add 表单（开放兼容——任意 OpenAI 端点）
    if (key.ctrl && ch === 'a' && stage === 'provider') {
      setStage('add')
      setAddField(0)
      setAddInput('')
      setAddError('')
      setFilter('')
      setNotice('')

      return
    }

    // 密钥（Ctrl+K）：provider 阶段直达当前提供商的 key 段（已认证也可改钥——/key 已并入 /model）
    if (key.ctrl && ch === 'k' && stage === 'provider' && provider?.auth_type === 'api_key') {
      setStage('key')
      setKeyInput('')
      setKeyError('')
      setFilter('')

      return
    }

    // Any other printable single character extends the filter.
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch >= ' ') {
      // A13：过滤首字符时记录当前选中（清过滤后恢复）
      if (!filter.trim()) {
        if (stage === 'provider') setPreFilterProviderIdx(providerIdx)
        else setPreFilterModelIdx(modelIdx)
      }
      setFilter(v => v + ch)
      setSel(0)
    }
  })

  if (loading) {
    return <Text color={t.color.muted}>加载模型中…</Text>
  }

  if (err) {
    return (
      <Box flexDirection="column">
        <Text color={t.color.label}>错误：{err}</Text>
        <OverlayHint t={t}>Esc/q 取消</OverlayHint>
      </Box>
    )
  }

  if (!providers.length) {
    return (
      <Box flexDirection="column">
        <Text color={t.color.muted}>无可用提供商（/model set-key 配置密钥，或 /model add 添加自定义接口）</Text>
        <OverlayHint t={t}>Esc/q 取消</OverlayHint>
      </Box>
    )
  }

  // ── Key entry stage ──────────────────────────────────────────────────
  if (stage === 'key' && provider) {
    const masked = keyInput ? '•'.repeat(Math.min(keyInput.length, 40)) : ''

    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent} wrap="truncate-end">
          {icon('key')} 配置 {provider.name}
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          在下方粘贴你的 API 密钥（加密保存）
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          {provider.key_env}:
        </Text>

        <Text color={t.color.accent} wrap="truncate-end">
          {'  '}
          {masked || '（空）'}
          {keySaving ? '' : '▎'}
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
        </Text>

        {keyError ? (
          <Text color={t.color.label} wrap="truncate-end">
            错误：{keyError}
          </Text>
        ) : keySaving ? (
          <Text color={t.color.muted} wrap="truncate-end">
            保存中…
          </Text>
        ) : (
          <Text color={t.color.muted} wrap="truncate-end">
            {' '}
          </Text>
        )}

        {/* A24：密钥录入按钮（此前仅键盘——Enter 保存 / Ctrl+U 清空 / Esc 返回） */}
        <Box flexDirection="row">
          <Box onClick={saveKey}>
            <Text bold color={keyInput.trim() ? t.color.accent : t.color.muted}>
              {keyInput.trim() ? `${icon('submit')} 保存` : `${icon('submit')} 保存（空）`}
            </Text>
          </Box>
          <Text>{'   '}</Text>
          <Box onClick={() => setKeyInput('')}>
            <Text color={t.color.muted}>Ctrl+U 清空</Text>
          </Box>
          <Text>{'   '}</Text>
          <Box onClick={() => setStage('provider')}>
            <Text color={t.color.muted}>Esc 返回</Text>
          </Box>
        </Box>

        <OverlayHint t={t}>Enter 保存 · Ctrl+U 清空 · Esc 返回 · 鼠标点击按钮</OverlayHint>
      </Box>
    )
  }

  // ── Add custom interface stage（＋ 添加自定义接口——四字段顺序表单）───
  if (stage === 'add') {
    const field = ADD_FIELDS[addField]!
    const masked = addField === 3 && addInput ? '•'.repeat(Math.min(addInput.length, 40)) : addInput

    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent} wrap="truncate-end">
          {icon('satellite')} 添加自定义接口（任意 OpenAI 兼容）
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          第 {addField + 1}/{ADD_FIELDS.length} 步 · {field.label} · Enter 继续
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          {field.hint}
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
        </Text>

        <Text color={t.color.accent} wrap="truncate-end">
          {'  '}
          {masked || '（空）'}
          {addSaving ? '' : '▎'}
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
        </Text>

        {addError ? (
          <Text color={t.color.label} wrap="truncate-end">
            错误：{addError}
          </Text>
        ) : addSaving ? (
          <Text color={t.color.muted} wrap="truncate-end">
            添加中…
          </Text>
        ) : (
          <Text color={t.color.muted} wrap="truncate-end">
            {' '}
          </Text>
        )}

        <Box flexDirection="row">
          <Box onClick={addAdvance}>
            <Text bold color={addInput.trim() || !field.required ? t.color.accent : t.color.muted}>
              {icon('submit')} {addField < ADD_FIELDS.length - 1 ? '下一步' : '提交'}
            </Text>
          </Box>
          <Text>{'   '}</Text>
          <Box onClick={() => setAddInput('')}>
            <Text color={t.color.muted}>Ctrl+U 清空</Text>
          </Box>
          <Text>{'   '}</Text>
          <Box onClick={() => setStage('provider')}>
            <Text color={t.color.muted}>Esc 返回</Text>
          </Box>
        </Box>

        <OverlayHint t={t}>Enter 下一步/提交 · Ctrl+U 清空 · Esc 返回 · 鼠标点击按钮</OverlayHint>
      </Box>
    )
  }

  // ── Disconnect confirmation stage ─────────────────────────────────────
  if (stage === 'disconnect' && provider) {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent} wrap="truncate-end">
          Disconnect {provider.name}?
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          This removes saved credentials for {provider.name}.
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          You can re-authenticate later by selecting it again.
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          {' '}
        </Text>

        {keySaving ? (
          <Text color={t.color.muted} wrap="truncate-end">
            disconnecting…
          </Text>
        ) : (
          <>
            {/* A24：断开确认按钮（此前仅 y/Enter 确认 · n/Esc 取消） */}
            <Box flexDirection="row">
              <Box onClick={confirmDisconnect}>
                <Text bold color={t.color.error}>
                  y 确认断开
                </Text>
              </Box>
              <Text>{'   '}</Text>
              <Box onClick={() => setStage('provider')}>
                <Text color={t.color.muted}>n 取消</Text>
              </Box>
            </Box>
            <OverlayHint t={t}>y/Enter 确认 · n/Esc 取消 · 鼠标点击按钮</OverlayHint>
          </>
        )}
      </Box>
    )
  }

  // ── Provider selection stage ─────────────────────────────────────────
  if (stage === 'provider') {
    const rows = filteredProviderRows.map(({ provider: p, name }) => {
      const authMark = p.authenticated === false ? '○' : p.is_current ? '*' : '●'
      const modelCount = p.total_models ?? p.models?.length ?? 0

      const suffix =
        p.authenticated === false
          ? p.auth_type === 'api_key'
            ? '（未配置密钥）'
            : '（需配置）'
          : `${modelCount} 个模型`

      return `${authMark} ${name} · ${suffix}`
    })

    const { items, offset } = windowItems(rows, providerIdx, VISIBLE)
    const noMatches = !!filter.trim() && rows.length === 0

    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent} wrap="truncate-end">
          {icon('satellite')} 选择提供商（第 1/2 步）
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          下一步展示完整模型 ID · Enter 继续
        </Text>

        <Text color={t.color.muted} wrap="truncate-end">
          当前：{currentModel || '（未知）'}
        </Text>
        <Text color={filter ? t.color.accent : t.color.muted} wrap="truncate-end">
          {filter ? `过滤：${filter}▎` : '输入过滤 · ↑/↓ 选择'}
        </Text>
        <Text color={t.color.label} wrap="truncate-end">
          {provider?.warning ? `警告：${provider.warning}` : ' '}
        </Text>
        <Text color={t.color.muted} wrap="truncate-end">
          {offset > 0 ? ` ↑ ${offset} 更多` : ' '}
        </Text>

        {noMatches ? (
          <Text color={t.color.muted} wrap="truncate-end">
            无匹配的提供商
          </Text>
        ) : (
          Array.from({ length: VISIBLE }, (_, i) => {
            const row = items[i]
            const idx = offset + i
            const p = filteredProviderRows[idx]?.provider
            const dimmed = p?.authenticated === false

            return row ? (
              // A22 鼠标化：点击提供商行 = 选中并前进（Enter 同语义）
              <Box key={p?.slug ?? `row-${idx}`} onClick={() => acceptProviderAt(idx)}>
                <Text
                  bold={providerIdx === idx}
                  color={providerIdx === idx ? t.color.accent : dimmed ? t.color.label : t.color.muted}
                  backgroundColor={providerIdx === idx ? t.color.selectionBg : undefined}
                  wrap="truncate-end"
                >
                  {providerIdx === idx ? '▸ ' : '  '}
                  {idx + 1}. {row}
                </Text>
              </Box>
            ) : (
              <Text color={t.color.muted} key={`pad-${i}`} wrap="truncate-end">
                {' '}
              </Text>
            )
          })
        )}

        <Text color={t.color.muted} wrap="truncate-end">
          {offset + VISIBLE < rows.length ? ` ↓ ${rows.length - offset - VISIBLE} 更多` : ' '}
        </Text>

        {notice ? (
          <Text color={t.color.ok} wrap="truncate-end">
            ✓ {notice}
          </Text>
        ) : (
          <Text color={t.color.muted} wrap="truncate-end">
            {' '}
          </Text>
        )}

        {/* 开放兼容入口：＋ 添加自定义接口（任意 OpenAI 端点）——Enter 语义经 ^a 直达，点击同义 */}
        <Box onClick={() => {
          setStage('add')
          setAddField(0)
          setAddInput('')
          setAddError('')
          setFilter('')
          setNotice('')
        }}>
          <Text color={t.color.accent} wrap="truncate-end">
            {'＋ 添加自定义接口（任意 OpenAI 兼容）· ^a'}
          </Text>
        </Box>

        {/* A24：持久化切换可点（^g 同语义） */}
        <Box onClick={() => allowPersistGlobal && setPersistGlobal(v => !v)}>
          <Text color={t.color.muted} wrap="truncate-end">
            持久化：{allowPersistGlobal ? (persistGlobal ? '全局' : '会话') : '会话'}
            {allowPersistGlobal ? ' · ^g 切换（点击切换）' : '（仅会话）'}
          </Text>
        </Box>
        <OverlayHint t={t}>↑/↓ 选择 · Enter 选用 · 鼠标点击直达 · ^k 密钥 · ^a 添加接口 · ^d 断开 · Esc 清空/返回 · q 关闭</OverlayHint>
      </Box>
    )
  }

  // ── Model selection stage ────────────────────────────────────────────
  const { items, offset } = windowItems(models, modelIdx, VISIBLE)
  const noModelMatches = !!filter.trim() && models.length === 0

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent} wrap="truncate-end">
        {icon('satellite')} 选择模型（第 2/2 步）
      </Text>

      <Text color={t.color.muted} wrap="truncate-end">
        {filteredProviderRows[providerIdx]?.name || '（未知提供商）'} · Esc 返回
      </Text>
      <Text color={filter ? t.color.accent : t.color.muted} wrap="truncate-end">
        {filter ? `过滤：${filter}▎` : '输入过滤 · ↑/↓ 选择'}
      </Text>
      <Text color={t.color.label} wrap="truncate-end">
        {provider?.warning ? `警告：${provider.warning}` : ' '}
      </Text>
      <Text color={t.color.muted} wrap="truncate-end">
        {offset > 0 ? ` ↑ ${offset} 更多` : ' '}
      </Text>

      {Array.from({ length: VISIBLE }, (_, i) => {
        const row = items[i]
        const idx = offset + i

        if (!row) {
          return (!allModels.length || noModelMatches) && i === 0 ? (
            <Text color={t.color.muted} key="empty" wrap="truncate-end">
              {noModelMatches ? '无匹配的模型' : '该提供商暂无模型'}
            </Text>
          ) : (
            <Text color={t.color.muted} key={`pad-${i}`} wrap="truncate-end">
              {' '}
            </Text>
          )
        }

        const prefix = modelIdx === idx ? '▸ ' : row === currentModel ? '* ' : '  '
        // 参考价目（USD/1M in/out；未收录定价不显示——诚实）
        const pr = provider?.prices?.[row]
        const priceSuffix = pr ? (pr.in === 0 && pr.out === 0 ? ' · 免费' : ` · ≈$${pr.in}/$${pr.out} M`) : ''

        return (
          // A22 鼠标化：点击模型行 = 立即选用（Enter 同语义）
          <Box key={`${provider?.slug ?? 'prov'}:${idx}:${row}`} onClick={() => acceptModelAt(idx)}>
            <Text
              bold={modelIdx === idx}
              color={modelIdx === idx ? t.color.accent : t.color.muted}
              backgroundColor={modelIdx === idx ? t.color.selectionBg : undefined}
              wrap="truncate-end"
            >
              {prefix}
              {idx + 1}. {row}
              <Text color={t.color.muted}>{priceSuffix}</Text>
            </Text>
          </Box>
        )
      })}

      <Text color={t.color.muted} wrap="truncate-end">
        {offset + VISIBLE < models.length ? ` ↓ ${models.length - offset - VISIBLE} 更多` : ' '}
      </Text>

      {/* A24：持久化切换可点（^g 同语义） */}
      <Box onClick={() => allowPersistGlobal && setPersistGlobal(v => !v)}>
        <Text color={t.color.muted} wrap="truncate-end">
          持久化：{allowPersistGlobal ? (persistGlobal ? '全局' : '会话') : '会话'}
          {allowPersistGlobal ? ' · ^g 切换（点击切换）' : '（仅会话）'}
        </Text>
      </Box>
      <OverlayHint t={t}>
        {models.length ? '↑/↓ 选择 · Enter 切换 · 鼠标点击直达 · Esc 清空/返回 · q 关闭' : 'Esc 返回 · q 关闭'}
      </OverlayHint>
    </Box>
  )
}

interface ModelPickerProps {
  allowPersistGlobal?: boolean
  gw: GatewayClient
  onCancel: () => void
  onSelect: (value: string) => void
  sessionId: string | null
  t: Theme
}
