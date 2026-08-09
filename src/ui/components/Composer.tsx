// src/ui/components/Composer.tsx — 自研输入框（零测量循环 + 内联命令建议）
// 设计（参考 Claude Code / DeepSeek CLI）：
//   - 标题栏边框嵌模式徽章，❯ 前缀，多行渲染，光标闪烁
//   - 输入 / 开头时在输入框上方内联显示命令建议（非模式切换——输入框始终活跃，
//     可继续输入过滤、Backspace 删除 / 即返回普通输入、↑↓ 选择、Enter 执行、
//     Tab 补全、Esc 清空）
//   - 键位全部走 handleComposerKey 纯函数（组件级 useInput 接管，终端无关）
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { getUi } from '../../app/stores/uiStore.js';
import { getTheme } from '../theme.js';
import { initComposer, handleComposerKey } from '../lib/composerKeys.js';
import { filterCommands, isSuggesting } from '../lib/suggest.js';
import { SLASH, COMMAND_DESC } from '../../commands/registry.js';
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
  const { stdout } = useStdout();
  const width = stdout.columns || 80;
  const borderColor = MODE_COLOR[u.mode] ?? t.border;

  // 内联命令建议（/ 开头且未带空格参数时）
  const suggest = isSuggesting(st.value) ? filterCommands(st.value, SLASH) : [];
  const totalW = Math.max(width - 4, 10) + 3;

  // 光标闪烁（仅本组件 state，重渲染只影响输入行）
  useEffect(() => {
    const iv = setInterval(() => setCursorOn(c => !c), 530);
    return () => clearInterval(iv);
  }, []);

  // 输入行数上报（消息区高度预算用；纯计算，无测量）
  useEffect(() => {
    onLinesChange?.(Math.max(1, st.value.split('\n').length));
  }, [st.value, onLinesChange]);

  // 键位处理：Enter 提交/执行建议 · Shift+Enter 换行 · ↑↓ 建议或历史 · Tab 补全 ·
  // Esc 清空 · ←→ 移动 · 删除；Ctrl+G 退出（Ctrl+C 由 CLI 层 SIGINT 接管）
  useInput((inp, key) => {
    if (key.ctrl && (inp === '\x07' || inp.toLowerCase() === 'g')) {
      onQuit?.();
      return;
    }
    const { next, action } = handleComposerKey(st, { ...key, input: inp }, suggest);
    if (action.type === 'submit') onSubmit(action.text);
    if (next !== st) setSt(next);
  });

  const lines = st.value.split('\n');
  const { line: curLine, col: curCol } = cursorLineCol(st.value, st.cursor);
  const innerW = Math.max(width - 4, 10); // 内容区宽

  // 顶部边框：╭─ 徽章 ───────╮ / 底部边框：╰────────╯（总长对齐 totalW）
  const title = u.busy ? 'working' : u.mode;
  const topBorder = `╭─ ${title} ${'─'.repeat(Math.max(totalW - 4 - title.length, 2))}╮`;
  const bottomBorder = `╰${'─'.repeat(totalW - 2)}╯`;

  return (
    <Box flexDirection="column">
      {suggest.length > 0 && (
        <Box width={totalW} flexDirection="column">
          {suggest.map((c, i) => (
            <Text key={c} wrap="truncate-end">
              <Text color={i === st.suggestSel ? t.accent : t.muted}>{i === st.suggestSel ? '› ' : '  '}</Text>
              <Text color={i === st.suggestSel ? t.accent : t.text}>{c}</Text>
              <Text color={t.muted}>{'  '}{COMMAND_DESC[c]?.slice(0, 44) ?? ''}</Text>
            </Text>
          ))}
          <Text color={t.muted}>{'↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 取消'}</Text>
        </Box>
      )}
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
