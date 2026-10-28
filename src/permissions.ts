import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { PermissionCheck, Tool, ToolContext } from './tools/types.js';

/**
 * default:     修改文件、执行命令、访问网络都需要确认
 * acceptEdits: 工作目录内的文件修改自动允许，其余仍需确认
 * yolo:        除"强制确认"的危险操作外全部自动允许
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'yolo';
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'yolo'];

export interface PermissionRequest {
  tool: Tool;
  input: unknown;
  /** 预览内容（diff / 命令），可含 ANSI 颜色 */
  preview: string;
  /** "始终允许"作用范围的描述；allowAlways=false 时不提供该选项 */
  scope: string;
  allowAlways: boolean;
  /** 需要特别提示用户的原因（如：工作目录外、危险命令） */
  reason?: string;
  /** 发起请求的 Agent（root 或 worker-N） */
  agentId: string;
}

export type PermissionAnswer = { type: 'yes' } | { type: 'always' } | { type: 'no'; feedback?: string };

/** 由界面实现：向用户展示确认框并返回选择 */
export type Prompter = (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>;

export type Decision =
  | { allowed: true }
  /** halt=true 表示用户直接拒绝，Agent 应停止并等待用户新指令 */
  | { allowed: false; reason: string; halt: boolean };

type Evaluation = { type: 'allow' } | { type: 'deny'; reason: string } | { type: 'ask'; reason?: string; allowAlways: boolean };

export class Permissions {
  private readonly always = new Set<string>();

  constructor(
    public mode: PermissionMode,
    private readonly prompter: Prompter | null,
  ) {}

  private key(tool: Tool, input: unknown): string {
    return tool.permissionKey ? `${tool.name}:${tool.permissionKey(input)}` : tool.name;
  }

  get interactive(): boolean {
    return this.prompter !== null;
  }

  cycleMode(): PermissionMode {
    this.mode = PERMISSION_MODES[(PERMISSION_MODES.indexOf(this.mode) + 1) % PERMISSION_MODES.length]!;
    return this.mode;
  }

  evaluate(tool: Tool, input: unknown, ctx: ToolContext): Evaluation {
    const check = tool.checkPermission?.(input, ctx);
    if (check?.behavior === 'deny') return { type: 'deny', reason: check.reason };
    if (check?.behavior === 'allow') return { type: 'allow' };
    if (check?.behavior === 'ask') {
      if (this.mode === 'yolo' && !check.force) return { type: 'allow' };
      const allowAlways = check.allowAlways ?? false;
      if (allowAlways && this.always.has(this.key(tool, input))) return { type: 'allow' };
      return { type: 'ask', reason: check.reason, allowAlways };
    }
    if (tool.kind === 'read' || this.mode === 'yolo') return { type: 'allow' };
    if (this.mode === 'acceptEdits' && tool.kind === 'edit') return { type: 'allow' };
    if (this.always.has(this.key(tool, input))) return { type: 'allow' };
    return { type: 'ask', allowAlways: true };
  }

  async request(tool: Tool, input: unknown, ctx: ToolContext, preview: string, ev: { reason?: string; allowAlways: boolean }): Promise<Decision> {
    if (!this.prompter) {
      return {
        allowed: false,
        halt: true,
        reason: `Permission for ${tool.name} is required but the session is non-interactive${ev.reason ? ` (${ev.reason})` : ''}. The user can re-run with --accept-edits or --yolo.`,
      };
    }
    const scope = tool.permissionKey ? `"${tool.permissionKey(input)}"` : tool.name;
    const req: PermissionRequest = { tool, input, preview, scope, allowAlways: ev.allowAlways, agentId: ctx.agentId };
    if (ev.reason) req.reason = ev.reason;
    const answer = await this.prompter(req, ctx.signal);

    if (answer.type === 'yes') return { allowed: true };
    if (answer.type === 'always') {
      if (ev.allowAlways) this.always.add(this.key(tool, input));
      return { allowed: true };
    }
    const feedback = answer.feedback?.trim();
    if (feedback) return { allowed: false, halt: false, reason: `The user rejected this tool call and said: ${feedback}` };
    return { allowed: false, halt: true, reason: 'The user rejected this tool call. Stop and wait for further instructions from the user.' };
  }
}

// ------------------------------------------------------------------ 路径检查

export function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']);

/** 可能包含密钥的文件 */
export function isSensitivePath(abs: string): boolean {
  const name = basename(abs).toLowerCase();
  if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name) || /\.(pem|key|p12|pfx)$/.test(name)) return true;
  if (abs.split(/[\\/]/).some((seg) => SENSITIVE_DIRS.has(seg.toLowerCase()))) return true;
  // coder 自己的配置文件里有 API Key
  if (isInside(abs, join(homedir(), '.coder')) && name === 'config.json' && dirname(abs).endsWith('.coder')) return true;
  return false;
}

export function checkPath(abs: string, ctx: ToolContext, access: 'read' | 'write'): PermissionCheck | undefined {
  const sensitive = isSensitivePath(abs);
  if (access === 'write') {
    if (sensitive) return { behavior: 'ask', force: true, reason: `Writing a sensitive file (${basename(abs)})` };
    if (!isInside(abs, ctx.cwd)) return { behavior: 'ask', reason: `Writing outside the working directory: ${dirname(abs)}${sep}` };
    return undefined;
  }
  const trusted = isInside(abs, ctx.cwd) || ctx.runtime.trustedReadRoots.some((r) => isInside(abs, r));
  if (sensitive) return { behavior: 'ask', reason: `Reading a file that may contain secrets (${basename(abs)})` };
  if (!trusted) return { behavior: 'ask', reason: `Reading outside the working directory: ${abs}` };
  return undefined;
}

// ------------------------------------------------------------------ 命令检查

const DANGEROUS_COMMANDS: RegExp[] = [
  /\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)/i,
  /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\*)/i,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\b(rd|rmdir)\s+\/s\b/i,
  /\bdel\s+(\/[a-z]\s+)*\/[sq]\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\b/i,
  /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i,
  /\bgit\s+branch\s+-D\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+[^\n]*\bof=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\b(Stop|Restart)-Computer\b/i,
  /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|Invoke-Expression|python\d?|node)\b/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\breg\s+(delete|add)\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
];

/** 只读、无副作用的常用命令：单条命令（无管道/重定向/串联）时自动允许 */
const SAFE_COMMANDS: RegExp[] = [
  /^(ls|dir|pwd|tree|whoami|hostname|date|echo|type|cat|head|tail|wc|which|where|where\.exe)(\s|$)/i,
  /^(Get-ChildItem|gci|Get-Location|gl|Get-Content|gc|Get-Item|Get-Date|Test-Path|Resolve-Path|Get-Command)(\s|$)/i,
  /^git\s+(status|diff|log|show|branch|remote(\s+-v)?|rev-parse|ls-files|blame|describe|tag)(\s|$)/i,
  /^(node|npm|npx|pnpm|yarn|python|python3|py|pip|go|cargo|rustc|java|tsc|deno|bun)\s+(-v|--version|-V|version)$/i,
  /^(npm|pnpm|yarn)\s+(ls|list|outdated|view|why)(\s|$)/i,
];

const SHELL_OPERATORS = /[;&|<>`\n]|\$\(/;

export function checkCommand(command: string): PermissionCheck | undefined {
  const cmd = command.trim();
  if (DANGEROUS_COMMANDS.some((re) => re.test(cmd))) {
    return { behavior: 'ask', force: true, reason: 'Potentially destructive or externally visible command', allowAlways: false };
  }
  const hasOperators = SHELL_OPERATORS.test(cmd);
  if (!hasOperators && SAFE_COMMANDS.some((re) => re.test(cmd))) return { behavior: 'allow' };
  // 串联/管道命令不提供"按前缀始终允许"，避免 `git status; rm -rf x` 这类绕过
  if (hasOperators) return { behavior: 'ask', reason: 'Compound command (pipes, redirects or chaining)', allowAlways: false };
  return undefined;
}
