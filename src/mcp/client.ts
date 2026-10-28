// 极简 MCP 客户端（JSON-RPC 2.0），支持 stdio 与 Streamable HTTP 两种传输

import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readSSE } from '../llm/http.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; disabled?: boolean }
  | { type?: 'http' | 'streamable-http'; url: string; headers?: Record<string, string>; disabled?: boolean };

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}
export interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}
export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

type Json = any;
type NotificationHandler = (method: string, params: Json) => void;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`MCP error ${code}: ${message}`);
  }
}

interface Connection {
  request(method: string, params: Json, signal?: AbortSignal, timeoutMs?: number): Promise<Json>;
  notify(method: string, params?: Json): Promise<void>;
  close(): Promise<void>;
  protocolVersion?: string;
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

// ------------------------------------------------------------------ stdio

function quoteWin(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** stderr 可能来自 cmd.exe（系统代码页，如 GBK），不是合法 UTF-8 时尝试按 GBK 解码 */
function decodeOutput(buf: Buffer): string {
  const utf8 = buf.toString('utf8');
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

class StdioConnection implements Connection {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private buf = '';
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private stderrTail: string[] = [];
  private exitError: Error | null = null;

  constructor(
    private readonly cfg: Extract<McpServerConfig, { command: string }>,
    private readonly cwd: string,
    private readonly onNotify: NotificationHandler,
  ) {}

  start(): void {
    const args = this.cfg.args ?? [];
    const opts = {
      cwd: this.cfg.cwd ?? this.cwd,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    };
    // Windows 上 npx / uvx 等是 .cmd 脚本，需要经由 shell 启动
    const needsShell = process.platform === 'win32' && !/\.(exe|com)$/i.test(this.cfg.command);
    this.proc = needsShell
      ? spawn([this.cfg.command, ...args].map(quoteWin).join(' '), { ...opts, shell: true })
      : spawn(this.cfg.command, args, opts);

    this.proc.stdout!.setEncoding('utf8').on('data', (d: string) => this.onData(d));
    this.proc.stderr!.on('data', (d: Buffer) => {
      this.stderrTail.push(...decodeOutput(d).split(/\r?\n/).filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-20);
    });
    this.proc.on('error', (err) => this.fail(new Error(`Failed to start "${this.cfg.command}": ${err.message}`)));
    this.proc.on('exit', (code) => this.fail(new Error(`Server process exited (code ${code})${this.stderrTail.length ? `: ${this.stderrTail.slice(-5).join(' | ')}` : ''}`)));
  }

  private fail(err: Error): void {
    this.exitError ??= err;
    for (const p of this.pending.values()) p.reject(this.exitError);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 忽略非 JSON 的日志输出
      }
      this.handle(msg);
    }
  }

  private handle(msg: Json): void {
    if (msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      this.write(answerServerRequest(msg, this.cwd));
    } else if (msg.method) {
      this.onNotify(msg.method, msg.params);
    }
  }

  private write(msg: Json): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  request(method: string, params: Json, signal?: AbortSignal, timeoutMs = 60000): Promise<Json> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = ++this.seq;
    const sig = timeoutSignal(signal, timeoutMs);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } });
        reject(signal?.aborted ? new Error('Cancelled') : new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      };
      sig.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => (sig.removeEventListener('abort', onAbort), resolve(v)),
        reject: (e) => (sig.removeEventListener('abort', onAbort), reject(e)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async notify(method: string, params?: Json): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    proc.stdin?.end();
    if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else proc.kill();
  }
}

// ------------------------------------------------------------------ Streamable HTTP

class HttpConnection implements Connection {
  private seq = 0;
  private sessionId: string | undefined;
  protocolVersion?: string;

  constructor(
    private readonly cfg: Extract<McpServerConfig, { url: string }>,
    private readonly cwd: string,
    private readonly onNotify: NotificationHandler,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  private async post(body: Json, signal: AbortSignal): Promise<Response> {
    const res = await fetch(this.cfg.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return res;
  }

  async request(method: string, params: Json, signal?: AbortSignal, timeoutMs = 60000): Promise<Json> {
    const id = ++this.seq;
    const sig = timeoutSignal(signal, timeoutMs);
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, sig);
    if (!res.ok) {
      const ct = res.headers.get('content-type') ?? '';
      const body = await res.text().catch(() => '');
      if (ct.includes('text/html') || /^\s*<!doctype html/i.test(body)) {
        throw new Error(
          `MCP HTTP ${res.status}: the server returned an HTML page instead of an MCP response. ` +
            `Is "${this.cfg.url}" actually an MCP (Streamable HTTP) endpoint? If it's a placeholder, remove or fix the server in "mcpServers".`,
        );
      }
      throw new Error(`MCP HTTP ${res.status}: ${body.slice(0, 300)}`);
    }

    const type = res.headers.get('content-type') ?? '';
    const pick = (msg: Json): Json | undefined => {
      if (Array.isArray(msg)) {
        for (const m of msg) {
          const r = pick(m);
          if (r !== undefined) return r;
        }
        return undefined;
      }
      if (msg?.id === id && ('result' in msg || 'error' in msg)) {
        if (msg.error) throw new RpcError(msg.error.code, msg.error.message);
        return msg.result ?? {};
      }
      if (msg?.method && msg.id !== undefined) void this.post(answerServerRequest(msg, this.cwd), sig).catch(() => {});
      else if (msg?.method) this.onNotify(msg.method, msg.params);
      return undefined;
    };

    if (type.includes('text/event-stream')) {
      for await (const ev of readSSE(res)) {
        let msg: Json;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const r = pick(msg);
        if (r !== undefined) return r;
      }
      throw new Error(`MCP stream ended without a response to "${method}"`);
    }
    const r = pick(await res.json());
    if (r === undefined) throw new Error(`MCP response did not contain a result for "${method}"`);
    return r;
  }

  async notify(method: string, params?: Json): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, AbortSignal.timeout(15000));
    await res.body?.cancel().catch(() => {});
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await fetch(this.cfg.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
}

/** 响应服务端发起的请求（ping / roots/list），其它一律返回"未实现" */
function answerServerRequest(msg: Json, cwd: string): Json {
  if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  if (msg.method === 'roots/list') return { jsonrpc: '2.0', id: msg.id, result: { roots: [{ uri: pathToFileURL(cwd).href, name: 'workspace' }] } };
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not supported by client: ${msg.method}` } };
}

// ------------------------------------------------------------------ 客户端

export type McpStatus = 'connecting' | 'connected' | 'failed' | 'disabled';

export class McpClient {
  status: McpStatus = 'connecting';
  error = '';
  tools: McpToolDef[] = [];
  resources: McpResourceDef[] = [];
  prompts: McpPromptDef[] = [];
  instructions = '';
  serverName = '';
  private conn: Connection | null = null;
  private capabilities: Json = {};

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    private readonly cwd: string,
    private readonly version: string,
    private readonly onChange: () => void,
  ) {
    if (config.disabled) this.status = 'disabled';
  }

  get transport(): 'stdio' | 'http' {
    return 'url' in this.config ? 'http' : 'stdio';
  }

  async connect(): Promise<void> {
    if (this.status === 'disabled') return;
    const onNotify: NotificationHandler = (method) => {
      if (method === 'notifications/tools/list_changed') void this.refresh('tools');
      if (method === 'notifications/resources/list_changed') void this.refresh('resources');
      if (method === 'notifications/prompts/list_changed') void this.refresh('prompts');
    };
    try {
      if ('url' in this.config) {
        this.conn = new HttpConnection(this.config, this.cwd, onNotify);
      } else {
        const stdio = new StdioConnection(this.config, this.cwd, onNotify);
        stdio.start();
        this.conn = stdio;
      }
      const init = await this.conn.request(
        'initialize',
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'coder', version: this.version } },
        undefined,
        60000,
      );
      this.conn.protocolVersion = init.protocolVersion ?? MCP_PROTOCOL_VERSION;
      this.capabilities = init.capabilities ?? {};
      this.instructions = typeof init.instructions === 'string' ? init.instructions : '';
      this.serverName = init.serverInfo?.name ?? '';
      await this.conn.notify('notifications/initialized');
      await Promise.all([this.refresh('tools', false), this.refresh('resources', false), this.refresh('prompts', false)]);
      this.status = 'connected';
    } catch (err) {
      this.status = 'failed';
      this.error = err instanceof Error ? err.message : String(err);
      await this.conn?.close().catch(() => {});
    }
    this.onChange();
  }

  private async listAll<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.conn!.request(method, cursor ? { cursor } : {});
      out.push(...((res?.[key] as T[]) ?? []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  private async refresh(kind: 'tools' | 'resources' | 'prompts', emit = true): Promise<void> {
    if (!this.conn || !this.capabilities[kind]) return;
    try {
      if (kind === 'tools') this.tools = await this.listAll<McpToolDef>('tools/list', 'tools');
      if (kind === 'resources') this.resources = await this.listAll<McpResourceDef>('resources/list', 'resources');
      if (kind === 'prompts') this.prompts = await this.listAll<McpPromptDef>('prompts/list', 'prompts');
    } catch {
      /* 列表获取失败不影响其它能力 */
    }
    if (emit) this.onChange();
  }

  get hasResources(): boolean {
    return !!this.capabilities.resources;
  }

  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Json> {
    return this.conn!.request('tools/call', { name, arguments: args }, signal, 600000);
  }

  readResource(uri: string, signal: AbortSignal): Promise<Json> {
    return this.conn!.request('resources/read', { uri }, signal);
  }

  getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<Json> {
    return this.conn!.request('prompts/get', { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    await this.conn?.close().catch(() => {});
  }
}
