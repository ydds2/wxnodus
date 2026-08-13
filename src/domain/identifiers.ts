// src/domain/identifiers.ts — 标识符归一化（NFKC + en-US 小写）
export function canonicalIdentifier(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}
