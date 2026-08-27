// golden 参考解（selftest 用：验证评分脚本 PASS/FAIL 双向路径）
// 递归下降解析：括号 > * / > + -；除法向零截断（|0）。
export function evalArith(expr) {
  const s = expr;
  let i = 0;
  const parseExpr = () => {
    let v = parseTerm();
    while (i < s.length && (s[i] === '+' || s[i] === '-')) {
      const op = s[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = () => {
    let v = parseFactor();
    while (i < s.length && (s[i] === '*' || s[i] === '/')) {
      const op = s[i++];
      const r = parseFactor();
      v = op === '*' ? v * r : (v / r) | 0;
    }
    return v;
  };
  const parseFactor = () => {
    if (s[i] === '(') { i++; const v = parseExpr(); i++; return v; }
    let neg = false;
    if (s[i] === '-') { neg = true; i++; }
    let num = 0;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') { num = num * 10 + (s.charCodeAt(i) - 48); i++; }
    return neg ? -num : num;
  };
  return parseExpr();
}
