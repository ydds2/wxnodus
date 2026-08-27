// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
export function topWords(text, k) {
  if (k <= 0) return [];
  const counts = new Map();
  for (const w of String(text).toLowerCase().match(/[a-z]+/g) ?? []) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, k);
}
