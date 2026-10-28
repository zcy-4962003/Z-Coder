// MCP 管理：连接配置中的所有服务器，把它们的 tools 转成 Agent 工具，resources 通过两个通用工具访问，prompts 作为斜杠命令

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool, type Tool } from '../tools/types.js';
import { McpClient, type McpServerConfig, type McpToolDef } from './client.js';

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function mcpName(server: string, item: string): string {
  return `mcp__${sanitize(server)}__${sanitize(item)}`.slice(0, 64);
}

/** 支持在配置中使用 ${VAR} 引用环境变量 */
function expandEnv<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_m, k: string) => process.env[k] ?? '') as T;
  if (Array.isArray(value)) return value.map(expandEnv) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)])) as T;
  return value;
}

/** 合并用户配置（~/.coder/config.json）与项目配置（<cwd>/.mcp.json，兼容 Claude Code 格式） */
export function loadMcpConfigs(cwd: string, fromConfig: Record<string, McpServerConfig> | undefined): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = { ...(fromConfig ?? {}) };
  const projectFile = join(cwd, '.mcp.json');
  if (existsSync(projectFile)) {
    try {
      const data = JSON.parse(readFileSync(projectFile, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
      Object.assign(merged, data.mcpServers ?? {});
    } catch (e) {
      throw new Error(`Invalid JSON in ${projectFile}: ${(e as Error).message}`);
    }
  }
  return expandEnv(merged);
}

function formatContent(result: any): string {
  const parts: string[] = [];
  for (const item of result?.content ?? []) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'image' || item.type === 'audio') parts.push(`[${item.type}: ${item.mimeType ?? 'unknown'}, ${String(item.data ?? '').length} base64 chars]`);
    else if (item.type === 'resource') parts.push(item.resource?.text ?? `[resource ${item.resource?.uri ?? ''} (${item.resource?.mimeType ?? 'binary'})]`);
    else if (item.type === 'resource_link') parts.push(`[resource link: ${item.uri}${item.name ? ` (${item.name})` : ''}]`);
    else parts.push(JSON.stringify(item));
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.join('\n') || '(empty result)';
}

function summarizeArgs(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s === '{}' ? '' : s.length > 100 ? s.slice(0, 100) + '…' : s;
}

export interface McpPromptCommand {
  name: string;
  description: string;
  args: string;
  server: string;
  prompt: string;
  argNames: string[];
}

export class McpManager {
  readonly clients: McpClient[];
  private cachedTools: Tool[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(configs: Record<string, McpServerConfig>, cwd: string, version: string) {
    this.clients = Object.entries(configs).map(([name, cfg]) => new McpClient(name, cfg, cwd, version, () => this.rebuild()));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 后台连接所有服务器，不阻塞启动 */
  startAll(): Promise<void> {
    return Promise.all(this.clients.map((c) => c.connect())).then(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
  }

  tools(): Tool[] {
    return this.cachedTools;
  }

  private connected(): McpClient[] {
    return this.clients.filter((c) => c.status === 'connected');
  }

  private rebuild(): void {
    const tools: Tool[] = [];
    for (const client of this.connected()) {
      for (const def of client.tools) tools.push(this.wrapTool(client, def));
    }
    if (this.connected().some((c) => c.hasResources)) tools.push(this.listResourcesTool(), this.readResourceTool());
    this.cachedTools = tools;
    for (const l of this.listeners) l();
  }

  private wrapTool(client: McpClient, def: McpToolDef): Tool {
    const schema = (def.inputSchema && typeof def.inputSchema === 'object' ? def.inputSchema : {}) as Record<string, unknown>;
    return defineTool<Record<string, unknown>>({
      name: mcpName(client.name, def.name),
      // 声明了只读的工具无需确认，其余按"执行"类处理
      kind: def.annotations?.readOnlyHint ? 'read' : 'exec',
      description: `[MCP server "${client.name}"] ${def.description ?? def.annotations?.title ?? def.name}`.slice(0, 2000),
      input_schema: { ...schema, type: 'object', properties: (schema.properties as Tool['input_schema']['properties']) ?? {} },
      summary: summarizeArgs,
      preview: (input) => `MCP ${client.name} → ${def.name}\n${JSON.stringify(input, null, 2).slice(0, 1500)}`,
      async run(input, ctx) {
        const result = await client.callTool(def.name, input, ctx.signal);
        const text = formatContent(result);
        if (result?.isError) throw new Error(text);
        return text;
      },
    });
  }

  private listResourcesTool(): Tool {
    return defineTool<{ server?: string }>({
      name: 'ListMcpResources',
      kind: 'read',
      description: 'List resources exposed by connected MCP servers (URI, name, description). Read one with ReadMcpResource.',
      input_schema: { type: 'object', properties: { server: { type: 'string', description: 'Only list resources of this server' } } },
      summary: (i) => i.server ?? 'all servers',
      run: async (input) => {
        const lines: string[] = [];
        for (const c of this.connected().filter((c) => c.hasResources && (!input.server || c.name === input.server))) {
          for (const r of c.resources) lines.push(`[${c.name}] ${r.uri}${r.name ? ` — ${r.name}` : ''}${r.description ? `: ${r.description}` : ''}`);
        }
        return lines.join('\n') || 'No resources available.';
      },
    });
  }

  private readResourceTool(): Tool {
    return defineTool<{ server: string; uri: string }>({
      name: 'ReadMcpResource',
      kind: 'read',
      description: 'Read a resource from an MCP server by URI.',
      input_schema: {
        type: 'object',
        properties: { server: { type: 'string', description: 'MCP server name' }, uri: { type: 'string', description: 'Resource URI' } },
        required: ['server', 'uri'],
      },
      summary: (i) => `${i.server}: ${i.uri}`,
      run: async (input, ctx) => {
        const client = this.connected().find((c) => c.name === input.server);
        if (!client) throw new Error(`MCP server "${input.server}" is not connected.`);
        const res = await client.readResource(input.uri, ctx.signal);
        const parts = (res?.contents ?? []).map((ct: any) =>
          typeof ct.text === 'string' ? ct.text : `[binary content ${ct.mimeType ?? ''}, ${String(ct.blob ?? '').length} base64 chars]`,
        );
        return parts.join('\n\n') || '(empty resource)';
      },
    });
  }

  promptCommands(): McpPromptCommand[] {
    return this.connected().flatMap((c) =>
      c.prompts.map((p) => ({
        name: mcpName(c.name, p.name),
        description: `[MCP ${c.name}] ${p.description ?? p.name}`,
        args: (p.arguments ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' '),
        server: c.name,
        prompt: p.name,
        argNames: (p.arguments ?? []).map((a) => a.name),
      })),
    );
  }

  /** 执行 MCP prompt 斜杠命令：参数按顺序对应，也支持 key=value；最后一个参数吸收剩余文本 */
  async renderPrompt(cmd: McpPromptCommand, argText: string): Promise<string> {
    const client = this.connected().find((c) => c.name === cmd.server);
    if (!client) throw new Error(`MCP server "${cmd.server}" is not connected.`);
    const args: Record<string, string> = {};
    const tokens = argText.trim() ? argText.trim().split(/\s+/) : [];
    const positional: string[] = [];
    for (const t of tokens) {
      const kv = /^([\w-]+)=(.*)$/.exec(t);
      if (kv && cmd.argNames.includes(kv[1]!)) args[kv[1]!] = kv[2]!;
      else positional.push(t);
    }
    const free = cmd.argNames.filter((n) => !(n in args));
    free.forEach((name, i) => {
      if (i >= positional.length) return;
      args[name] = i === free.length - 1 ? positional.slice(i).join(' ') : positional[i]!;
    });
    const res = await client.getPrompt(cmd.prompt, args);
    const text = (res?.messages ?? [])
      .map((m: any) => {
        const ct = m.content;
        const body = ct?.type === 'text' ? ct.text : ct?.type === 'resource' ? ct.resource?.text ?? '' : JSON.stringify(ct);
        return m.role === 'assistant' ? `(assistant) ${body}` : body;
      })
      .join('\n\n');
    if (!text.trim()) throw new Error(`MCP prompt "${cmd.prompt}" returned no content.`);
    return text;
  }

  /** 供系统提示词使用的服务器说明 */
  instructions(): string {
    return this.connected()
      .map((c) => `- ${c.name}${c.serverName ? ` (${c.serverName})` : ''}: ${c.tools.length} tools${c.hasResources ? `, ${c.resources.length} resources` : ''}${c.instructions ? `\n  ${c.instructions.slice(0, 800).replace(/\n/g, '\n  ')}` : ''}`)
      .join('\n');
  }
}
