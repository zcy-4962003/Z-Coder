// 统一的内部消息格式（与 Anthropic Messages API 的结构保持一致，OpenAI 适配器负责转换）

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  signal: AbortSignal;
  /** 流式文本回调 */
  onText?: (text: string) => void;
}

export interface Usage {
  /** 本次请求的完整上下文 token 数（含缓存） */
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface ChatResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

export interface LLMProvider {
  readonly name: string;
  model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
