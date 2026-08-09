// src/ui/components/StatusBar.tsx — Kimi 式单行状态条（模型+上下文条 │ 阶段 │ 模式+时钟）
// 设计（参考 shots-kimi）：整条深底背景色块，三栏竖线分隔；时钟每秒刷新（仅本组件 state）。
import React, { useEffect, useState } from 'react';
import { Text, useStdout } from 'ink';
import { getUi } from '../../app/stores/uiStore.js';
import { getTheme } from '../theme.js';

const MODE_BADGE: Record<string, { label: string; color: string }> = {
  smart: { label: 'smart', color: '#10b981' },
  auto: { label: 'auto', color: '#10b981' },
  manual: { label: 'manual', color: '#f59e0b' },
  plan: { label: 'plan', color: '#a78bfa' },
  yolo: { label: 'yolo', color: '#f7768e' },
};

export function StatusBar({ version }: { version?: string }) {
  const u = getUi();
  const t = getTheme();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const [, force] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => force(x => x + 1), 1000); // 时钟每秒刷新
    return () => clearInterval(iv);
  }, []);
  const clock = u.clock || new Date().toTimeString().slice(0, 8);
  const pct = Math.round(u.contextPct * 100);
  const barLen = 12;
  const filled = Math.round(pct / (100 / barLen));
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLen - filled));
  const badge = MODE_BADGE[u.mode] ?? MODE_BADGE.smart;
  const bg = t.statusBg;

  const left = `${u.model || '未配置模型'}${u.busy ? ' ⏳' : ''}`;
  const mid = ` ${bar} ${pct}%`;
  const right = ` ${u.stage || 'idle'} `;
  const far = ` ${badge.label} ${clock}${version ? ` v${version}` : ''} `;

  return (
    <Text backgroundColor={bg}>
      <Text color={t.text} backgroundColor={bg}>{left}</Text>
      <Text color={t.muted} backgroundColor={bg}> │</Text>
      <Text color={pct >= 80 ? t.warn : t.text} backgroundColor={bg}>{mid}</Text>
      <Text color={t.muted} backgroundColor={bg}> │</Text>
      <Text color={u.busy ? t.ok : t.muted} backgroundColor={bg}>{right}</Text>
      <Text color={t.muted} backgroundColor={bg}> │</Text>
      <Text color={badge.color} backgroundColor={bg}>{far}</Text>
      <Text color={t.muted} backgroundColor={bg}>{' '.repeat(Math.max(width - 8 - left.length - mid.length - right.length - far.length, 2))}</Text>
    </Text>
  );
}
