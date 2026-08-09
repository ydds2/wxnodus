// src/ui/entry.tsx — L6-2 入口组件（消息流 + 输入 + 弹层 + 状态条组装）
import React, { useState } from 'react';
import { Box, Text, Static } from 'ink';
import { ScrollView } from 'ink-scroll-view';
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
}

// 消息流（参考 hermes appLayout：Static 提交历史 + ScrollView 实时区）
// 历史消息经 <Static> 一次性提交（只渲染新增，防 OOM/防清滚动回滚）；
// 实时区（流式文本/工具）在 ScrollView 内滚动
function MessageStream({ history, streaming, tools }: { history: UiMsg[]; streaming: string; tools: Array<{ name: string; ctx: string; done?: boolean; ok?: boolean }> }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={history}>{m => <MessageLine key={m.id} m={m} />}</Static>
      <ScrollView flexGrow={1}>
        {tools.map(t => (
          <Box key={t.name + t.ctx} flexDirection="row">
            <Text color="#f59e0b">● {t.name}{t.ctx ? `("${t.ctx}")` : ''} {t.done ? (t.ok ? '✓' : '✗') : '…'}</Text>
          </Box>
        ))}
        {streaming && <StreamingMarkdown text={streaming} />}
      </ScrollView>
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
      {startup && <StartupCard model={model} version={version} cwd={cwd} />}
      <MessageStream history={history} streaming={turn.streaming} tools={turn.tools} />
      {overlay.approval && <ApprovalPrompt onRespond={choice => bridge.emit('ui.approval', { choice })} />}
      {overlay.panel && <CommandPanel onPick={async cmd => { await runCommand(cmd); }} />}
      <Composer onSubmit={onSubmit} />
      <StatusBar />
    </Box>
  );
}
