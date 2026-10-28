import type { Runtime } from '../runtime.js';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** 已读取文件 -> 读取时的 mtime，用于 Edit/Write 前的"先读后改"校验 */
  readFiles: Map<string, number>;
  /** 'root' 或 worker id（如 worker-1） */
  agentId: string;
  runtime: Runtime;
}

/**
 * read:    只读，默认无需确认
 * edit:    修改文件（acceptEdits 模式下自动允许）
 * exec:    执行命令 / 有副作用的外部调用（除 yolo 外都需确认）
 * network: 访问网络（除 yolo 外都需确认，可按域名"始终允许"）
 */
export type ToolKind = 'read' | 'edit' | 'exec' | 'network';

/**
 * 工具自定义的权限判断，返回 undefined 表示按 kind + 模式的默认规则处理
 * - allow: 直接允许（如只读的安全命令）
 * - ask:   需要确认，会覆盖 acceptEdits 和"始终允许"；force=true 时连 yolo 模式也要确认
 * - deny:  直接拒绝
 */
export type PermissionCheck =
  | { behavior: 'allow' }
  | { behavior: 'ask'; reason: string; force?: boolean; allowAlways?: boolean }
  | { behavior: 'deny'; reason: string };

export interface Tool<I = any> {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type?: string; description?: string; [k: string]: unknown }>;
    required?: string[];
    [k: string]: unknown;
  };
  kind: ToolKind;
  /** 在终端里显示的一行调用摘要，如 Read(src/index.ts) */
  summary(input: I): string;
  /** 请求权限时展示的预览（如 diff） */
  preview?(input: I, ctx: ToolContext): Promise<string> | string;
  /** "始终允许"的粒度，默认按工具名；Bash 按命令前缀，WebFetch 按域名 */
  permissionKey?(input: I): string;
  checkPermission?(input: I, ctx: ToolContext): PermissionCheck | undefined;
  run(input: I, ctx: ToolContext): Promise<string>;
  /** 执行结果在终端里的展示方式，默认显示前几行 */
  display?(output: string, input: I): string;
}

export function defineTool<I>(tool: Tool<I>): Tool<I> {
  return tool;
}
