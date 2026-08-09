// src/ui/components/Composer.tsx — L6-2 输入框（react-ink-textarea + 历史 + 模式边框变色）
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextArea as Textarea } from 'react-ink-textarea';
import { getUi } from '../../app/stores/uiStore.js';
import { getTheme } from '../theme.js';
import { createHistory } from './inputHistory.js';

const MODE_COLOR: Record<string, string> = {
  smart: '#10b981', auto: '#10b981', manual: '#f59e0b', plan: '#a78bfa', yolo: '#f7768e',
};

export function Composer({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [value, setValue] = useState('');
  const [hist] = useState(() => createHistory([]));
  const u = getUi();
  const t = getTheme();
  const borderColor = MODE_COLOR[u.mode] ?? t.border;

  useInput((_in, key) => {
    if (key.upArrow && !value.includes('\n')) { const v = hist.prev(); if (v !== undefined) setValue(v); }
    if (key.downArrow && !value.includes('\n')) { const v = hist.next(); if (v !== undefined) setValue(v); }
  });

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    hist.push(v);
    onSubmit(v);
    setValue('');
  };

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text color={t.ok}>❯ </Text>
        <Textarea
          focus
          value={value}
          onChange={setValue}
          onSubmit={submit}
          placeholder={u.busy ? '任务进行中（Ctrl+C 中断）…' : '说人话，或 / 查看命令'}
        />
      </Box>
      <Text color={t.muted}>Enter 发送 · Shift+Enter 换行 · ↑↓ 历史 · / 面板 · Ctrl+R 搜索 · Ctrl+G 编辑器</Text>
    </Box>
  );
}
