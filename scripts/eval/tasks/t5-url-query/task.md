# 任务 5：URL 查询串解析

实现一个纯函数 `parseQuery(qs)`：解析 URL 查询串（**不含**开头的 `?`）为对象。

规则：
- 按 `&` 分隔 `key=value` 对；无 `=` 的项 value 为空字符串；
- 值做百分号解码（UTF-8，等价于 `decodeURIComponent` 语义）；`+` 是字面量**不转空格**；
- 同名 key 重复出现 → 值合并为数组（按出现顺序）；
- 空输入 → `{}`。

示例：
- `parseQuery('a=1&b=2')` → `{ a: '1', b: '2' }`
- `parseQuery('k=%E4%B8%AD&k=2')` → `{ k: ['中', '2'] }`

要求：
- 实现写入 `solution.mjs`（导出 `parseQuery`，node 可直接执行）；
- 禁止第三方包；
- 自测：`node verify.mjs`。
