# 任务 9：词频统计 Top-K

实现一个纯函数 `topWords(text, k)`：统计文本中 ASCII 单词（连续 `A-Za-z` 序列）出现次数，返回出现次数最高的前 `k` 个 `[单词, 次数]` 对。

规则：
- 统一转小写统计（`Hello` 与 `hello` 同一词）；
- 非字母字符一律视为分隔符（不构成单词）；
- 排序：次数降序；次数相同按单词字典序升序；
- `k` 大于不同词数时返回全部；空文本或无单词 → `[]`；`k <= 0` → `[]`。

示例：
- `topWords('a b a c', 2)` → `[['a', 2], ['b', 1]]`
- `topWords('Hello, hello! world', 2)` → `[['hello', 2], ['world', 1]]`

要求：
- 实现写入 `solution.mjs`（导出 `topWords`，node 可直接执行）；
- 禁止第三方包；
- 自测：`node verify.mjs`。
