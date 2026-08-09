// src/ui/lib/atRefs.ts — L6-3 差距 #2：@ 文件引用解析（输入中 @路径 注入内容）
import { readFileSync } from 'node:fs';

export interface AtRef { path: string; content: string }

export function resolveAtRefs(input: string): { refs: AtRef[]; remainder: string } {
  const refs: AtRef[] = [];
  const pattern = /@([A-Za-z]:\\[^\s]+|[^\\/\s]\S*)/g;
  let remainder = input;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(input)) !== null) {
    const path = m[1];
    try {
      const content = readFileSync(path, 'utf8').slice(0, 4000);
      refs.push({ path, content });
    } catch {
      refs.push({ path, content: '' }); // 不可读也记录引用（content 空，上层提示）
    }
    remainder = remainder.replace(m[0], '');
  }
  return { refs, remainder: remainder.trim() };
}
