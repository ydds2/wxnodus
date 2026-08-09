// src/ui/components/SessionsPicker.tsx — 会话选择器（/sessions 打开；↑↓ 导航 · Enter 恢复 · Esc 关闭）
import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { patchOverlay } from '../../app/stores/overlayStore.js';
import { getTheme } from '../theme.js';

export interface SessionRow { id: string; title: string; msgs: number; ts: number }

export function SessionsPicker({ sessions, onPick }: { sessions: SessionRow[]; onPick: (id: string) => void }) {
  const t = getTheme();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const totalW = Math.max(width - 2, 40);
  const [sel, setSel] = useState(0);
  const title = ' 会话 ';
  const topBorder = `╭${title}${'─'.repeat(Math.max(totalW - title.length - 1, 2))}╮`;
  const bottomBorder = `╰${'─'.repeat(totalW - 1)}╯`;

  useInput((_inp, key) => {
    if (key.escape) { patchOverlay({ sessions: false }); return; }
    if (key.return) { if (sessions[sel]) onPick(sessions[sel]!.id); patchOverlay({ sessions: false }); return; }
    if (key.upArrow) { setSel(s => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSel(s => Math.min(sessions.length - 1, s + 1)); return; }
  });

  return (
    <Box flexDirection="column">
      <Box width={totalW} flexDirection="column">
        <Text color={t.accent}>{topBorder}</Text>
        <Text wrap="truncate-end">
          <Text color={t.muted}>{'  ↑↓ 选择 · Enter 恢复 · Esc 关闭'}</Text>
        </Text>
        <Text color={t.muted}>{'│'}</Text>
        {sessions.map((s, i) => (
          <Text key={s.id} wrap="truncate-end">
            <Text color={i === sel ? t.accent : t.muted}>{i === sel ? '› ' : '  '}</Text>
            <Text color={i === sel ? t.accent : t.text} bold={s.id === 'default'}>{s.id === 'default' ? '▶ ' : ''}{s.id}</Text>
            <Text color={t.muted}>{'  '}{s.title || '(无标题)'}</Text>
            <Text color={t.muted}>{'  '}{s.msgs} 条</Text>
          </Text>
        ))}
        {sessions.length === 0 && <Text color={t.muted}>{'  暂无会话'}</Text>}
        <Text color={t.border}>{bottomBorder}</Text>
      </Box>
    </Box>
  );
}
