// src/ui/components/Composer.tsx — 自研输入框（零测量循环）
// 设计（参考 Kimi CLI 标题栏输入框）：顶部边框嵌入模式徽章，❯ 前缀，多行渲染；
// 键位全部走 handleComposerKey 纯函数（组件级 useInput 接管，终端无关）；
// 光标闪烁仅切换 boolean state——不做任何 measureElement，从根上避免渲染抖动。
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getUi } from '../../app/stores/uiStore.js';
import { useOverlay, patchOverlay } from '../../app/stores/overlayStore.js';
import { getTheme } from '../theme.js';
import { initComposer, handleComposerKey } from '../lib/composerKeys.js';
import type { ComposerState } from '../lib/composerKeys.js';

const MODE_COLOR: Record<string, string> = {
  smart: '#10b981', auto: '#10b981', manual: '#f59e0b', plan: '#a78bfa', yolo: '#f7768e',
};

// 把光标位置映射到「行 + 列」（value 以 \n 分行）
function cursorLineCol(value: string, cursor: number): { line: number; col: number } {
  const lines = value.slice(0, cursor).split('\n');
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
}

export function Composer({ onSubmit, onQuit, onLinesChange }: { onSubmit: (t: string) => void; onQuit?: () => void; onLinesChange?: (n: number) => void }) {
  const [st, setSt] = useState<ComposerState>(() => initComposer());
  const [cursorOn, setCursorOn] = useState(true);
  const u = getUi();
  const t = getTheme();
  const overlay = useOverlay(s => s.s);
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const borderColor = MODE_COLOR[u.mode] ?? t.border;

  // 光标闪烁（仅本组件 state，重渲染只影响输入行）
  useEffect(() => {
    const iv = setInterval(() => setCursorOn(c => !c), 530);
    return () => clearInterval(iv);
  }, []);

  // 输入行数上报（消息区高度预算用；纯计算，无测量）
  useEffect(() => {
    onLinesChange?.(Math.max(1, st.value.split('\n').length));
  }, [st.value, onLinesChange]);

  // 键位处理：Enter 提交 / Shift+Enter·Ctrl+J 换行 / ↑↓ 历史 / ←→ 移动 / 删除（纯函数）
  // 输入框为空时按 / 直接打开命令面板（Claude Code 风格）；Ctrl+G 退出
  // （Ctrl+C 由 CLI 层 SIGINT 接管）；面板打开时本组件不接收按键
  useInput((inp, key) => {
    if (key.ctrl && (inp === '\x07' || inp.toLowerCase() === 'g')) {
      onQuit?.();
      return;
    }
    if (inp === '/' && !st.value) {
      patchOverlay({ panel: true });
      return;
    }
    const { next, action } = handleComposerKey(st, { ...key, input: inp });
    if (action.type === 'submit') onSubmit(action.text);
    if (next !== st) setSt(next);
  }, { isActive: !overlay.panel });

  const lines = st.value.split('\n');
  const { line: curLine, col: curCol } = cursorLineCol(st.value, st.cursor);
  const innerW = Math.max(width - 4, 10); // 内容区宽
  const totalW = innerW + 3;              // 整框宽（含边框）

  // 顶部边框：╭─ 徽章 ───────╮ / 底部边框：╰────────╯（总长对齐 totalW）
  const title = u.busy ? 'working' : u.mode;
  const topBorder = `╭─ ${title} ${'─'.repeat(Math.max(totalW - 4 - title.length, 2))}╮`;
  const bottomBorder = `╰${'─'.repeat(totalW - 2)}╯`;

  return (
    <Box flexDirection="column">
      <Box width={totalW} flexDirection="column">
        <Text color={borderColor}>{topBorder}</Text>
        {lines.map((ln, i) => {
          const atCur = i === curLine;
          const isEnd = atCur && curCol >= ln.length;
          const prefix = i === 0 ? '│ ❯ ' : '│   ';
          const before = ln.slice(0, atCur ? curCol : ln.length);
          const c = atCur && !isEnd ? ln[curCol] ?? '' : '';
          const after = atCur && !isEnd ? ln.slice(curCol + 1) : '';
          const pad = Math.max(totalW - prefix.length - ln.length - 1, 0);
          return (
            <Text key={i} wrap="truncate-end">
              {prefix}
              <Text color={t.text}>{before}</Text>
              {atCur && (cursorOn
                ? <Text inverse>{isEnd ? ' ' : c}</Text>
                : <Text>{isEnd ? ' ' : c}</Text>)}
              <Text color={t.text}>{after}</Text>
              {atCur && isEnd && <Text>{' '.repeat(pad)}</Text>}
              {!atCur && <Text>{' '.repeat(pad)}</Text>}
              <Text color={borderColor}>│</Text>
            </Text>
          );
        })}
        <Text color={borderColor}>{bottomBorder}</Text>
      </Box>
    </Box>
  );
}
