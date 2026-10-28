// 上下文管理
// - 统计：优先使用 provider 返回的 usage，再加上该请求之后新增消息的估算（tail estimate）
// - 折叠：把较早的大块工具结果替换为简短占位（无需调用模型）
// - 压缩：让模型总结历史（见 Agent.compact）
// - 裁剪：总结失败或请求仍超长时，直接丢弃最早的若干轮对话

import type { ContentBlock, Message } from './llm/types.js';

/** 粗略估算 token：ASCII 约 4 字符 1 token，CJK 等非 ASCII 字符约 0.75 token */
export function estimateTextTokens(s: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 128) ascii++;
    else if (code < 0xdc00 || code > 0xdfff) other++; // 代理对的低位不重复计数
  }
  return Math.ceil(ascii / 4 + other * 0.75);
}

function blockTokens(b: ContentBlock): number {
  if (b.type === 'text') return estimateTextTokens(b.text);
  if (b.type === 'tool_use') return estimateTextTokens(b.name + JSON.stringify(b.input)) + 8;
  return estimateTextTokens(b.content) + 8;
}

export function estimateMessageTokens(m: Message): number {
  const body = typeof m.content === 'string' ? estimateTextTokens(m.content) : m.content.reduce((n, b) => n + blockTokens(b), 0);
  return body + 4;
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

export interface ContextStats {
  total: number;
  /** 来自 provider usage 的部分 */
  fromUsage: number;
  /** usage 之后新增消息的估算 */
  tail: number;
  /** 是否完全依赖估算（还没有 usage） */
  estimated: boolean;
}

export class ContextTracker {
  private usageTokens = 0;
  /** usage 覆盖到的消息数量（含模型回复） */
  private usageIndex = 0;

  record(inputTokens: number, outputTokens: number, messagesLength: number): void {
    if (!inputTokens) return;
    this.usageTokens = inputTokens + outputTokens;
    this.usageIndex = messagesLength;
  }

  /** 历史被就地修改（折叠）后，修正 usage 的估计值 */
  adjust(deltaTokens: number): void {
    if (this.usageTokens) this.usageTokens = Math.max(0, this.usageTokens + deltaTokens);
  }

  reset(): void {
    this.usageTokens = 0;
    this.usageIndex = 0;
  }

  stats(messages: Message[], overheadTokens: number): ContextStats {
    if (this.usageTokens && this.usageIndex <= messages.length) {
      const tail = estimateMessagesTokens(messages.slice(this.usageIndex));
      return { total: this.usageTokens + tail, fromUsage: this.usageTokens, tail, estimated: false };
    }
    const total = overheadTokens + estimateMessagesTokens(messages);
    return { total, fromUsage: 0, tail: total, estimated: true };
  }
}

const FOLD_MARK = '[Folded to save context]';

/**
 * 折叠较早的工具结果：保留最近 keepRecent 个，其余超过 minChars 的替换为简短预览
 * 返回折叠数量与节省的 token 估算
 */
export function foldToolResults(messages: Message[], keepRecent = 6, minChars = 1500): { folded: number; savedTokens: number } {
  const names = new Map<string, string>();
  const results: { block: Extract<ContentBlock, { type: 'tool_result' }> }[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') names.set(b.id, b.name);
      else if (b.type === 'tool_result') results.push({ block: b });
    }
  }
  let folded = 0;
  let saved = 0;
  for (const { block } of results.slice(0, Math.max(0, results.length - keepRecent))) {
    if (block.content.length < minChars || block.content.startsWith(FOLD_MARK)) continue;
    const before = estimateTextTokens(block.content);
    const savedPath = /Full output saved to: (.+)/.exec(block.content)?.[1];
    const name = names.get(block.tool_use_id) ?? 'tool';
    block.content =
      `${FOLD_MARK} Earlier ${name} result (${block.content.length.toLocaleString()} chars) was folded.` +
      (savedPath ? ` Full output: ${savedPath}` : ' Re-run the tool if you need it again.') +
      `\nPreview: ${block.content.slice(0, 300).replace(/\s+/g, ' ')}…`;
    saved += before - estimateTextTokens(block.content);
    folded++;
  }
  return { folded, savedTokens: saved };
}

/** 是否是用户发起的一轮（而不是工具结果回填） */
function isTurnStart(m: Message): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return m.content.some((b) => b.type === 'text');
}

/**
 * 裁剪：从最早的轮次开始丢弃，直到估算值不超过 targetTokens（至少保留最后一轮）
 * 切分点总是落在用户发起的轮次上，保证 tool_use / tool_result 成对
 */
export function trimMessages(messages: Message[], targetTokens: number): { messages: Message[]; dropped: number } {
  const starts: number[] = [];
  for (let i = 1; i < messages.length; i++) if (isTurnStart(messages[i]!)) starts.push(i);
  if (!starts.length) return { messages, dropped: 0 };
  let cut = starts.at(-1)!;
  for (const s of starts) {
    if (estimateMessagesTokens(messages.slice(s)) <= targetTokens) {
      cut = s;
      break;
    }
  }
  const kept = messages.slice(cut);
  return {
    messages: [
      { role: 'user', content: `[${cut} earlier messages were trimmed to fit the context window. Ask the user if you need details from before.]` },
      { role: 'assistant', content: 'Understood. I will continue with the remaining context.' },
      ...kept,
    ],
    dropped: cut,
  };
}

export function isContextLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /API error (400|413)/.test(msg) && /(context|too long|too many tokens|maximum.*tokens|prompt is too long|length)/i.test(msg);
}
