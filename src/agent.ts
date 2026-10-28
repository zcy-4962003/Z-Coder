// Agent 主循环：调用模型 -> 执行工具 -> 回填结果 -> 再次调用，直到模型不再调用工具
// root agent 和只读 worker 共用这一实现，区别仅在于工具集、系统提示词和 View

import { ContextTracker, estimateTextTokens, foldToolResults, isContextLengthError, trimMessages, type ContextStats } from './context.js';
import type { ChatResponse, ContentBlock, Message, ToolResultBlock, ToolSpec, ToolUseBlock } from './llm/types.js';
import { COMPACT_PROMPT } from './prompt.js';
import type { Runtime } from './runtime.js';
import type { Tool, ToolContext } from './tools/types.js';
import { validateInput } from './tools/validate.js';
import { errorMessage, previewLines } from './ui.js';
import type { AgentView } from './view.js';

export interface AgentOptions {
  runtime: Runtime;
  view: AgentView;
  /** 'root' 或 worker id */
  agentId: string;
  /** 每次调用模型前获取当前可用的工具（MCP 连接、Goal 状态变化后会改变） */
  tools: () => Tool[];
  systemPrompt: () => string;
  maxTurns?: number;
}

/** 上下文占用达到该比例时折叠旧的工具结果 */
const FOLD_AT = 0.6;
/** 达到该比例时让模型总结历史 */
const COMPACT_AT = 0.8;
/** 裁剪后的目标比例 */
const TRIM_TO = 0.5;

export class Agent {
  messages: Message[] = [];
  readonly usage = { input: 0, output: 0, requests: 0 };
  readonly context = new ContextTracker();
  /** 上次请求的系统提示词 + 工具定义的估算大小 */
  private overheadTokens = 0;
  private readonly readFiles = new Map<string, number>();

  constructor(private readonly opts: AgentOptions) {}

  get runtime(): Runtime {
    return this.opts.runtime;
  }

  get id(): string {
    return this.opts.agentId;
  }

  get cwd(): string {
    return this.opts.runtime.cwd;
  }

  private get view(): AgentView {
    return this.opts.view;
  }

  contextStats(): ContextStats {
    if (!this.overheadTokens) this.overheadTokens = this.estimateOverhead(this.opts.systemPrompt(), this.specs(this.opts.tools()));
    return this.context.stats(this.messages, this.overheadTokens);
  }

  reset(): void {
    this.messages = [];
    this.readFiles.clear();
    this.context.reset();
  }

  /** 替换整个历史（恢复会话、分叉等） */
  load(messages: Message[]): void {
    this.reset();
    this.messages = messages;
  }

  lastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role !== 'assistant') continue;
      const text = typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      if (text.trim()) return text.trim();
    }
    return '';
  }

  /** 追加 user 内容；若最后一条已是 user（如中断后），则合并，保证 user/assistant 交替 */
  private pushUser(blocks: ContentBlock[]): void {
    const last = this.messages.at(-1);
    if (last?.role === 'user') {
      const prev: ContentBlock[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      last.content = [...prev, ...blocks];
    } else {
      this.messages.push({ role: 'user', content: blocks });
    }
  }

  private specs(tools: Tool[]): ToolSpec[] {
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  }

  private estimateOverhead(system: string, specs: ToolSpec[]): number {
    return estimateTextTokens(system) + estimateTextTokens(JSON.stringify(specs));
  }

  async run(input: string, signal: AbortSignal): Promise<void> {
    await this.manageContext(signal, false);
    this.pushUser([{ type: 'text', text: input }]);

    const maxTurns = this.opts.maxTurns ?? 50;
    for (let turn = 0; turn < maxTurns; turn++) {
      const tools = this.opts.tools();
      const system = this.opts.systemPrompt();
      const res = await this.callModel(system, tools, signal);
      if (!res) {
        // 用户中断：留下标记，让模型在下一轮知道之前的请求没有完成
        this.pushUser([{ type: 'text', text: '[Request interrupted by user]' }]);
        return;
      }

      this.messages.push({ role: 'assistant', content: res.content.length ? res.content : [{ type: 'text', text: '(empty response)' }] });
      this.context.record(res.usage.inputTokens, res.usage.outputTokens, this.messages.length);

      const uses = res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (!uses.length) {
        if (res.stopReason === 'max_tokens') this.view.print('⚠ Response was cut off by max_tokens. Say "continue" to resume.', 'warn');
        return;
      }

      const results: ToolResultBlock[] = [];
      let halt = false;
      for (const use of uses) {
        if (halt || signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Tool call cancelled.', is_error: true });
          continue;
        }
        const r = await this.executeTool(use, tools, signal);
        results.push(r.result);
        if (r.halt) halt = true;
      }
      this.pushUser(results);

      if (signal.aborted) {
        this.view.print('  ⎿  Interrupted by user', 'warn');
        this.pushUser([{ type: 'text', text: '[Request interrupted by user]' }]);
        return;
      }
      if (halt) return;
      await this.manageContext(signal, true);
    }
    this.view.print(`⚠ Reached the maximum of ${maxTurns} turns. Say "continue" to keep going.`, 'warn');
  }

  /**
   * 上下文治理：折叠 -> 总结压缩 -> 裁剪（逐级升级）
   * midTurn=true 表示在一轮工具调用中间，压缩后需要提示模型继续
   */
  private async manageContext(signal: AbortSignal, midTurn: boolean): Promise<void> {
    const limit = this.opts.runtime.contextLimit;
    let total = this.contextStats().total;
    if (total <= limit * FOLD_AT) return;

    const { folded, savedTokens } = foldToolResults(this.messages);
    if (folded) {
      this.context.adjust(-savedTokens);
      total = this.contextStats().total;
      this.view.print(`✻ Folded ${folded} old tool result(s) to save ~${savedTokens.toLocaleString()} tokens`, 'dim');
    }
    if (total <= limit * COMPACT_AT) return;

    this.view.print('✻ Context is getting large, auto-compacting…', 'dim');
    let compacted = false;
    try {
      compacted = await this.compact(signal);
    } catch (err) {
      if (signal.aborted) return;
      this.view.print(`✻ Compaction failed (${errorMessage(err).slice(0, 120)}), trimming old messages instead`, 'warn');
    }
    if (!compacted && !signal.aborted) this.trim();
    if (midTurn && this.messages.at(-1)?.role === 'assistant') {
      this.pushUser([{ type: 'text', text: 'Continue the task from where you left off.' }]);
    }
  }

  /** 裁剪最早的对话，使估算值降到上限的 TRIM_TO 以下 */
  trim(): number {
    const { messages, dropped } = trimMessages(this.messages, this.opts.runtime.contextLimit * TRIM_TO);
    if (!dropped) return 0;
    this.messages = messages;
    this.context.reset();
    this.view.print(`✻ Trimmed ${dropped} earlier message(s) to fit the context window`, 'dim');
    return dropped;
  }

  private async callModel(system: string, tools: Tool[], signal: AbortSignal, retried = false): Promise<ChatResponse | null> {
    const specs = this.specs(tools);
    this.overheadTokens = this.estimateOverhead(system, specs);
    this.view.setStatus('Thinking');
    try {
      const res = await this.opts.runtime.provider.chat({
        system,
        messages: this.messages,
        tools: specs,
        maxTokens: this.opts.runtime.maxTokens,
        signal,
        onText: (t) => this.view.textDelta(t),
      });
      this.trackUsage(res);
      return res;
    } catch (err) {
      if (signal.aborted) {
        this.view.textEnd();
        this.view.setStatus(null);
        this.view.print('  ⎿  Interrupted by user', 'warn');
        return null;
      }
      // 请求超出上下文窗口：裁剪后重试一次
      if (!retried && isContextLengthError(err) && this.trim() > 0) {
        this.view.textEnd();
        return this.callModel(system, tools, signal, true);
      }
      throw err;
    } finally {
      this.view.textEnd();
      this.view.setStatus(null);
    }
  }

  private trackUsage(res: ChatResponse): void {
    this.usage.requests++;
    this.usage.input += res.usage.inputTokens;
    this.usage.output += res.usage.outputTokens;
  }

  private async executeTool(use: ToolUseBlock, tools: Tool[], signal: AbortSignal): Promise<{ result: ToolResultBlock; halt: boolean }> {
    const fail = (content: string, halt = false) => ({
      result: { type: 'tool_result' as const, tool_use_id: use.id, content, is_error: true },
      halt,
    });

    const tool = tools.find((t) => t.name === use.name);
    if (!tool) {
      this.view.toolStart({ id: use.id, name: use.name, summary: '' });
      this.view.toolEnd({ id: use.id, status: 'error', display: `Unknown tool: ${use.name}` });
      return fail(`Unknown tool: ${use.name}. Available tools: ${tools.map((t) => t.name).join(', ')}`);
    }

    const invalid = validateInput(tool, use.input);
    let summary = '';
    try {
      summary = invalid ? '' : tool.summary(use.input);
    } catch {
      /* ignore */
    }
    this.view.toolStart({ id: use.id, name: tool.name, summary });
    if (invalid) {
      this.view.toolEnd({ id: use.id, status: 'error', display: invalid });
      return fail(invalid);
    }

    const ctx: ToolContext = { cwd: this.cwd, signal, readFiles: this.readFiles, agentId: this.id, runtime: this.opts.runtime };
    const permissions = this.opts.runtime.permissions;

    try {
      const ev = permissions.evaluate(tool, use.input, ctx);
      if (ev.type === 'deny') {
        this.view.toolEnd({ id: use.id, status: 'rejected', display: `Denied: ${ev.reason}` });
        return fail(`Permission denied: ${ev.reason}`);
      }
      if (ev.type === 'ask') {
        const preview = tool.preview ? await tool.preview(use.input, ctx) : '';
        const decision = await permissions.request(tool, use.input, ctx, preview, ev);
        if (!decision.allowed) {
          const shown = signal.aborted ? 'Interrupted' : permissions.interactive ? 'Rejected by user' : `Needs approval${ev.reason ? ` (${ev.reason})` : ''} — not allowed in non-interactive mode`;
          this.view.toolEnd({ id: use.id, status: 'rejected', display: shown });
          return fail(decision.reason, decision.halt);
        }
      }
      const output = await tool.run(use.input, ctx);
      const shown = tool.display ? tool.display(output, use.input) : previewLines(output);
      // 超大结果落盘，上下文中只保留预览和路径
      const { content, path } = this.opts.runtime.results.offload(tool.name, use.id, output);
      this.view.toolEnd({ id: use.id, status: 'ok', display: path ? `${shown}\n(full output saved to ${path})` : shown });
      return { result: { type: 'tool_result', tool_use_id: use.id, content }, halt: false };
    } catch (err) {
      if (signal.aborted) {
        this.view.toolEnd({ id: use.id, status: 'rejected', display: 'Interrupted' });
        return fail('Interrupted by user.', true);
      }
      const msg = errorMessage(err);
      this.view.toolEnd({ id: use.id, status: 'error', display: previewLines(msg, 3) });
      return fail(this.opts.runtime.results.offload(tool.name, use.id, msg).content);
    }
  }

  /** 让模型总结对话，用摘要替换历史 */
  async compact(signal: AbortSignal, instructions = ''): Promise<boolean> {
    if (this.messages.length < 2) return false;
    const messages: Message[] = this.messages.map((m) => ({ ...m }));
    const prompt = COMPACT_PROMPT + (instructions ? `\n\nAdditional instructions: ${instructions}` : '');
    const last = messages.at(-1);
    if (last?.role === 'user') {
      const prev: ContentBlock[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      last.content = [...prev, { type: 'text', text: prompt }];
    } else {
      messages.push({ role: 'user', content: prompt });
    }

    this.view.setStatus('Compacting conversation');
    try {
      const res = await this.opts.runtime.provider.chat({
        system: 'You are a helpful assistant that summarizes coding sessions accurately.',
        messages,
        tools: this.specs(this.opts.tools()), // 历史中包含 tool_use，需要带上工具定义
        maxTokens: this.opts.runtime.maxTokens,
        signal,
      });
      this.trackUsage(res);
      const summary = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
      if (!summary) throw new Error('Model returned an empty summary.');
      this.messages = [
        { role: 'user', content: `This session continues from an earlier conversation that was compacted. Summary:\n\n${summary}` },
        { role: 'assistant', content: 'Got it. I have the context from the summary and will continue from there.' },
      ];
      this.context.reset();
      this.view.setStatus(null);
      this.view.print(`✻ Conversation compacted (summary ≈ ${res.usage.outputTokens || estimateTextTokens(summary)} tokens)`, 'dim');
      return true;
    } catch (err) {
      if (signal.aborted) return false;
      throw err;
    } finally {
      this.view.setStatus(null);
    }
  }
}
