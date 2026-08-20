// src/application/release/powershellLiteral.ts — P0-03：PowerShell 单引号字面量编码
// appName/entry/path 等来自外部输入的值绝不直接插入 PowerShell 源码；统一经本编码器转成被动字面量。
export function psSingleQuotedLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
