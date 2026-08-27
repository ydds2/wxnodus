// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
export function fibonacci(n) {
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) [a, b] = [b, a + b];
  return b;
}
