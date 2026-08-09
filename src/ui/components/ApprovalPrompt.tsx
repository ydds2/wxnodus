// src/ui/components/ApprovalPrompt.tsx — L6-2 确认弹层（4 选项：once/session/always/deny）
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { getOverlay, patchOverlay } from '../../app/stores/overlayStore.js';
import { getTheme } from '../theme.js';

export function ApprovalPrompt({ onRespond }: { onRespond: (choice: 'once' | 'session' | 'always' | 'deny') => void }) {
  const t = getTheme();
  const ov = getOverlay().approval;
  const opts: Array<{ k: 'once' | 'session' | 'always' | 'deny'; label: string }> = [
    { k: 'once', label: '1 仅此一次' },
    { k: 'session', label: '2 本次会话' },
    ...(ov?.allowPermanent ? [{ k: 'always' as const, label: '3 始终允许' }] : []),
    { k: 'deny', label: ov?.allowPermanent ? '4 拒绝' : '3 拒绝' },
  ];
  useInput((input, key) => {
    if (key.escape) { patchOverlay({ approval: null }); onRespond('deny'); return; }
    const n = parseInt(input, 10);
    const hit = opts.find(o => o.label.startsWith(String(n)));
    if (hit) { patchOverlay({ approval: null }); onRespond(hit.k); }
  });
  return (
    <Box borderStyle="round" borderColor={t.warn} paddingX={1} flexDirection="column">
      <Text color={t.warn} bold>{ov?.title ?? '需要确认'}</Text>
      <Text wrap="wrap">{ov?.detail ?? ''}</Text>
      <Text color={t.muted}>{opts.map(o => o.label).join(' · ')}（Esc 拒绝）</Text>
    </Box>
  );
}
