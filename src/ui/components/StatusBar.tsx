// src/ui/components/StatusBar.tsx — L6-2 Kimi 式紧凑状态条（模型│上下文条│时钟 + 模式徽章 + 阶段）
// 参考 shots-kimi：单行三栏、无边框、竖线分隔
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getUi } from '../../app/stores/uiStore.js';
import { getTheme } from '../theme.js';

const MODE_BADGE: Record<string, { label: string; color: string }> = {
  smart: { label: 'smart', color: '#10b981' },
  auto: { label: 'auto', color: '#10b981' },
  manual: { label: 'manual', color: '#f59e0b' },
  plan: { label: 'plan', color: '#a78bfa' },
  yolo: { label: 'yolo', color: '#f7768e' },
};

export function StatusBar() {
  const u = getUi();
  const t = getTheme();
  const [, force] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => force(x => x + 1), 1000); // 时钟每秒刷新
    return () => clearInterval(iv);
  }, []);
  const clock = u.clock || new Date().toTimeString().slice(0, 8);
  const pct = Math.round(u.contextPct * 100);
  const barLen = 16;
  const filled = Math.round(pct / (100 / barLen));
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLen - filled));
  const badge = MODE_BADGE[u.mode] ?? MODE_BADGE.smart;

  return (
    <Box justifyContent="space-between" width="100%">
      <Box>
        <Text color={t.muted}>{u.model || '未配置模型'}{u.busy ? ' ⏳' : ''}</Text>
        <Text color={t.muted}> │ </Text>
        <Text color={pct >= 80 ? t.warn : t.muted}>{bar} {pct}%</Text>
      </Box>
      <Box>
        <Text color={t.muted}>{u.stage}</Text>
        <Text color={t.muted}> │ </Text>
        <Text color={badge.color}>{badge.label}</Text>
        <Text color={t.muted}> │ </Text>
        <Text color={t.muted}>{clock}</Text>
      </Box>
    </Box>
  );
}
