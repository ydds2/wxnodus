# 任务 6：罗马数字转整数

实现一个纯函数 `romanToInt(s)`：把罗马数字字符串（标准写法，1–3999）转为整数。

规则（标准减法记法）：I=1, V=5, X=10, L=50, C=100, D=500, M=1000；小数在大数前表示减法（如 IV=4、IX=9）。

示例：
- `romanToInt('III')` → `3`
- `romanToInt('MCMXCIV')` → `1994`

要求：
- 实现写入 `solution.mjs`（导出 `romanToInt`，node 可直接执行）；
- 输入保证是合法罗马数字（无需校验非法输入）；
- 禁止第三方包；
- 自测：`node verify.mjs`。
