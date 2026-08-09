// src/ui/entry.tsx — 入口组件（主屏幕模式：历史自然滚动 + 输入框固定底部）
// 架构（参考 Hermes / 普通终端 CLI）：非 alternateScreen——
//   <Static> 把已提交历史输出到终端滚动缓冲（滚轮/PgUp 由终端处理，自然上滚），
//   实时区（推理/工具/流式文本）与输入框、状态条固定在底部；
//   启动卡片居中展示后随第一条消息自然滚出。
import React, { useState } from 'react';
import { Box, Text, Static, useStdout } from 'ink';
import { MessageLine } from './components/MessageLine.js';
import { StreamingMarkdown } from './components/StreamingMarkdown.js';
import { Composer } from './components/Composer.js';
import { StatusBar } from './components/StatusBar.js';
import { StartupCard } from './components/StartupCard.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { ConfirmPrompt } from './components/ConfirmPrompt.js';
import { ClarifyPrompt } from './components/ClarifyPrompt.js';
import { SessionsPicker } from './components/SessionsPicker.js';
import { ModelPicker } from './components/ModelPicker.js';
import { useTurn } from '../app/stores/turnStore.js';
import { useOverlay, patchOverlay } from '../app/stores/overlayStore.js';
import { getUi } from '../app/stores/uiStore.js';
import { getTheme } from './theme.js';
import type { SessionRow } from './components/SessionsPicker.js';
import type { UiMsg } from '../app/stores/types.js';
import type { Bridge } from '../app/Bridge.js';

export interface AppDeps {
  bridge: Bridge;
  version: string;
  model: string;
  cwd: string;
  runCommand: (input: string) => Promise<void>;
  onQuit?: () => void;
  setModel: (modelId: string, baseURL?: string) => void;
  onThinkingChange: (on: boolean) => void;
  listSessions: () => SessionRow[];
}

// 顶部品牌栏（单行深底：状态点 + 品牌 + 模式徽章 + 模型 + 思考状态）
function Header({ version, model, busy, mode, thinking }: { version: string; model: string; busy: boolean; mode: string; thinking: boolean }) {
  const t = getTheme();
  return (
    <Text backgroundColor={t.statusBg}>
      <Text color={busy ? '#f59e0b' : t.ok} backgroundColor={t.statusBg}>{busy ? '⚡' : '●'} </Text>
      <Text bold color={t.text} backgroundColor={t.statusBg}>WxNodus v{version}</Text>
      <Text color={t.muted} backgroundColor={t.statusBg}> · 概念编译器</Text>
      <Text color={t.muted} backgroundColor={t.statusBg}> │ </Text>
      <Text color={t.ok} backgroundColor={t.statusBg}>{mode}</Text>
      <Text color={t.muted} backgroundColor={t.statusBg}> │ </Text>
      <Text color={t.text} backgroundColor={t.statusBg}>{model || '规则脑'}</Text>
      <Text color={t.muted} backgroundColor={t.statusBg}> · </Text>
      <Text color={thinking ? t.text : t.muted} backgroundColor={t.statusBg}>{thinking ? 'thinking' : '–'}</Text>
    </Text>
  );
}

// 实时区（不占滚动缓冲）：通知横幅 + 推理 + 工具行 + 流式文本
function LiveArea({ streaming, tools, reasoning, showThinking, notice }: {
  streaming: string;
  tools: Array<{ name: string; ctx: string; detail?: string; done?: boolean; ok?: boolean }>;
  reasoning: string; showThinking: boolean; notice: string | null;
}) {
  const t = getTheme();
  return (
    <Box flexDirection="column">
      {notice && (
        <Text wrap="truncate-end">
          <Text color="#f59e0b" bold>{'◆ '}</Text>
          <Text color={t.text}>{notice}</Text>
        </Text>
      )}
      {showThinking && reasoning && (
        <Box flexDirection="column" marginLeft={1}>
          <Text color={t.muted} dimColor>{'⤷ 推理中…'}</Text>
          <Text color={t.muted} wrap="wrap">{reasoning.slice(0, 600)}</Text>
        </Box>
      )}
      {tools.map(tl => (
        <Box key={tl.name + tl.ctx} flexDirection="row" marginLeft={1}>
          <Text color={tl.done ? (tl.ok ? t.ok : t.error) : '#f59e0b'}>
            {tl.done ? (tl.ok ? '✓ ' : '✗ ') : '⚡ '}{tl.name}{tl.ctx ? `("${tl.ctx}")` : ''}{tl.done ? '' : ' …'}
            {tl.detail ? ` ${tl.detail.slice(0, 40)}` : ''}
          </Text>
        </Box>
      ))}
      {streaming ? <StreamingMarkdown text={streaming} /> : null}
    </Box>
  );
}

export function App({ bridge, version, model, cwd, runCommand, onQuit, setModel, onThinkingChange, listSessions }: AppDeps) {
  const [history, setHistory] = useState<UiMsg[]>([]);
  const [startup, setStartup] = useState(true);
  const turn = useTurn(s => s.s);
  const overlay = useOverlay(s => s.s);
  const u = getUi();
  const t = getTheme();
  const { stdout } = useStdout();
  const rows = stdout.rows || 24;
  // 小窗口容错：高度不足时隐藏启动卡片
  const showStartupCard = startup && rows >= 26;
  const padTop = showStartupCard ? Math.max(1, Math.floor((rows - 1 - 15 - 3 - 2) / 2)) : 0;

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
      <Header version={version} model={model} busy={turn.busy} mode={u.mode} thinking={u.thinking} />
      {showStartupCard ? (
        <Box marginTop={padTop}>
          <StartupCard model={model} version={version} cwd={cwd} />
        </Box>
      ) : null}
      {/* 历史消息经 Static 提交到终端滚动缓冲（自然上滚，不锁死） */}
      <Static items={history}>{m => <MessageLine key={m.id} m={m} />}</Static>
      <LiveArea
        streaming={turn.streaming}
        tools={turn.tools}
        reasoning={turn.reasoning}
        showThinking={u.thinking}
        notice={u.notice}
      />
      {overlay.approval && <ApprovalPrompt onRespond={choice => bridge.emit('ui.approval', { choice })} />}
      {overlay.confirm && <ConfirmPrompt onConfirm={ok => bridge.emit('ui.confirm', { ok })} />}
      {overlay.clarify && <ClarifyPrompt onPick={idx => bridge.emit('ui.clarify', { index: idx })} />}
      {overlay.sessions && <SessionsPicker sessions={listSessions()} onPick={async id => {
        setStartup(false);
        setHistory(h => [...h, { id: `u${Date.now()}`, role: 'user', text: `恢复会话：${id}` }]);
        await runCommand(`/resume ${id}`);
      }} />}
      {overlay.modelPicker && (
        <ModelPicker
          currentModel={model || 'deepseek-v4-flash'} // 无 key（规则脑）时默认标记首个模型
          thinking={u.thinking}
          onPick={m => {
            setStartup(false);
            setHistory(h => [...h, { id: `u${Date.now()}`, role: 'user', text: `选择模型：${m.name}` }]);
            setModel(m.modelId, m.baseURL);
            patchOverlay({ modelPicker: false });
          }}
          onCancel={() => patchOverlay({ modelPicker: false })}
          onThinkingChange={onThinkingChange}
        />
      )}
      <Box flexDirection="column">
        <Composer onSubmit={onSubmit} onQuit={onQuit} />
        <Text color={t.muted}>Enter 发送 · Shift+Enter 换行 · ↑↓ 历史/建议 · / 命令建议 · Ctrl+C 中断 · Ctrl+G 退出</Text>
      </Box>
      <StatusBar version={version} />
    </Box>
  );
}
