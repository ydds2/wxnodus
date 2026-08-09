// src/ui/components/ModelPicker.tsx — 模型选择器（参考 DeepSeek CLI / Claude Code 模型选择界面）
// 设计：provider 分组 + 当前模型标记（← current）+ ↑↓ 导航 + Enter 选择 +
//       Esc 取消 + 输入字符即时过滤 + ←→ 切换 Thinking 显示开关。
// 键位逻辑用纯函数 handlePickerKey 实现（可单测，零测量循环）。
import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { MODEL_CATALOG, filterModels } from '../../kernel/providers.js';
import type { ModelEntry } from '../../kernel/providers.js';
import { getTheme } from '../theme.js';

export interface PickerState { q: string; sel: number }

export function initPicker(): PickerState { return { q: '', sel: 0 }; }

// 纯函数：输入键 → 新状态 + 动作（选择/取消/切换 thinking/移动/过滤）
export function handlePickerKey(s: PickerState, key: { input?: string; return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; backspace?: boolean; ctrl?: boolean; inputChar?: string }, listLen: number): { next: PickerState; action: { type: 'pick' | 'cancel' | 'toggleThinking' | 'none' } } {
  if (key.return) return { next: s, action: { type: 'pick' } };
  if (key.escape) return { next: s, action: { type: 'cancel' } };
  if (key.leftArrow || key.rightArrow) return { next: s, action: { type: 'toggleThinking' } };
  if (key.upArrow) return { next: { ...s, sel: Math.max(0, s.sel - 1) }, action: { type: 'none' } };
  if (key.downArrow) return { next: { ...s, sel: Math.min(Math.max(listLen - 1, 0), s.sel + 1) }, action: { type: 'none' } };
  if (key.backspace) return { next: { ...s, q: s.q.slice(0, -1), sel: 0 }, action: { type: 'none' } };
  const ch = key.inputChar ?? key.input ?? '';
  if (ch && !key.ctrl) return { next: { ...s, q: s.q + ch, sel: 0 }, action: { type: 'none' } };
  return { next: s, action: { type: 'none' } };
}

// 按 provider 分组（保持目录顺序）
export function groupByProvider(list: ModelEntry[]): Array<{ provider: string; models: ModelEntry[] }> {
  const out: Array<{ provider: string; models: ModelEntry[] }> = [];
  for (const m of list) {
    const g = out.find(g => g.provider === m.provider);
    if (g) g.models.push(m);
    else out.push({ provider: m.provider, models: [m] });
  }
  return out;
}

export function ModelPicker({ currentModel, thinking, onPick, onCancel, onThinkingChange }: {
  currentModel: string;
  thinking: boolean;
  onPick: (m: ModelEntry) => void;
  onCancel: () => void;
  onThinkingChange: (on: boolean) => void;
}) {
  const [st, setSt] = useState<PickerState>(() => initPicker());
  const t = getTheme();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const totalW = Math.max(width - 2, 40);
  const title = ' Select a model (type to search) ';
  const topBorder = `╭${title}${'─'.repeat(Math.max(totalW - title.length - 1, 2))}╮`;
  const bottomBorder = `╰${'─'.repeat(totalW - 1)}╯`;

  const hits = filterModels(st.q);
  const groups = groupByProvider(hits);
  const flat = hits;

  useInput((inp, key) => {
    const { next, action } = handlePickerKey(st, {
      input: inp, return: key.return, escape: key.escape,
      upArrow: key.upArrow, downArrow: key.downArrow,
      leftArrow: key.leftArrow, rightArrow: key.rightArrow,
      backspace: key.backspace, ctrl: key.ctrl,
    }, flat.length);
    if (action.type === 'pick' && flat[st.sel]) { onPick(flat[st.sel]); return; }
    if (action.type === 'cancel') { onCancel(); return; }
    if (action.type === 'toggleThinking') { onThinkingChange(!thinking); return; }
    if (next !== st) setSt(next);
  });

  let flatIdx = 0;
  return (
    <Box flexDirection="column">
      <Box width={totalW} flexDirection="column">
        <Text color={t.accent}>{topBorder}</Text>
        <Text wrap="truncate-end">
          <Text color={t.muted}>{'  搜索'}</Text>
          <Text color={t.text}>{st.q ? ' / ' + st.q : ''}</Text>
          <Text color={t.muted}>{'（type to search）  ↑↓ 导航 · Enter 选择 · Esc 取消'}</Text>
        </Text>
        <Text color={t.muted}>{'│'}</Text>
        {groups.map(g => (
          <Box key={g.provider} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={t.muted}>{'  '}{g.provider}</Text>
            </Text>
            {g.models.map(m => {
              const isSel = flatIdx === st.sel;
              const isCur = m.modelId === currentModel || m.name === currentModel;
              flatIdx++;
              return (
                <Text key={m.modelId} wrap="truncate-end">
                  <Text color={isSel ? t.accent : t.muted}>{isSel ? '› ' : '  '}</Text>
                  <Text color={isCur ? t.ok : t.text} bold={isCur}>{isCur ? '■ ' : '□ '}{m.name}</Text>
                  {isCur && <Text color={t.muted}>{' ← current'}</Text>}
                </Text>
              );
            })}
          </Box>
        ))}
        {flat.length === 0 && <Text color={t.muted}>{'  无匹配模型'}</Text>}
        <Text color={t.muted}>{'│'}</Text>
        <Text wrap="truncate-end">
          <Text color={t.text}>{'  Thinking'}</Text>
          <Text color={t.muted}>{'（[←→] to switch）'}</Text>
          <Text color={thinking ? t.ok : t.muted}>{'  [On ]'}</Text>
          <Text color={thinking ? t.muted : t.text}>{' Off'}</Text>
        </Text>
        <Text color={t.border}>{bottomBorder}</Text>
      </Box>
    </Box>
  );
}
