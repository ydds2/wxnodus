// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
export function isAnagram(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/ /g, '').split('').sort().join('');
  return norm(a) === norm(b);
}
