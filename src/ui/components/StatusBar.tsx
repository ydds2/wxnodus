// src/ui/components/StatusBar.tsx — L6-2 Kimi 式状态条（模型│上下文条│时钟 + 模式徽章 + 阶段）
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getUi } from '../../app/stores/uiStore.js';
import { getTheme } from '../theme.js';

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
  const barLen = 20;
  const filled = Math.round(pct / 5);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLen - filled));
  return (
    <Box borderStyle="single" borderColor={t.statusBg} justifyContent="space-between" width="100%">
      <Text color={t.muted}>{u.model || '未配置模型'}{u.busy ? ' ⏳' : ''}</Text>
      <Text color={t.muted}>{bar} {pct}%</Text>
      <Text color={t.muted}>{u.stage} │ {u.mode} │ {clock}</Text>
    </Box>
  );
}
