// src/ui/components/ClarifyPrompt.tsx — 澄清弹窗（选项选择：↑↓ 导航 · Enter 确认 · Esc 取消）
import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getOverlay, patchOverlay } from '../../app/stores/overlayStore.js';
import { getTheme } from '../theme.js';

export function ClarifyPrompt({ onPick }: { onPick: (index: number) => void }) {
  const t = getTheme();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const totalW = Math.max(width - 2, 40);
  const ov = getOverlay().clarify;
  const opts = ov?.options ?? [];
  const [sel, setSel] = useState(0);
  const title = ' 澄清 ';
  const topBorder = `╭${title}${'─'.repeat(Math.max(totalW - title.length - 1, 2))}╮`;
  const bottomBorder = `╰${'─'.repeat(totalW - 1)}╯`;

  useInput((_inp, key) => {
    if (key.escape) { patchOverlay({ clarify: null }); return; }
    if (key.return) { patchOverlay({ clarify: null }); onPick(sel); return; }
    if (key.upArrow) { setSel(s => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSel(s => Math.min(opts.length - 1, s + 1)); return; }
  });

  return (
    <Box flexDirection="column">
      <Box width={totalW} flexDirection="column">
        <Text color={t.accent}>{topBorder}</Text>
        <Text wrap="truncate-end">
          <Text color={t.text} bold>{'  '}{ov?.question ?? ''}</Text>
        </Text>
        <Text color={t.muted}>{'│'}</Text>
        {opts.map((o, i) => (
          <Text key={i} wrap="truncate-end">
            <Text color={i === sel ? t.accent : t.muted}>{i === sel ? '› ' : '  '}</Text>
            <Text color={i === sel ? t.accent : t.text}>{o}</Text>
          </Text>
        ))}
        <Text color={t.muted}>{'│'}</Text>
        <Text wrap="truncate-end">
          <Text color={t.muted}>{'  ↑↓ 选择 · Enter 确认 · Esc 取消'}</Text>
        </Text>
        <Text color={t.border}>{bottomBorder}</Text>
      </Box>
    </Box>
  );
}
