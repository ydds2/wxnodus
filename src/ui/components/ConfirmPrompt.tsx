// src/ui/components/ConfirmPrompt.tsx — 危险操作确认弹窗（y 确认 / n 取消 / Esc 取消）
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getOverlay, patchOverlay } from '../../app/stores/overlayStore.js';
import { getTheme } from '../theme.js';

export function ConfirmPrompt({ onConfirm }: { onConfirm: (ok: boolean) => void }) {
  const t = getTheme();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const totalW = Math.max(width - 2, 40);
  const ov = getOverlay().confirm;
  const title = ' 确认 ';
  const topBorder = `╭${title}${'─'.repeat(Math.max(totalW - title.length - 1, 2))}╮`;
  const bottomBorder = `╰${'─'.repeat(totalW - 1)}╯`;

  useInput((_inp, key) => {
    if (key.escape) { patchOverlay({ confirm: null }); onConfirm(false); return; }
    if (key.return) { patchOverlay({ confirm: null }); onConfirm(true); return; }
  });

  return (
    <Box flexDirection="column">
      <Box width={totalW} flexDirection="column">
        <Text color={ov?.danger ? t.error : t.warn}>{topBorder}</Text>
        <Text wrap="truncate-end">
          <Text color={ov?.danger ? t.error : t.warn} bold>{'  ⚠ '}</Text>
          <Text color={t.text}>{ov?.text ?? ''}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={t.muted}>{'  Enter 确认 · Esc 取消'}</Text>
        </Text>
        <Text color={ov?.danger ? t.error : t.warn}>{bottomBorder}</Text>
      </Box>
    </Box>
  );
}
