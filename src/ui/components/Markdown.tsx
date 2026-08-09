// src/ui/components/Markdown.tsx — L6-2 Markdown 块渲染（标题/列表/代码/表格/数学/引用）
import React from 'react';
import { Box, Text } from 'ink';
import Table from 'cli-table3';
import { createRequire } from 'node:module';
import { parseMd } from '../markdown/parse.js';
import type { MdBlock } from '../markdown/blocks.js';
import { getTheme } from '../theme.js';
import { CodeBlock } from './CodeBlock.js';

// latex2unicode 发布含 .ts 源码（NodeNext 类型解析冲突）——createRequire 绕开
const require = createRequire(import.meta.url);
const latex2unicode = require('latex2unicode') as (tex: string) => string;

export function Markdown({ text }: { text: string }) {
  const blocks = parseMd(text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => <Block key={i} b={b} />)}
    </Box>
  );
}

function Inline({ text }: { text: string }) {
  const t = getTheme();
  const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|~~[^~]+~~)/g;
  const parts = text.split(INLINE_RE).filter(Boolean);
  return (
    <Text wrap="wrap">
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <Text key={i} bold>{p.slice(2, -2)}</Text>;
        if (p.startsWith('`') && p.endsWith('`')) return <Text key={i} color="#f472b6">{p.slice(1, -1)}</Text>;
        const link = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) return <Text key={i} color={t.accent} underline>{link[1]}</Text>;
        if (p.startsWith('~~') && p.endsWith('~~')) return <Text key={i} dimColor>{p.slice(2, -2)}</Text>;
        return <Text key={i}>{p}</Text>;
      })}
    </Text>
  );
}

function Block({ b }: { b: MdBlock }) {
  const t = getTheme();
  switch (b.type) {
    case 'heading':
      return <Text color={b.depth === 1 ? t.text : '#cbd5e1'} bold wrap="wrap">{b.depth === 1 ? '# ' : '#'.repeat(b.depth) + ' '}{b.text}</Text>;
    case 'paragraph': return <Inline text={b.text} />;
    case 'list':
      return (
        <Box flexDirection="column">
          {b.items.map((it, i) => (
            <Box key={i} flexDirection="row">
              <Text color={t.muted}>{b.ordered ? `${i + 1}.` : '•'} </Text>
              <Inline text={it} />
            </Box>
          ))}
        </Box>
      );
    case 'code': return <CodeBlock lang={b.lang} code={b.code} />;
    case 'table': return <TableBlock headers={b.headers} rows={b.rows} />;
    case 'quote': return <Text color={t.muted} wrap="wrap">{'  │ ' + b.text}</Text>;
    case 'math': return <Text color={t.accent} wrap="wrap">{latex2unicode(b.tex)}</Text>;
    case 'thematicBreak': return <Text color={t.border}>{"─".repeat(30)}</Text>;
    default: return <Inline text={b.text ?? ''} />;
  }
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const tb = new Table({ head: headers, style: { head: ['cyan'], border: ['gray'] } });
  rows.forEach(r => tb.push(r));
  return <Text>{tb.toString()}</Text>;
}

export { Inline };
