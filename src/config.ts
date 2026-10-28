// 配置优先级：命令行参数 > 环境变量 > ~/.coder/config.json > 默认值

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from './llm/types.js';
import type { McpServerConfig } from './mcp/client.js';
import type { WebSearchConfig } from './tools/web.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { OpenAIProvider } from './llm/openai.js';

export type ProviderName = 'anthropic' | 'openai';

export interface Config {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  /** 上下文窗口大小（token），超过 60% 折叠旧工具结果，超过 80% 自动压缩 */
  contextLimit: number;
  /** 工具结果超过该字符数时落盘 */
  toolResultLimit: number;
  mcpServers: Record<string, McpServerConfig>;
  webSearch: WebSearchConfig;
}

export const CODER_HOME = join(homedir(), '.coder');
export const CONFIG_FILE = join(CODER_HOME, 'config.json');

interface FileConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  contextLimit?: number;
  toolResultLimit?: number;
  mcpServers?: Record<string, McpServerConfig>;
  webSearch?: { provider?: string; apiKey?: string };
}

function loadFileConfig(): FileConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as FileConfig;
  } catch (e) {
    throw new Error(`Invalid JSON in ${CONFIG_FILE}: ${(e as Error).message}`);
  }
}

export function loadConfig(overrides: { provider?: string | undefined; model?: string | undefined }): Config {
  const file = loadFileConfig();
  const env = process.env;

  const provider =
    overrides.provider ??
    env.CODER_PROVIDER ??
    file.provider ??
    (env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : 'anthropic');
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`Unknown provider "${provider}". Use "anthropic" or "openai".`);
  }
  const isAnthropic = provider === 'anthropic';

  const apiKey = env.CODER_API_KEY ?? (isAnthropic ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) ?? file.apiKey ?? '';
  const baseUrl = (
    env.CODER_BASE_URL ??
    (isAnthropic ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL) ??
    file.baseUrl ??
    (isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  ).replace(/\/+$/, '');
  const model = overrides.model ?? env.CODER_MODEL ?? file.model ?? (isAnthropic ? 'claude-sonnet-4-5' : 'gpt-4o');
  const maxTokens = Number(env.CODER_MAX_TOKENS) || file.maxTokens || 8192;
  const contextLimit = Number(env.CODER_CONTEXT_LIMIT) || file.contextLimit || (isAnthropic ? 200_000 : 128_000);
  const toolResultLimit = Number(env.CODER_TOOL_RESULT_LIMIT) || file.toolResultLimit || 20000;
  const wsProvider = (env.CODER_WEB_SEARCH ?? file.webSearch?.provider ?? 'auto').toLowerCase();
  if (!['auto', 'tavily', 'brave', 'bing'].includes(wsProvider)) {
    throw new Error(`Unknown webSearch.provider "${wsProvider}". Use auto, tavily, brave or bing.`);
  }
  const webSearch: WebSearchConfig = { provider: wsProvider as WebSearchConfig['provider'] };
  if (file.webSearch?.apiKey) webSearch.apiKey = file.webSearch.apiKey;

  return { provider, model, apiKey, baseUrl, maxTokens, contextLimit, toolResultLimit, mcpServers: file.mcpServers ?? {}, webSearch };
}

export function createProvider(cfg: Config): LLMProvider {
  if (!cfg.apiKey) {
    const envName = cfg.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    throw new Error(`Missing API key. Set ${envName} (or CODER_API_KEY), or add "apiKey" to ${CONFIG_FILE}.`);
  }
  return cfg.provider === 'anthropic'
    ? new AnthropicProvider(cfg.model, cfg.apiKey, cfg.baseUrl)
    : new OpenAIProvider(cfg.model, cfg.apiKey, cfg.baseUrl);
}
