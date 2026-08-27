// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
export function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const bothPlain = v !== null && typeof v === 'object' && !Array.isArray(v)
      && out[k] !== null && typeof out[k] === 'object' && !Array.isArray(out[k]);
    out[k] = bothPlain ? deepMerge(out[k], v) : v;
  }
  return out;
}
