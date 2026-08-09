// src/ui/components/CommandPanel.tsx — 命令面板（fuzzysort 模糊匹配 + 分类分组）
// 设计（参考 Kimi/Codex 命令面板）：空查询时按分类分组展示（每组前 6 条），
// 输入字符时切换模糊匹配平铺列表；↑↓ 选择 · Enter 执行 · Esc 关闭。
import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import fuzzysort from 'fuzzysort';
import { SLASH, COMMAND_DESC, COMMAND_CAT } from '../../commands/registry.js';
import { patchOverlay } from '../../app/stores/overlayStore.js';
import { getTheme } from '../theme.js';

export function filterCommands(q: string, list: string[]): string[] {
  if (!q) return list.slice(0, 10);
  const exact = list.filter(c => c.startsWith(q));
  const fuzzy = fuzzysort.go(q, list, { limit: 10 }).map(r => r.target);
  return [...new Set([...exact, ...fuzzy])];
}

// 分类分组：◈ 通用 ⚙ 系统 ▤ 记忆 ◆ 构建 🛡 安全 👁 视觉 ⛭ 连接 ☆ 工具
const CAT_GROUPS: Array<{ sym: string; name: string }> = [
  { sym: '◈', name: '通用' },
  { sym: '⚙', name: '系统' },
  { sym: '▤', name: '记忆' },
  { sym: '◆', name: '构建' },
  { sym: '🛡', name: '安全' },
  { sym: '👁', name: '视觉' },
  { sym: '⛭', name: '连接' },
  { sym: '☆', name: '工具' },
];

// 空查询时按分类分组（每组前 N 条）
export function groupCommands(list: string[], perGroup = 6): Array<{ sym: string; name: string; cmds: string[] }> {
  return CAT_GROUPS.map(g => ({
    ...g,
    cmds: list.filter(c => COMMAND_CAT[c] === g.sym).slice(0, perGroup),
  })).filter(g => g.cmds.length > 0);
}

export function CommandPanel({ onPick }: { onPick: (cmd: string) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const t = getTheme();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const totalW = Math.max(width - 2, 40);
  const title = ' 命令面板 ';
  const topBorder = `╭${title}${'─'.repeat(Math.max(totalW - title.length - 1, 2))}╮`;
  const bottomBorder = `╰${'─'.repeat(totalW - 1)}╯`;

  const hits = filterCommands(q, SLASH);
  const groups = q ? [] : groupCommands(hits);
  const flat = q ? hits : groups.flatMap(g => g.cmds);

  useInput((input, key) => {
    if (key.escape) { patchOverlay({ panel: false }); return; }
    if (key.return) { if (flat[sel]) onPick(flat[sel]); patchOverlay({ panel: false }); return; }
    if (key.upArrow) { setSel(s => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSel(s => Math.min(flat.length - 1, s + 1)); return; }
    if (key.backspace) { setQ(qq => qq.slice(0, -1)); setSel(0); return; }
    if (key.ctrl && input.toLowerCase() === 'g') { patchOverlay({ panel: false }); return; }
    if (input && !key.ctrl) { setQ(qq => qq + input); setSel(0); }
  });

  let flatIdx = 0;
  return (
    <Box flexDirection="column">
      <Box width={totalW} flexDirection="column">
        <Text color={t.accent}>{topBorder}</Text>
        <Text wrap="truncate-end">
          <Text color={t.text}>{'  '}</Text>
          <Text color={t.accent}>{q ? '/ ' + q : '搜索'}</Text>
          <Text color={t.muted}>{q ? '' : '（输入字符模糊匹配）'}</Text>
          <Text color={t.muted}>{'  ↑↓ 选择 · Enter 执行 · Esc 关闭'}</Text>
        </Text>
        <Text color={t.muted}>{'│'}</Text>
        {q ? (
          flat.map((c, i) => (
            <Text key={c} wrap="truncate-end">
              <Text color={i === sel ? t.accent : t.muted}>{i === sel ? '› ' : '  '}{COMMAND_CAT[c] ?? '·'} {c}</Text>
              <Text color={t.muted}>{'  '}{COMMAND_DESC[c]?.slice(0, 44) ?? ''}</Text>
            </Text>
          ))
        ) : (
          groups.map(g => (
            <Box key={g.sym + g.name} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={t.muted}>{'  '}{g.sym} {g.name}</Text>
              </Text>
              {g.cmds.map(c => {
                const isSel = flatIdx === sel;
                flatIdx++;
                return (
                  <Text key={c} wrap="truncate-end">
                    <Text color={isSel ? t.accent : t.muted}>{isSel ? '› ' : '  '}{c}</Text>
                    <Text color={t.muted}>{'  '}{COMMAND_DESC[c]?.slice(0, 44) ?? ''}</Text>
                  </Text>
                );
              })}
            </Box>
          ))
        )}
        {flat.length === 0 && <Text color={t.muted}>{'  无匹配命令'}</Text>}
        <Text color={t.border}>{bottomBorder}</Text>
      </Box>
    </Box>
  );
}
