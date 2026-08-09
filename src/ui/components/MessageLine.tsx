// src/ui/components/MessageLine.tsx — L6-2 单条消息渲染（角色 gutter + 错误红框 + Markdown + Cooked）
import React from 'react';
import { Box, Text } from 'ink';
import type { UiMsg } from '../../app/stores/types.js';
import { getTheme } from '../theme.js';
import { Markdown } from './Markdown.js';

const GUTTER: Record<string, { glyph: string; color: string }> = {
  user: { glyph: '❯', color: '#10b981' },
  assistant: { glyph: '┊', color: '#a78bfa' },
  system: { glyph: '·', color: '#64748b' },
  tool: { glyph: '⚡', color: '#f59e0b' },
};

export function MessageLine({ m }: { m: UiMsg }) {
  const t = getTheme();
  const g = GUTTER[m.role] ?? GUTTER.system;
  if (m.error) {
    return (
      <Box marginLeft={2} borderStyle="round" borderColor={t.error} paddingX={1}>
        <Text color={t.error} wrap="wrap">{m.text.slice(0, 500)}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {m.role === 'user' && <Text color={t.border}>{"─".repeat(24)}</Text>}
      <Box flexDirection="row">
        <Text color={g.color} bold>{g.glyph} </Text>
        {m.role === 'assistant' ? (
          <Box borderStyle="round" borderColor={t.border} paddingX={1} flexGrow={1}>
            <Markdown text={m.text} />
          </Box>
        ) : (
          <Text color={m.role === 'user' ? t.text : t.muted} bold={m.role === 'user'} wrap="wrap">{m.text}</Text>
        )}
      </Box>
      {m.ms !== undefined && m.ms > 0 && <Text color={t.muted}>  Cooked for {Math.round(m.ms / 1000)}s</Text>}
    </Box>
  );
}
