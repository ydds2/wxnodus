// src/ui/entry.tsx — L6-2 入口组件（消息流 + 输入 + 弹层 + 状态条组装）
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { MessageLine } from './components/MessageLine.js';
import { Markdown } from './components/Markdown.js';
import { StreamingMarkdown } from './components/StreamingMarkdown.js';
import { Composer } from './components/Composer.js';
import { StatusBar } from './components/StatusBar.js';
import { StartupCard } from './components/StartupCard.js';
import { CommandPanel } from './components/CommandPanel.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { useTurn } from '../app/stores/turnStore.js';
import { useOverlay, patchOverlay } from '../app/stores/overlayStore.js';
import type { UiMsg } from '../app/stores/types.js';
import type { Bridge } from '../app/Bridge.js';
import { getTheme } from './theme.js';

export interface AppDeps {
  bridge: Bridge;
  version: string;
  model: string;
  cwd: string;
  runCommand: (input: string) => Promise<void>;
}

// 消息流（已提交历史 + 实时区：流式文本/工具/段）
function MessageStream({ history, streaming, tools }: { history: UiMsg[]; streaming: string; tools: Array<{ name: string; ctx: string; done?: boolean; ok?: boolean }> }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {history.map(m => <MessageLine key={m.id} m={m} />)}
      {tools.map(t => (
        <Box key={t.name + t.ctx} flexDirection="row">
          <Text color="#f59e0b">● {t.name}{t.ctx ? `("${t.ctx}")` : ''} {t.done ? (t.ok ? '✓' : '✗') : '…'}</Text>
        </Box>
      ))}
      {streaming && <StreamingMarkdown text={streaming} />}
    </Box>
  );
}

export function App({ bridge, version, model, cwd, runCommand }: AppDeps) {
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

  // 回合结束时归档段进历史
  React.useEffect(() => {
    if (turn.streamSegments.length) {
      setHistory(h => [...h, ...turn.streamSegments]);
      // 清空已归档段（由 TurnController recordMessageComplete 已清空 streamSegments）
    }
  }, [turn.streamSegments]);

  return (
    <Box flexDirection="column" height="100%">
      {startup && <StartupCard model={model} version={version} cwd={cwd} />}
      <MessageStream history={history} streaming={turn.streaming} tools={turn.tools} />
      {overlay.approval && <ApprovalPrompt onRespond={choice => bridge.emit('ui.approval', { choice })} />}
      {overlay.panel && <CommandPanel onPick={async cmd => { await runCommand(cmd); }} />}
      <Composer onSubmit={onSubmit} />
      <StatusBar />
    </Box>
  );
}
