// src/ui/components/CommandPanel.tsx — L6-2 命令面板（fuzzysort 模糊匹配 + ink-virtual-list）
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { VirtualList } from 'ink-virtual-list';
import fuzzysort from 'fuzzysort';
import { SLASH, COMMAND_DESC, COMMAND_CAT } from '../../commands/registry.js';
import { patchOverlay } from '../../app/stores/overlayStore.js';

export function filterCommands(q: string, list: string[]): string[] {
  if (!q) return list.slice(0, 10);
  const exact = list.filter(c => c.startsWith(q));
  const fuzzy = fuzzysort.go(q, list, { limit: 10 }).map(r => r.target);
  return [...new Set([...exact, ...fuzzy])];
}

export function CommandPanel({ onPick }: { onPick: (cmd: string) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const hits = filterCommands(q, SLASH);
  useInput((input, key) => {
    if (key.escape) { patchOverlay({ panel: false }); return; }
    if (key.return) { if (hits[sel]) onPick(hits[sel]); patchOverlay({ panel: false }); return; }
    if (key.upArrow) { setSel(s => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSel(s => Math.min(hits.length - 1, s + 1)); return; }
    if (key.backspace) { setQ(q => q.slice(0, -1)); setSel(0); return; }
    if (input && input.length === 1) { setQ(q => q + input); setSel(0); }
  });
  return (
    <Box borderStyle="round" borderColor="#334155" flexDirection="column" paddingX={1}>
      <Text color="#a78bfa">/ {q}▎（↑↓ 选择 · Enter 执行 · Esc 关闭）</Text>
      <Box flexDirection="column">
        {hits.map((c, i) => (
          <Box key={c} flexDirection="row">
            <Text color={i === sel ? '#a78bfa' : '#64748b'}>{i === sel ? '› ' : '  '}{COMMAND_CAT[c] ?? '·'} {c}</Text>
            <Text color="#475569"> {COMMAND_DESC[c]?.slice(0, 40) ?? ''}</Text>
          </Box>
        ))}
        {hits.length === 0 && <Text color="#64748b">无匹配命令</Text>}
      </Box>
    </Box>
  );
}
