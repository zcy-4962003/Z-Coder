import type { Tool } from './types.js';

/** 轻量参数校验：必填项 + 基本类型。错误会作为 tool_result 返回给模型自行修正 */
export function validateInput(tool: Tool, input: Record<string, unknown>): string | null {
  if ('__invalid_json__' in input) return `Tool arguments are not valid JSON: ${String(input.__invalid_json__).slice(0, 200)}`;
  const schema = tool.input_schema;
  for (const key of schema.required ?? []) {
    if (input[key] === undefined || input[key] === null) return `Missing required parameter: ${key}`;
  }
  for (const [key, value] of Object.entries(input)) {
    const expected = schema.properties?.[key]?.type;
    // MCP 工具的 schema 可能是联合类型等复杂写法，只校验简单类型
    if (typeof expected !== 'string' || value === null || value === undefined) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const ok = expected === 'integer' ? Number.isInteger(value) : expected === 'number' ? typeof value === 'number' : actual === expected;
    if (!ok) return `Parameter "${key}" should be ${expected}, got ${actual}`;
  }
  return null;
}
