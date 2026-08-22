// src/wxnodus-ui/lib/markdown/renderText.ts — /render 真实 Markdown 文本渲染（2026-08-19「不真实修」：
// 此前 /render 仅行级前缀变换却挂着「Markdown 排版预览」描述——现复用成熟解析器真实渲染）
// 复用 markdown/parse.ts（micromark + GFM + math）——与 TUI 渲染同源，语义一致。
import { parseMd } from './parse.js';
import type { MdBlock } from './blocks.js';

const renderBlock = (b: MdBlock): string[] => {
  switch (b.type) {
    case 'heading': return [`${'#'.repeat(b.depth)} ${b.text}`];
    case 'paragraph': return [b.text];
    case 'list': return b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `• ${it}`));
    case 'code': return [`\`\`\`${b.lang ?? ''}`, ...b.code.split('\n'), '```'];
    case 'table': {
      const widths = b.headers.map((h, i) => Math.max(h.length, ...b.rows.map(r => (r[i] ?? '').length)));
      const line = (cells: string[]) => '│ ' + cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0, ' ')).join(' │ ') + ' │';
      return [line(b.headers), '├' + widths.map(w => '─'.repeat(w + 2)).join('┼') + '┤', ...b.rows.map(line)];
    }
    case 'quote': return b.text.split('\n').map(l => `│ ${l}`);
    case 'math': return [b.block ? `$$${b.tex}$$` : `$${b.tex}$`];
    case 'thematicBreak': return ['─'.repeat(24)];
    case 'html': return [b.text];
    default: return [];
  }
};

/** Markdown 文本 → 纯文本渲染（真实解析器驱动；空输入 → 空数组） */
export function renderMarkdownText(text: string): string[] {
  const blocks = parseMd(text);
  if (!blocks.length) return [];
  return blocks.flatMap(renderBlock);
}
