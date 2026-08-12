// src/kernel/jsonSchema.ts — 零依赖轻量 JSON Schema 校验（--output-schema 用）
// 支持子集：type / required / properties（嵌套）+ 顶层数组 items。
// 对齐 claude --json-schema / codex --output-schema 语义：输出不满足结构时明确报错（诚实，不静默）。
export interface SchemaViolation { path: string; message: string }

function checkType(value: unknown, type: string | undefined, path: string): SchemaViolation[] {
  if (!type) return [];
  const actual = Array.isArray(value) ? 'array' : typeof value;
  const ok =
    type === 'object' ? actual === 'object' && value !== null :
    type === 'array' ? actual === 'array' :
    type === 'integer' ? actual === 'number' && Number.isInteger(value) :
    type === 'number' ? actual === 'number' :
    type === 'string' ? actual === 'string' :
    type === 'boolean' ? actual === 'boolean' :
    type === 'null' ? value === null :
    true;
  return ok ? [] : [{ path, message: `期望 ${type}，实际 ${actual}` }];
}

export function validateJsonSchema(data: unknown, schema: Record<string, any>): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  const walk = (value: unknown, s: Record<string, any>, path: string) => {
    out.push(...checkType(value, s.type, path));
    if (s.type === 'array' && s.items && Array.isArray(value)) {
      value.forEach((item, i) => walk(item, s.items, `${path}[${i}]`));
    }
    if (s.type === 'object' && s.properties && typeof value === 'object' && value !== null) {
      for (const [k, sub] of Object.entries(s.properties)) {
        if (k in (value as Record<string, unknown>)) {
          walk((value as Record<string, unknown>)[k], sub as Record<string, any>, path ? `${path}.${k}` : k);
        }
      }
    }
  };
  walk(data, schema, '');
  // required 检查（顶层 + 嵌套 object）
  const reqWalk = (value: unknown, s: Record<string, any>, path: string) => {
    if (s.type === 'object' && s.properties && typeof value === 'object' && value !== null) {
      for (const req of s.required ?? []) {
        if (!(req in (value as Record<string, unknown>))) {
          out.push({ path: path ? `${path}.${req}` : req, message: '缺少必填字段' });
        }
      }
      for (const [k, sub] of Object.entries(s.properties)) {
        if (k in (value as Record<string, unknown>)) {
          reqWalk((value as Record<string, unknown>)[k], sub as Record<string, any>, path ? `${path}.${k}` : k);
        }
      }
    }
    if (s.type === 'array' && s.items && Array.isArray(value)) {
      value.forEach((item, i) => reqWalk(item, s.items, `${path}[${i}]`));
    }
  };
  reqWalk(data, schema, '');
  return out;
}
