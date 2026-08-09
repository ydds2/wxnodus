// src/ui/entry.tsx — 入口组件（品牌首屏 + 消息流 + 输入 + 弹层 + 状态条组装）
// 架构（参考 Hermes appLayout）：主屏幕滚动模式（非 alternateScreen），
// <Static> 把历史消息提交到终端滚动缓冲（自然滚动、防 OOM），
// 实时区（流式文本/工具行）紧跟其后，底部 Composer + StatusBar 固定。
// 零测量循环：不使用 ink-scroll-view / react-ink-textarea，杜绝渲染抖动。
import React, { useState } from 'react';
import { Box, Text, Static } from 'ink';
import { MessageLine } from './components/MessageLine.js';
import { StreamingMarkdown } from './components/StreamingMarkdown.js';
import { Composer } from './components/Composer.js';
import { StatusBar } from './components/StatusBar.js';
import { StartupCard } from './components/StartupCard.js';
import { CommandPanel } from './components/CommandPanel.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { useTurn } from '../app/stores/turnStore.js';
import { useOverlay } from '../app/stores/overlayStore.js';
import type { UiMsg } from '../app/stores/types.js';
import type { Bridge } from '../app/Bridge.js';
import { getTheme } from './theme.js';

export interface AppDeps {
  bridge: Bridge;
  version: string;
  model: string;
  cwd: string;
  runCommand: (input: string) => Promise<void>;
  onQuit?: () => void;
}

// 消息流：历史经 <Static> 一次性提交（终端滚动缓冲）；实时区 = 工具行 + 流式文本
function MessageStream({ history, streaming, tools }: { history: UiMsg[]; streaming: string; tools: Array<{ name: string; ctx: string; done?: boolean; ok?: boolean }> }) {
  return (
    <>
      <Static items={history}>{m => <MessageLine key={m.id} m={m} />}</Static>
      {tools.map(t => (
        <Box key={t.name + t.ctx} flexDirection="row" marginLeft={1}>
          <Text color={t.done ? (t.ok ? '#10b981' : '#f7768e') : '#f59e0b'}>
            {t.done ? (t.ok ? '✓ ' : '✗ ') : '⚡ '}{t.name}{t.ctx ? `("${t.ctx}")` : ''}{t.done ? '' : ' …'}
          </Text>
        </Box>
      ))}
      {streaming ? <StreamingMarkdown text={streaming} /> : null}
    </>
  );
}

export function App({ bridge, version, model, cwd, runCommand, onQuit }: AppDeps) {
  const [history, setHistory] = useState<UiMsg[]>([]);
  const [startup, setStartup] = useState(true);
  const turn = useTurn(s => s.s);
  const overlay = useOverlay(s => s.s);
  const t = getTheme();

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
    <Box flexDirection="column">
      {startup && <StartupCard model={model} version={version} cwd={cwd} />}
      {!startup && <Box marginTop={1}><Text color={t.muted}>{'─'.repeat(24)}</Text></Box>}
      <MessageStream history={history} streaming={turn.streaming} tools={turn.tools} />
      {overlay.approval && <ApprovalPrompt onRespond={choice => bridge.emit('ui.approval', { choice })} />}
      {overlay.panel && <CommandPanel onPick={async cmd => { await runCommand(cmd); }} />}
      <Box marginTop={1}>
        <Composer onSubmit={onSubmit} onQuit={onQuit} />
      </Box>
      <StatusBar version={version} />
    </Box>
  );
}
