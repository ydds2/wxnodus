// src/ui/entry.tsx — 入口组件（全屏 TUI：Header + 启动页/消息流 + Composer + StatusBar）
// 架构（参考 Kimi CLI / Claude Code / Codex 全屏布局）：
//   alternateScreen 全屏模式；消息区自制滚动——用 estimateLines 估算每条消息
//   占用的终端行数，从尾部裁剪到可视区（零测量循环，杜绝渲染抖动）；
//   Composer 输入行数经 onLinesChange 上报以精确预算消息区高度。
import React, { useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { MessageLine } from './components/MessageLine.js';
import { StreamingMarkdown } from './components/StreamingMarkdown.js';
import { Composer } from './components/Composer.js';
import { StatusBar } from './components/StatusBar.js';
import { StartupCard } from './components/StartupCard.js';
import { CommandPanel } from './components/CommandPanel.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { useTurn } from '../app/stores/turnStore.js';
import { useOverlay } from '../app/stores/overlayStore.js';
import { getTheme } from './theme.js';
import { trimTail, estimateLines } from './lib/lines.js';
import type { UiMsg } from '../app/stores/types.js';
import type { Bridge } from '../app/Bridge.js';

export interface AppDeps {
  bridge: Bridge;
  version: string;
  model: string;
  cwd: string;
  runCommand: (input: string) => Promise<void>;
  onQuit?: () => void;
}

const STARTUP_LINES = 15; // 启动页固定行数（含边框），与 StartupCard 保持一致

// 顶部品牌栏（Kimi 风格：单行深底、状态点 + 品牌 + 模型 + 模式）
function Header({ version, model, busy }: { version: string; model: string; busy: boolean }) {
  const t = getTheme();
  return (
    <Text backgroundColor={t.statusBg}>
      <Text color={busy ? '#f59e0b' : t.ok} backgroundColor={t.statusBg}>{busy ? '⚡' : '●'} </Text>
      <Text bold color={t.text} backgroundColor={t.statusBg}>WxNodus v{version}</Text>
      <Text color={t.muted} backgroundColor={t.statusBg}> · 概念编译器</Text>
      <Text color={t.muted} backgroundColor={t.statusBg}> │ </Text>
      <Text color={t.text} backgroundColor={t.statusBg}>{model || '规则脑'}</Text>
    </Text>
  );
}

// 消息流：历史经 trimTail 裁剪到可视区（自制滚动）+ 流式区（工具行/流式文本）
function MessageStream({ history, streaming, tools, areaLines, width }: {
  history: UiMsg[]; streaming: string;
  tools: Array<{ name: string; ctx: string; done?: boolean; ok?: boolean }>;
  areaLines: number; width: number;
}) {
  const t = getTheme();
  const streamLines = tools.length + (streaming ? estimateLines(streaming, width - 2) : 0);
  const { items: visible, overflow } = trimTail(history, areaLines, width - 2, streamLines);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {overflow > 0 && (
        <Text color={t.muted}>…… ↑ 更早消息已滚动出可视区（↑ {overflow} 条）</Text>
      )}
      {visible.map(m => <MessageLine key={m.id} m={m} />)}
      {tools.map(tl => (
        <Box key={tl.name + tl.ctx} flexDirection="row" marginLeft={1}>
          <Text color={tl.done ? (tl.ok ? t.ok : t.error) : '#f59e0b'}>
            {tl.done ? (tl.ok ? '✓ ' : '✗ ') : '⚡ '}{tl.name}{tl.ctx ? `("${tl.ctx}")` : ''}{tl.done ? '' : ' …'}
          </Text>
        </Box>
      ))}
      {streaming ? <StreamingMarkdown text={streaming} /> : null}
    </Box>
  );
}

export function App({ bridge, version, model, cwd, runCommand, onQuit }: AppDeps) {
  const [history, setHistory] = useState<UiMsg[]>([]);
  const [startup, setStartup] = useState(true);
  const [inputLines, setInputLines] = useState(1);
  const turn = useTurn(s => s.s);
  const overlay = useOverlay(s => s.s);
  const t = getTheme();
  const { stdout } = useStdout();
  const rows = stdout.rows || 24;
  const width = stdout.columns || 80;

  // 区域高度预算：header + 启动页(或 0) + 消息区 + 输入框(行+边框) + 提示行 + 状态条
  const composerLines = inputLines + 2;
  const fixed = 1 + (startup ? STARTUP_LINES : 0) + composerLines + 1 + 1 + 1;
  const areaLines = Math.max(rows - fixed, 3);

  const onSubmit = async (text: string) => {
    setStartup(false);
    const userMsg: UiMsg = { id: `u${Date.now()}`, role: 'user', text };
    setHistory(h => [...h, userMsg]);
    if (text.trim().startsWith('/')) {
      const sysMsg: UiMsg = { id: `c${Date.now()}`, role: 'system', kind: 'slash', text: `> ${text.trim()}` };
      setHistory(h => [...h, sysMsg]);
      await runCommand(text.trim());
      return;
    }
    await bridge.submit(text);
  };

  // 回合段归档：按 id 去重（防重复归档/时序丢失）
  const archivedIds = React.useRef(new Set<string>());
  React.useEffect(() => {
    const fresh = turn.streamSegments.filter(m => !archivedIds.current.has(m.id));
    if (fresh.length) {
      archivedIds.current = new Set([...archivedIds.current, ...fresh.map(m => m.id)]);
      setHistory(h => [...h, ...fresh]);
    }
  }, [turn.streamSegments]);

  return (
    <Box flexDirection="column" height="100%">
      <Header version={version} model={model} busy={turn.busy} />
      {startup && <StartupCard model={model} version={version} cwd={cwd} />}
      {!startup && (
        <MessageStream
          history={history}
          streaming={turn.streaming}
          tools={turn.tools}
          areaLines={areaLines}
          width={width}
        />
      )}
      {overlay.approval && <ApprovalPrompt onRespond={choice => bridge.emit('ui.approval', { choice })} />}
      {overlay.panel && <CommandPanel onPick={async cmd => { await runCommand(cmd); }} />}
      <Box flexDirection="column">
        <Composer onSubmit={onSubmit} onQuit={onQuit} onLinesChange={setInputLines} />
        <Text color={t.muted}>Enter 发送 · Shift+Enter 换行 · ↑↓ 历史 · / 面板 · Ctrl+C 中断 · Ctrl+G 退出</Text>
      </Box>
      <StatusBar version={version} />
    </Box>
  );
}
