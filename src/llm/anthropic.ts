// Anthropic Messages API（流式）

import type { ChatRequest, ChatResponse, ContentBlock, LLMProvider, StopReason } from './types.js';
import { postJson, readSSE } from './http.js';

type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string }
  | { type: 'ignored' };

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(
    public model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      // 在 system 上打缓存断点：tools + system 前缀会被缓存，降低多轮成本
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages,
      stream: true,
    };
    if (req.tools.length) body.tools = req.tools;

    const res = await postJson(
      `${this.baseUrl}/v1/messages`,
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body,
      req.signal,
    );

    const parts: Part[] = [];
    let stopReason: StopReason = 'other';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const ev of readSSE(res)) {
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (data.type) {
        case 'message_start': {
          const u = data.message?.usage ?? {};
          inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          outputTokens = u.output_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const b = data.content_block;
          if (b?.type === 'text') {
            parts[data.index] = { type: 'text', text: b.text ?? '' };
            if (b.text) req.onText?.(b.text);
          } else if (b?.type === 'tool_use') {
            parts[data.index] = { type: 'tool_use', id: b.id, name: b.name, json: '' };
          } else {
            parts[data.index] = { type: 'ignored' }; // thinking 等暂不处理
          }
          break;
        }
        case 'content_block_delta': {
          const p = parts[data.index];
          const d = data.delta;
          if (p?.type === 'text' && d?.type === 'text_delta') {
            p.text += d.text;
            req.onText?.(d.text);
          } else if (p?.type === 'tool_use' && d?.type === 'input_json_delta') {
            p.json += d.partial_json;
          }
          break;
        }
        case 'message_delta': {
          const r = data.delta?.stop_reason;
          stopReason = r === 'end_turn' || r === 'tool_use' || r === 'max_tokens' ? r : r === 'stop_sequence' ? 'end_turn' : 'other';
          if (data.usage?.output_tokens) outputTokens = data.usage.output_tokens;
          break;
        }
        case 'error':
          throw new Error(`Stream error: ${data.error?.message ?? ev.data}`);
      }
    }

    const content: ContentBlock[] = [];
    for (const p of parts) {
      if (!p) continue;
      if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
      if (p.type === 'tool_use') content.push({ type: 'tool_use', id: p.id, name: p.name, input: parseArgs(p.json) });
    }
    return { content, stopReason, usage: { inputTokens, outputTokens } };
  }
}

export function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return { __invalid_json__: json };
  }
}
