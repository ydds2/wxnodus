// src/kernel/toolArgs.ts — 工具参数 schema 校验中介层（架构深度：OpenCode/AI SDK 对齐）
// 此前模型传错参数（缺必填/类型错）靠各工具内部防御——统一在执行前校验，
// 失败返回修正提示（模型可自我修正），审计留痕。schema 来源：ToolDef.schema.function.parameters。
export interface ToolArgsError { message: string }

/** 校验工具参数：返回错误消息或 null（通过） */
export function validateToolArgs(
  _name: string,
  args: Record<string, any> | undefined,
  tool: { schema?: { function?: { parameters?: { properties?: Record<string, any>; required?: string[] } } } }
): string | null {
  const params = tool?.schema?.function?.parameters;
  if (!params) return null; // 无 schema（历史工具）不校验
  const props = params.properties ?? {};
  const required = params.required ?? [];
  const a = args ?? {};

  // 必填检查（undefined/null 均视为缺失）
  const missing = required.filter(k => a[k] === undefined || a[k] === null);
  if (missing.length) {
    return `参数缺失（必填）：${missing.join('、')}`;
  }

  // 类型粗校验（number/string/boolean/array/object；oneOf/enum 从宽）
  for (const [k, v] of Object.entries(props)) {
    if (a[k] === undefined || a[k] === null) continue;
    const t = (v as { type?: string })?.type;
    if (!t || t === 'any') continue;
    const actual = Array.isArray(a[k]) ? 'array' : typeof a[k];
    const ok =
      t === 'number' ? actual === 'number' && Number.isFinite(a[k]) :
      t === 'string' ? actual === 'string' :
      t === 'boolean' ? actual === 'boolean' :
      t === 'array' ? actual === 'array' :
      t === 'object' ? actual === 'object' && a[k] !== null :
      true;
    if (!ok) return `参数 ${k} 类型错误：期望 ${t}，实际 ${actual}`;
  }
  return null;
}
