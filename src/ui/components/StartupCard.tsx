// src/ui/components/StartupCard.tsx — L6-2 首屏（品牌 + 口号 + 引导 + 能力）
import React from 'react';
import { Box, Text } from 'ink';
import { getTheme } from '../theme.js';

export function StartupCard({ model, version, cwd }: { model: string; version: string; cwd: string }) {
  const t = getTheme();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.border} paddingX={2} paddingY={1}>
      <Text color={t.ok} bold>WxNodus {version} · 概念进·证据出</Text>
      <Text color={t.muted}>模型：{model || '规则脑（无 key 可用）'} │ 目录：{cwd}</Text>
      <Text color={t.muted}>说人话直接开始（如「做个待办系统」「体检」），或输入 / 查看命令面板</Text>
      <Text color={t.muted}>能力：黑洞记忆 · 概念编译 · 组件锻造 · GLM 视觉 · Computer Use</Text>
    </Box>
  );
}
