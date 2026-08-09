// src/ui/entry.tsx — 入口组件（主屏幕模式：布局稳定 + 消息区应用内滚动）
// 架构（参考 Hermes / 普通终端 CLI）：
//   非 alternateScreen（无固定全屏）；启动横幅由 CLI 层输出到滚动缓冲；
//   消息区用 scrollTail 按终端行数裁剪渲染尾部 N 条（固定高度），
//   应用内滚动回看（PgUp/PgDn/Ctrl+U/D/Home/End/空输入 ↑↓）；
//   不用 <Static>——主屏幕模式下 Static 与 ink diff 冲突导致整树追加重绘
//   （Header/输入框在屏幕重复堆叠、被「强制拉高」）。
import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { MessageLine } from './components/MessageLine.js';
import { StreamingMarkdown } from './components/StreamingMarkdown.js';
import { Composer } from './components/Composer.js';
import { StatusBar } from './components/StatusBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { ConfirmPrompt } from './components/ConfirmPrompt.js';
import { ClarifyPrompt } from './components/ClarifyPrompt.js';
import { SessionsPicker } from './components/SessionsPicker.js';
import { ModelPicker } from './components/ModelPicker.js';
import { useTurn } from '../app/stores/turnStore.js';
import { useOverlay, patchOverlay } from '../app/stores/overlayStore.js';
import { getUi } from '../app/stores/uiStore.js';
import { getTheme } from './theme.js';
import { scrollTail } from './lib/lines.js';
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

// 消息区：scrollTail 裁剪尾部到可视高度 + 滚动状态提示 + 实时区（推理/工具/流式/通知）
function MessageStream({ history, streaming, tools, areaLines, width, offset, reasoning, showThinking, notice }: {
  history: UiMsg[]; streaming: string;
  tools: Array<{ name: string; ctx: string; detail?: string; done?: boolean; ok?: boolean }>;
  areaLines: number; width: number; offset: number;
  reasoning: string; showThinking: boolean; notice: string | null;
}) {
  const t = getTheme();
  const streamLines = tools.length + (streaming ? Math.ceil(streaming.length / Math.max(width - 2, 10)) : 0)
    + (showThinking && reasoning ? 2 + Math.ceil(reasoning.length / Math.max(width - 2, 10)) : 0)
    + (notice ? 1 : 0);
  const { visible, atBottom, maxOffset } = scrollTail(history, offset, areaLines, width - 2, streamLines);
  return (
    <Box flexDirection="column" height={areaLines}>
      {notice && (
        <Text wrap="truncate-end">
          <Text color="#f59e0b" bold>{'◆ '}</Text>
          <Text color={t.text}>{notice}</Text>
        </Text>
      )}
      {!atBottom && (
        <Text color={t.muted}>↑ 位置 {offset}/{maxOffset} 行 · PgUp/PgDn 或 Ctrl+U/D 滚动 · End 回底部</Text>
      )}
      {atBottom && maxOffset > 0 && (
        <Text color={t.muted}>…… ↑ PgUp 上滑查看更早消息（共 {history.length} 条）</Text>
      )}
      {showThinking && reasoning && (
        <Box flexDirection="column" marginLeft={1}>
          <Text color={t.muted} dimColor>{'⤷ 推理中…'}</Text>
          <Text color={t.muted} wrap="wrap">{reasoning.slice(0, 600)}</Text>
        </Box>
      )}
      {visible.map(m => <MessageLine key={m.id} m={m} />)}
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
  // 欢迎消息作为首条历史（替代预输出横幅——预输出会使 ink 进入滚动追加模式，
  // 导致 UI 整树重复堆叠；欢迎消息在消息区内，提交后自然上滚）
  const [history, setHistory] = useState<UiMsg[]>([{
    id: 'welcome', role: 'system', kind: 'intro',
    text: `WxNodus v${version} · 概念编译器 — 说一句话，交付可运行系统（/ 打开命令面板 · /help 全部命令 · Ctrl+G 退出）`,
  }]);
  const [inputLines, setInputLines] = useState(1);
  const [composerEmpty, setComposerEmpty] = useState(true);
  const [scrollOffset, setScrollOffset] = useState(0);
  const turn = useTurn(s => s.s);
  const overlay = useOverlay(s => s.s);
  const u = getUi();
  const t = getTheme();
  const { stdout } = useStdout();
  const rows = stdout.rows || 24;
  const width = stdout.columns || 80;

  // 区域高度预算：header(1) + 消息区 + 输入框(行+边框) + 提示行(1) + 状态条(1)
  const composerLines = inputLines + 2;
  const areaLines = Math.max(rows - 1 - composerLines - 2, 3);
  const streamLines = turn.tools.length + (turn.streaming ? Math.ceil(turn.streaming.length / Math.max(width - 2, 10)) : 0)
    + (u.thinking && turn.reasoning ? 2 + Math.ceil(turn.reasoning.length / Math.max(width - 2, 10)) : 0)
    + (u.notice ? 1 : 0);
  const { maxOffset } = scrollTail(history, scrollOffset, areaLines, width - 2, streamLines);

  // 滚动键：PgUp/PgDn 半屏 · Ctrl+U/D 半屏 · Alt+↑↓ · Home/End · 空输入 ↑↓ 逐行
  useInput((inp, key) => {
    if (overlay.modelPicker || overlay.sessions) return;
    const step = Math.max(3, Math.floor(areaLines / 2));
    if (key.pageUp || (key.meta && key.upArrow)) setScrollOffset(o => Math.min(o + step, maxOffset));
    if (key.pageDown || (key.meta && key.downArrow)) setScrollOffset(o => Math.max(0, o - step));
    if (key.ctrl && inp === 'u') setScrollOffset(o => Math.min(o + step, maxOffset));
    if (key.ctrl && inp === 'd') setScrollOffset(o => Math.max(0, o - step));
    if (composerEmpty && key.upArrow && !key.ctrl) setScrollOffset(o => Math.min(o + 1, maxOffset));
    if (composerEmpty && key.downArrow && !key.ctrl) setScrollOffset(o => Math.max(0, o - 1));
    if (key.end) setScrollOffset(0);
    if (key.home) setScrollOffset(maxOffset);
  }, { isActive: !overlay.modelPicker && !overlay.sessions });

  const onSubmit = async (text: string) => {
    const userMsg: UiMsg = { id: `u${Date.now()}`, role: 'user', text };
    setHistory(h => [...h, userMsg]);
    setScrollOffset(0); // 新消息回底部
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
      setScrollOffset(0);
    }
  }, [turn.streamSegments]);

  return (
    <Box flexDirection="column">
      <Header version={version} model={model} busy={turn.busy} mode={u.mode} thinking={u.thinking} />
      <MessageStream
        history={history}
        streaming={turn.streaming}
        tools={turn.tools}
        areaLines={areaLines}
        width={width}
        offset={scrollOffset}
        reasoning={turn.reasoning}
        showThinking={u.thinking}
        notice={u.notice}
      />
      {overlay.approval && <ApprovalPrompt onRespond={choice => bridge.emit('ui.approval', { choice })} />}
      {overlay.confirm && <ConfirmPrompt onConfirm={ok => bridge.emit('ui.confirm', { ok })} />}
      {overlay.clarify && <ClarifyPrompt onPick={idx => bridge.emit('ui.clarify', { index: idx })} />}
      {overlay.sessions && <SessionsPicker sessions={listSessions()} onPick={async id => {
        setHistory(h => [...h, { id: `u${Date.now()}`, role: 'user', text: `恢复会话：${id}` }]);
        await runCommand(`/resume ${id}`);
      }} />}
      {overlay.modelPicker && (
        <ModelPicker
          currentModel={model || 'deepseek-v4-flash'} // 无 key（规则脑）时默认标记首个模型
          thinking={u.thinking}
          onPick={m => {
            setHistory(h => [...h, { id: `u${Date.now()}`, role: 'user', text: `选择模型：${m.name}` }]);
            setModel(m.modelId, m.baseURL);
            patchOverlay({ modelPicker: false });
          }}
          onCancel={() => patchOverlay({ modelPicker: false })}
          onThinkingChange={onThinkingChange}
        />
      )}
      <Box flexDirection="column">
        <Composer onSubmit={onSubmit} onQuit={onQuit} onLinesChange={setInputLines} onEmptyChange={setComposerEmpty} />
        <Text color={t.muted}>Enter 发送 · Shift+Enter 换行 · ↑↓ 历史/建议 · / 命令建议 · PgUp 上滑 · Ctrl+C 中断 · Ctrl+G 退出</Text>
      </Box>
      <StatusBar version={version} />
    </Box>
  );
}
