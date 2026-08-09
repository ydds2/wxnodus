// src/ui/components/MessageLine.tsx — 单条消息渲染（Kimi 风格：无边框、轻量 gutter）
// 设计（参考 shots-kimi）：角色 gutter（❯ 用户 / ✦ 助手 / · 系统 / ⚡ 工具 / ✗ 错误）
// 不用 border box——避免空内容时边框撑满屏幕；空文本直接不渲染。
import React from 'react';
import { Box, Text } from 'ink';
import type { UiMsg } from '../../app/stores/types.js';
import { getTheme } from '../theme.js';
import { Markdown } from './Markdown.js';

const GUTTER: Record<string, { glyph: string; color: string }> = {
  user: { glyph: '❯', color: '#10b981' },
  assistant: { glyph: '✦', color: '#a78bfa' },
  system: { glyph: '·', color: '#64748b' },
  tool: { glyph: '⚡', color: '#f59e0b' },
};

export function MessageLine({ m }: { m: UiMsg }) {
  const t = getTheme();
  if (!m.text || !m.text.trim()) return null; // 空消息不渲染（防空盒子）

  if (m.error) {
    return (
      <Box flexDirection="row" marginLeft={1}>
        <Text color={t.error} bold>✗ </Text>
        <Text color={t.error} wrap="wrap">{m.text.slice(0, 500)}</Text>
      </Box>
    );
  }

  const g = GUTTER[m.role] ?? GUTTER.system;
  if (m.role === 'assistant') {
    return (
      <Box flexDirection="row">
        <Text color={g.color}>{g.glyph} </Text>
        <Box flexGrow={1}>
          <Markdown text={m.text} />
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={g.color}>{g.glyph} </Text>
        <Text color={m.role === 'user' ? t.text : t.muted} bold={m.role === 'user'} wrap="wrap">{m.text}</Text>
      </Box>
      {m.ms !== undefined && m.ms > 0 && <Text color={t.muted}>  Cooked for {Math.round(m.ms / 1000)}s</Text>}
    </Box>
  );
}
