// src/infrastructure/sqlite/bigramZh.ts — 中文 bigram 预处理（FTS5 unicode61 无法切中文词）
// 按 2 字滑窗生成 bigram 空格串：例「黑洞引擎」→「黑洞 洞引 引擎」——检索「黑洞」可命中；
// 英文/数字连续段保留为单词。legacy messages_fts 与 modern memory_fts 共用同一实现。
export function bigramZh(text: string): string {
  const tokens: string[] = [];
  let buf = '';
  let word = '';
  const flushWord = () => { if (word) { tokens.push(word); word = ''; } };
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      flushWord();
      buf += ch;
      if (buf.length >= 2) { tokens.push(buf); buf = buf.slice(1); }
    } else if (/[a-zA-Z0-9_]/.test(ch)) {
      buf = '';
      word += ch;
    } else {
      buf = '';
      flushWord();
      if (ch.trim()) tokens.push(ch);
    }
  }
  flushWord();
  return tokens.join(' ');
}
