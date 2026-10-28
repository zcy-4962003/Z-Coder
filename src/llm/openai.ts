// OpenAI 兼容的 Chat Completions API（流式）。适用于 OpenAI / DeepSeek / 通义千问 / Kimi / 本地 vLLM、Ollama 等

import type { ChatRequest, ChatResponse, ContentBlock, LLMProvider, Message, StopReason, ToolSpec } from './types.js';
import { postJson, readSSE } from './http.js';
import { parseArgs } from './anthropic.js';

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    public model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) body.tools = toOpenAITools(req.tools);

    const res = await postJson(`${this.baseUrl}/chat/completions`, { authorization: `Bearer ${this.apiKey}` }, body, req.signal);

    let text = '';
    const calls: PendingCall[] = [];
    let finish = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const ev of readSSE(res)) {
      if (ev.data === '[DONE]') break;
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (data.error) throw new Error(`Stream error: ${data.error.message ?? ev.data}`);
      if (data.usage) {
        inputTokens = data.usage.prompt_tokens ?? inputTokens;
        outputTokens = data.usage.completion_tokens ?? outputTokens;
      }
      const choice = data.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        req.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx: number = tc.index ?? calls.length;
        const call = (calls[idx] ??= { id: '', name: '', args: '' });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: 'text', text });
    calls.forEach((call, i) => {
      if (!call?.name) return;
      content.push({ type: 'tool_use', id: call.id || `call_${Date.now()}_${i}`, name: call.name, input: parseArgs(call.args) });
    });

    const hasTools = content.some((b) => b.type === 'tool_use');
    const stopReason: StopReason = hasTools ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'stop' ? 'end_turn' : 'other';
    return { content, stopReason, usage: { inputTokens, outputTokens } };
  }
}

function toOpenAITools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toOpenAIMessages(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const toolCalls = m.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
      );
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // tool 消息必须紧跟在 assistant 的 tool_calls 之后，所以先输出工具结果，再输出用户文本
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `[ERROR] ${b.content}` : b.content });
        }
      }
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}
