# 任务 7：Markdown 链接提取

实现一个纯函数 `extractLinks(md)`：从 Markdown 文本提取行内链接，返回 `[文字, 目标]` 二元组数组。

规则：
- 只匹配 `[文字](url)` 语法；**忽略**图片 `![alt](url)`；
- 按 URL 去重，保留首次出现顺序（文字取首次出现时的文字）；
- 链接文字与 URL 均不包含方括号/圆括号（无需处理嵌套或转义）。

示例：
- `extractLinks('a [x](http://a) b ![i](http://img) c [y](http://b) [z](http://a)')`
  → `[['x', 'http://a'], ['y', 'http://b']]`

要求：
- 实现写入 `solution.mjs`（导出 `extractLinks`，node 可直接执行）；
- 禁止第三方包；
- 自测：`node verify.mjs`。
