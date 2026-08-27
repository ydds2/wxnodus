// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
export function daysBetween(a, b) {
  const ms = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86400000);
}
