// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
export function extractLinks(md) {
  const out = [];
  const seen = new Set();
  const re = /(?<!!)\[([^[\]()]+)\]\(([^[\]()]+)\)/g;
  let m;
  while ((m = re.exec(md))) {
    if (!seen.has(m[2])) { seen.add(m[2]); out.push([m[1], m[2]]); }
  }
  return out;
}
