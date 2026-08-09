// src/ui/components/StatusBar.tsx — Kimi 式单行状态条（模式+模型+思考 │ 上下文条+阶段 │ 目录 │ 时钟）
// 设计（参考 DeepSeek CLI 底部状态 `yolo model thinking C:\path`）：深底背景色块，
// 左段模式+模型+thinking，中段上下文条+阶段，右段工作目录（截断）+时钟+版本。
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
  const barLen = 10;
  const filled = Math.round(pct / (100 / barLen));
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLen - filled));
  const badge = MODE_BADGE[u.mode] ?? MODE_BADGE.smart;
  const bg = t.statusBg;

  // 目录/右段截断，保证整条不换行
  const cwd = u.cwd || '';
  const shortCwd = cwd.length > 20 ? '…' + cwd.slice(-19) : cwd;
  const thinking = u.thinking ? ' · thinking' : '';

  const left = `${badge.label} ${u.model || '规则脑'}${thinking}`.slice(0, 42);
  const mid = ` ${bar} ${pct}% ${u.stage || 'idle'}`.slice(0, 22);
  const right = ` ${shortCwd} `;
  const far = ` ${clock}${version ? ` v${version}` : ''} `.slice(0, 18);
  // 总长钳制：超出部分用截断的目录吸收
  const total = left.length + 1 + mid.length + 1 + right.length + 1 + far.length;
  const overflow = total - (width - 2);
  const dir = overflow > 0 ? ` ${'…' + shortCwd.slice(2 + overflow)} ` : right;

  return (
    <Text backgroundColor={bg}>
      <Text color={badge.color} backgroundColor={bg}>{left}</Text>
      <Text color={t.muted} backgroundColor={bg}> │</Text>
      <Text color={pct >= 80 ? t.warn : t.text} backgroundColor={bg}>{mid}</Text>
      <Text color={t.muted} backgroundColor={bg}> │</Text>
      <Text color={t.muted} backgroundColor={bg}>{dir}</Text>
      <Text color={t.muted} backgroundColor={bg}> │</Text>
      <Text color={t.text} backgroundColor={bg}>{far}</Text>
      <Text color={t.muted} backgroundColor={bg}>{' '.repeat(Math.max(width - 8 - left.length - mid.length - dir.length - far.length, 2))}</Text>
    </Text>
  );
}
