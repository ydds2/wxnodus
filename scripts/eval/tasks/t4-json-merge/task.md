# 任务 4：JSON 深度合并

实现一个纯函数 `deepMerge(a, b)`：返回两个普通 JSON 对象的深度合并结果（新对象，**不得修改入参**）。

合并规则：
- 标量（string/number/boolean/null）：`b` 覆盖 `a`；
- 嵌套对象：递归合并；
- 数组：`b` 的数组整体替换 `a` 的数组（不做元素合并）。

要求：
- 实现写入 `solution.mjs`（导出 `deepMerge`，node 可直接执行）；
- 禁止第三方包；
- 自测：`node verify.mjs`。
