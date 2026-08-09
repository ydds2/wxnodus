// src/ui/components/Composer.tsx — L6-2 输入框（react-ink-textarea 编辑 + 纯函数键位处理）
// 设计：Enter 提交由 handleComposerKey 纯函数处理（可单测、终端无关）；
//       Shift+Enter/Ctrl+J 换行；↑↓ 历史；模式边框变色
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextArea as Textarea } from 'react-ink-textarea';
import { getUi } from '../../app/stores/uiStore.js';
import { getTheme } from '../theme.js';
import { initComposer, handleComposerKey } from '../lib/composerKeys.js';

const MODE_COLOR: Record<string, string> = {
  smart: '#10b981', auto: '#10b981', manual: '#f59e0b', plan: '#a78bfa', yolo: '#f7768e',
};

export function Composer({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [st, setSt] = useState(() => initComposer());
  const u = getUi();
  const t = getTheme();
  const borderColor = MODE_COLOR[u.mode] ?? t.border;

  // 键位处理：Enter 提交 / Shift+Enter·Ctrl+J 换行 / ↑↓ 历史（纯函数）
  useInput((_inp, key) => {
    const { next, action } = handleComposerKey(st, {
      return: key.return, shift: key.shift, ctrl: key.ctrl,
      upArrow: key.upArrow, downArrow: key.downArrow,
    });
    if (action.type === 'submit') onSubmit(action.text);
    if (next !== st) setSt(next);
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text color={t.ok}>❯ </Text>
        <Textarea
          focus
          value={st.value}
          onChange={v => setSt(s => ({ ...s, value: v }))}
          onSubmit={() => { /* 提交由组件级 useInput 接管（终端兼容） */ }}
          placeholder={u.busy ? '任务进行中（Ctrl+C 中断）…' : '说人话，或 / 查看命令'}
        />
      </Box>
      <Text color={t.muted}>Enter 发送 · Shift+Enter 换行 · ↑↓ 历史 · / 面板 · Ctrl+R 搜索 · Ctrl+G 编辑器</Text>
    </Box>
  );
}
