// src/kernel/hash.ts — 输出短哈希（supremacy 3.5 提取叶子：供微基准直连——此前在 agent.ts 内，
// 基准打包会拖入 onnxruntime/node-screenshots 原生依赖图）
// FNV-1a 36 进制 7 位——签名并入输出，防「同参数不同输出」空转漏检（crush SHA-256 思想）
export function shortHash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).padStart(7, '0');
}
