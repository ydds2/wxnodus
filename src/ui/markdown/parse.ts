// src/ui/markdown/parse.ts — L6-1 Markdown 解析层（micromark + GFM + math → 块模型）
// 设计：成熟解析器（micromark 官方流式 + mdast 生态）；流式容错（未闭合围栏补全）
//       参考：opencode/Claude Code 均用「成熟解析器 + 自研薄渲染层」
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import type { Content } from 'mdast';
import type { MdBlock } from './blocks.js';

export function parseMd(text: string): MdBlock[] {
  if (!text.trim()) return [];
  // 流式容错：未闭合围栏补全
  const fence = text.match(/```[^\n]*$/);
  const safe = fence ? text + '\n```' : text;
  const tree = fromMarkdown(safe, {
    extensions: [gfm() as any, math() as any],
    mdastExtensions: [gfmFromMarkdown() as any, mathFromMarkdown() as any],
  });
  return (tree.children as Content[]).map(toBlock);
}

function toBlock(n: Content): MdBlock {
  switch (n.type) {
    case 'heading': return { type: 'heading', depth: (n as any).depth, text: inline(n) };
    case 'paragraph': return { type: 'paragraph', text: inline(n) };
    case 'list': {
      const items = (n as any).children.map((c: any) => (c.type === 'listItem' ? c.children.map(inline).join(' ') : ''));
      return { type: 'list', ordered: (n as any).ordered ?? false, items };
    }
    case 'code': return { type: 'code', lang: (n as any).lang ?? '', code: (n as any).value };
    case 'table': {
      const tbl = n as any;
      const headers = tbl.children[0]?.children.map((c: any) => inline(c)) ?? [];
      const rows = tbl.children.slice(1).map((r: any) => r.children.map((c: any) => inline(c)));
      return { type: 'table', headers, rows };
    }
    case 'blockquote': return { type: 'quote', text: inline(n) };
    case 'math': return { type: 'math', tex: (n as any).value, block: true };
    case 'thematicBreak': return { type: 'thematicBreak' };
    case 'html': return { type: 'html', text: (n as any).value };
    default: return { type: 'paragraph', text: inline(n) };
  }
}

function inline(n: any): string {
  if (!n.children) return String(n.value ?? n.alt ?? '');
  return n.children.map((c: any) => (c.value ?? c.alt ?? '')).join('');
}
