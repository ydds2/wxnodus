// src/ui/components/StartupCard.tsx — 首屏品牌面板（Kimi/Codex 风格：标题栏边框 + 分层信息）
// 设计：顶部边框嵌品牌名，品牌块（logo/口号/副标题），状态点清单（模型/目录/能力），
//       快速上手引导。全部静态渲染——无测量、无动画循环，从根上杜绝渲染抖动。
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { getTheme } from '../theme.js';

export function StartupCard({ model, version, cwd }: { model: string; version: string; cwd: string }) {
  const t = getTheme();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const totalW = Math.min(width - 2, 78); // 整框宽
  const title = ` WxNodus ${version} `;
  const topBorder = `╭${title}${'─'.repeat(Math.max(totalW - title.length - 1, 2))}╮`;
  const bottomBorder = `╰${'─'.repeat(totalW - 1)}╯`;
  const modelOk = !!model;

  return (
    <Box flexDirection="column">
      <Box width={totalW} flexDirection="column">
        <Text color={t.accent}>{topBorder}</Text>
        <Text color={t.muted}>{'│'}</Text>
        <Text wrap="truncate-end">
          <Text color={t.accent} bold>{'  ◆  WxNodus '}</Text>
          <Text color={t.muted}>{'v' + version}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={t.text} bold>{'     概念编译器 — 说一句话，交付可运行系统'}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={t.muted}>{'     概念进 · 证据出 · 全程可审计'}</Text>
        </Text>
        <Text color={t.muted}>{'│'}</Text>
        <Text wrap="truncate-end">
          <Text color={modelOk ? t.ok : t.warn}>{modelOk ? '●' : '○'}</Text>
          <Text color={t.text}>{'  模型   '}</Text>
          <Text color={t.muted}>{model || '规则脑（未配置 key，可 /key 设置）'}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={t.ok}>{'●'}</Text>
          <Text color={t.text}>{'  目录   '}</Text>
          <Text color={t.muted}>{cwd}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={t.accent}>{'✦'}</Text>
          <Text color={t.text}>{'  能力   '}</Text>
          <Text color={t.muted}>{'黑洞记忆 · 概念编译 · 组件锻造 · GLM 视觉 · Computer Use'}</Text>
        </Text>
        <Text color={t.muted}>{'│'}</Text>
        <Text wrap="truncate-end">
          <Text color={t.ok}>{'❯'}</Text>
          <Text color={t.text}>{'  直接说人话开始'}</Text>
          <Text color={t.muted}>{'（如「做个待办系统」「体检一下」）'}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color={t.muted}>{'  或输入 / 打开命令面板 · /help 查看全部命令'}</Text>
        </Text>
        <Text color={t.muted}>{'│'}</Text>
        <Text color={t.border}>{bottomBorder}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={t.muted}>{'── WxNodus · 概念进，证据出 ──'}</Text>
      </Box>
    </Box>
  );
}
