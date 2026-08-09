// src/ui/components/StreamingMarkdown.tsx — L6-2 流式 Markdown（尾部缓冲稳定前缀复用）
import React, { useMemo } from 'react';
import { splitStablePrefix } from '../markdown/streaming.js';
import { Markdown } from './Markdown.js';

export function StreamingMarkdown({ text }: { text: string }) {
  const { stable, unstable } = useMemo(() => splitStablePrefix(text), [text]);
  if (!text.trim()) return null;
  return (
    <>
      <Markdown text={stable} />
      <Markdown text={unstable} />
    </>
  );
}
