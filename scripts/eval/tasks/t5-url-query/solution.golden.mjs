// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
export function parseQuery(qs) {
  if (!qs) return {};
  const out = {};
  for (const pair of String(qs).split('&')) {
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const v = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : '';
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    } else {
      out[k] = v;
    }
  }
  return out;
}
