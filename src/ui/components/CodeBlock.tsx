// src/ui/components/CodeBlock.tsx — L6-2 代码块（shiki 同步高亮；失败兜底纯文本）
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getTheme } from '../theme.js';

let highlighter: any = null;
async function getHighlighter() {
  if (highlighter) return highlighter;
  try {
    const { createHighlighterCore } = await import('shiki/core');
    const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript');
    highlighter = await createHighlighterCore({
      themes: [await import('shiki/themes/github-dark.mjs')],
      langs: [
        await import('shiki/langs/typescript.mjs'), await import('shiki/langs/javascript.mjs'),
        await import('shiki/langs/json.mjs'), await import('shiki/langs/sql.mjs'),
        await import('shiki/langs/bash.mjs'), await import('shiki/langs/python.mjs'),
      ],
      engine: createJavaScriptRegexEngine(),
    });
  } catch { highlighter = null; }
  return highlighter;
}

function stripHtml(h: string): string {
  return h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const t = getTheme();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    getHighlighter().then(async (hl) => {
      if (!on || !hl) return;
      try {
        const out = await hl.codeToHtml(code, { lang: lang || 'text', theme: 'github-dark' });
        if (on) setText(stripHtml(out));
      } catch { /* 兜底 */ }
    }).catch(() => { /* 兜底 */ });
    return () => { on = false; };
  }, [code, lang]);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.border} paddingX={1}>
      <Text color={t.muted}>{lang || 'code'}</Text>
      <Text color={t.text}>{text ?? code}</Text>
    </Box>
  );
}
