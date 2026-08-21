// src/infrastructure/sqlite/bigramZh.ts — 中文 FTS5 预处理（unicode61 无法切中文词）
// V4 P5-4（C 级）语义：每个汉字产出 unigram token + 相邻 bigram token——
//   「分词方案」→「分 词 方 案 分词 词方 方案」
// 此前仅 bigram：单字 query（如「黑」）零命中；且只补尾字会造成索引/查询两侧
// token 集不一致（查询「分词」尾字是「词」、索引「分词方案」尾字是「案」——
// AND 语义下恒不命中）。双侧全 unigram+bigram 后：单字/多字/AND/OR 全可命中，
// 精度由 bm25 rank 承担。英文/数字连续段保留为单词。
// legacy messages_fts 与 modern memory_fts 共用同一实现。
export function bigramZh(text: string): string {
  const tokens: string[] = [];
  let run = '';
  let word = '';
  const flushWord = () => { if (word) { tokens.push(word); word = ''; } };
  const flushRun = () => {
    if (!run) return;
    const chars = [...run];
    for (const ch of chars) tokens.push(ch);            // unigram：单字可检
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i]! + chars[i + 1]!); // bigram：词组可检
    run = '';
  };
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      flushWord();
      run += ch;
    } else if (/[a-zA-Z0-9_]/.test(ch)) {
      word += ch;
    } else {
      flushRun();
      flushWord();
      if (ch.trim()) tokens.push(ch);
    }
  }
  flushRun();
  flushWord();
  return tokens.join(' ');
}
