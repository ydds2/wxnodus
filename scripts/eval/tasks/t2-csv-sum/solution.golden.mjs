// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
export function csvSum(csv) {
  let sum = 0;
  for (const line of String(csv).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.lastIndexOf(',');
    sum += Number(t.slice(idx + 1).trim());
  }
  return sum;
}
