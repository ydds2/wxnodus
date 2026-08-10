// src/ui/markdown/blocks.ts — L6-1 块模型类型
export type MdBlock =
  | { type: 'heading'; depth: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'quote'; text: string }
  | { type: 'math'; tex: string; block: boolean }
  | { type: 'thematicBreak' }
  | { type: 'html'; text: string };
