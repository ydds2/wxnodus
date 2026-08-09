// src/ui/entry.tsx — 入口组件（全屏 TUI：Header + 启动页/消息流 + Composer + StatusBar）
// 架构（参考 Kimi CLI / Claude Code / Codex 全屏布局）：
//   alternateScreen 全屏模式；消息区应用内滚动——scrollTail 按偏移行计算
//   可见消息（零测量循环）；PgUp/PgDn/Ctrl+U/Ctrl+D/End 滚动；
//   Composer 输入行数经 onLinesChange 上报以精确预算消息区高度。
import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { MessageLine } from './components/MessageLine.js';
import { StreamingMarkdown } from './components/StreamingMarkdown.js';
import { Composer } from './components/Composer.js';
import { StatusBar } from './components/StatusBar.js';
import { StartupCard } from './components/StartupCard.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { useTurn } from '../app/stores/turnStore.js';
import { useOverlay, patchOverlay } from '../app/stores/overlayStore.js';
import { getUi } from '../app/stores/uiStore.js';
import { getTheme } from './theme.js';
import { scrollTail } from './lib/lines.js';
import { ModelPicker } from './components/ModelPicker.js';
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
}

const STARTUP_LINES = 15; // 启动页固定行数（含边框），与 StartupCard 保持一致

// 顶部品牌栏（Kimi 风格：单行深底、状态点 + 品牌 + 模式徽章 + 模型 + 思考状态）
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

// 消息流：scrollTail 按滚动偏移裁剪 + 流式区（工具行/流式文本）+ 滚动状态提示
function MessageStream({ history, streaming, tools, areaLines, width, offset }: {
  history: UiMsg[]; streaming: string;
  tools: Array<{ name: string; ctx: string; done?: boolean; ok?: boolean }>;
  areaLines: number; width: number; offset: number;
}) {
  const t = getTheme();
  const streamLines = tools.length + (streaming ? Math.ceil(streaming.length / Math.max(width - 2, 10)) : 0);
  const { visible, atBottom, overflow } = scrollTail(history, offset, areaLines, width - 2, streamLines);
  return (
    <Box flexDirection="column" flexGrow={1}>
      {!atBottom && (
        <Text color={t.muted}>↑ 已上滑 · PgUp/PgDn 或 Ctrl+U/D 滚动 · End 回底部</Text>
      )}
      {atBottom && overflow > 0 && (
        <Text color={t.muted}>…… ↑ PgUp 上滑查看更早消息</Text>
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

export function App({ bridge, version, model, cwd, runCommand, onQuit, setModel, onThinkingChange }: AppDeps) {
  const [history, setHistory] = useState<UiMsg[]>([]);
  const [startup, setStartup] = useState(true);
  const [inputLines, setInputLines] = useState(1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const turn = useTurn(s => s.s);
  const overlay = useOverlay(s => s.s);
  const u = getUi();
  const t = getTheme();
  const { stdout } = useStdout();
  const rows = stdout.rows || 24;
  const width = stdout.columns || 80;

  // 区域高度预算：header + 启动页(或 0) + 消息区 + 输入框(行+边框) + 提示行 + 状态条
  const composerLines = inputLines + 2;
  const fixed = 1 + (startup ? STARTUP_LINES : 0) + composerLines + 1 + 1 + 1;
  const areaLines = Math.max(rows - fixed, 3);
  // 启动页垂直居中：剩余空白上下均分（ink justifyContent 在 flexGrow 组合下不稳，手动算 margin）
  const padTop = startup ? Math.max(1, Math.floor((rows - 1 - STARTUP_LINES - composerLines - 2) / 2)) : 0;
  const streamLines = turn.tools.length + (turn.streaming ? Math.ceil(turn.streaming.length / Math.max(width - 2, 10)) : 0);
  const { maxOffset } = scrollTail(history, scrollOffset, areaLines, width - 2, streamLines);

  // 滚动键：PgUp/PgDn 半屏 · Ctrl+U/D 半屏 · End 回底部 · Home 顶部（选择器打开时不生效）
  useInput((_inp, key) => {
    if (overlay.modelPicker || startup) return;
    const step = Math.max(3, Math.floor(areaLines / 2));
    if (key.pageUp) setScrollOffset(o => Math.min(o + step, maxOffset));
    if (key.pageDown) setScrollOffset(o => Math.max(0, o - step));
    if (key.ctrl && _inp === 'u') setScrollOffset(o => Math.min(o + step, maxOffset));
    if (key.ctrl && _inp === 'd') setScrollOffset(o => Math.max(0, o - step));
    if (key.end) setScrollOffset(0);
    if (key.home) setScrollOffset(maxOffset);
  }, { isActive: !overlay.modelPicker });

  // 新消息/回合变化时自动回底部（offset=0 最新在底）
  React.useEffect(() => {
    setScrollOffset(0);
  }, [history.length, turn.streamSegments.length]);

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
      <Header version={version} model={model} busy={turn.busy} mode={u.mode} thinking={u.thinking} />
      {startup ? (
        <Box marginTop={padTop}>
          <StartupCard model={model} version={version} cwd={cwd} />
        </Box>
      ) : (
        <MessageStream
          history={history}
          streaming={turn.streaming}
          tools={turn.tools}
          areaLines={areaLines}
          width={width}
          offset={scrollOffset}
        />
      )}
      {overlay.approval && <ApprovalPrompt onRespond={choice => bridge.emit('ui.approval', { choice })} />}
      {overlay.modelPicker && (
        <ModelPicker
          currentModel={model}
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
        <Composer onSubmit={onSubmit} onQuit={onQuit} onLinesChange={setInputLines} />
        <Text color={t.muted}>Enter 发送 · Shift+Enter 换行 · ↑↓ 历史/建议 · / 命令建议 · PgUp 上滑 · Ctrl+C 中断 · Ctrl+G 退出</Text>
      </Box>
      <StatusBar version={version} />
    </Box>
  );
}
