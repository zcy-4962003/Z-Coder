// 会话持久化：~/.coder/sessions/<项目名-hash>/<sessionId>.json，按项目隔离
// 支持列出、按序号/ID/名称恢复、重命名、分叉

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODER_HOME } from './config.js';
import type { Message } from './llm/types.js';
import { projectKey } from './results.js';

export function sessionDir(cwd: string): string {
  return join(CODER_HOME, 'sessions', projectKey(cwd));
}

function newId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

interface SessionFile {
  id?: string;
  name?: string;
  cwd: string;
  createdAt?: string;
  updatedAt: string;
  forkedFrom?: string;
  messages: Message[];
}

export interface SessionMeta {
  id: string;
  name: string;
  updatedAt: string;
  messageCount: number;
  /** 第一条用户消息，作为默认标题 */
  firstPrompt: string;
  forkedFrom?: string;
}

function firstPrompt(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
    if (text.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  return '';
}

export class Session {
  id: string;
  name = '';
  forkedFrom = '';
  createdAt = new Date().toISOString();

  constructor(
    private readonly cwd: string,
    id?: string,
  ) {
    this.id = id ?? newId();
  }

  get file(): string {
    return join(sessionDir(this.cwd), `${this.id}.json`);
  }

  /** 切换为另一个会话（保持对象引用不变） */
  adopt(other: Session): void {
    this.id = other.id;
    this.name = other.name;
    this.forkedFrom = other.forkedFrom;
    this.createdAt = other.createdAt;
  }

  /** 开始一个新会话（/clear） */
  renew(): void {
    this.id = newId();
    this.name = '';
    this.forkedFrom = '';
    this.createdAt = new Date().toISOString();
  }

  save(messages: Message[]): void {
    if (!messages.length && !this.name) return;
    try {
      mkdirSync(sessionDir(this.cwd), { recursive: true });
      const data: SessionFile = { id: this.id, cwd: this.cwd, createdAt: this.createdAt, updatedAt: new Date().toISOString(), messages };
      if (this.name) data.name = this.name;
      if (this.forkedFrom) data.forkedFrom = this.forkedFrom;
      writeFileSync(this.file, JSON.stringify(data, null, 1));
    } catch {
      /* 持久化失败不影响主流程 */
    }
  }

  rename(name: string, messages: Message[]): void {
    this.name = name.trim();
    this.save(messages);
  }

  /** 复制当前对话为新会话，并切换到新会话 */
  fork(messages: Message[], name?: string): { from: string } {
    this.save(messages);
    const from = this.id;
    const baseName = this.name || firstPrompt(messages).slice(0, 40) || 'session';
    this.id = newId();
    this.name = name?.trim() || `${baseName} (fork)`;
    this.forkedFrom = from;
    this.createdAt = new Date().toISOString();
    this.save(messages);
    return { from };
  }

  static list(cwd: string): SessionMeta[] {
    const dir = sessionDir(cwd);
    if (!existsSync(dir)) return [];
    const out: (SessionMeta & { t: number })[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = join(dir, f);
        const data = JSON.parse(readFileSync(p, 'utf8')) as SessionFile;
        const meta: SessionMeta & { t: number } = {
          id: f.replace(/\.json$/, ''),
          name: data.name ?? '',
          updatedAt: data.updatedAt,
          messageCount: data.messages?.length ?? 0,
          firstPrompt: firstPrompt(data.messages ?? []),
          t: statSync(p).mtimeMs,
        };
        if (data.forkedFrom) meta.forkedFrom = data.forkedFrom;
        out.push(meta);
      } catch {
        /* 跳过损坏的文件 */
      }
    }
    return out.sort((a, b) => b.t - a.t).map(({ t: _t, ...m }) => m);
  }

  /** 按序号（/sessions 列表中的编号，1 为最近）、ID（可只写前缀）或名称加载 */
  static load(cwd: string, ref: string): { session: Session; messages: Message[] } | null {
    const list = Session.list(cwd);
    const r = ref.trim();
    const lower = r.toLowerCase();
    const meta = /^\d+$/.test(r) && Number(r) >= 1 && Number(r) <= list.length && r.length < 4
      ? list[Number(r) - 1]
      : list.find((m) => m.id === r) ?? list.find((m) => m.name.toLowerCase() === lower) ?? list.find((m) => m.id.startsWith(r)) ?? list.find((m) => m.name.toLowerCase().includes(lower));
    if (!meta) return null;
    try {
      const data = JSON.parse(readFileSync(join(sessionDir(cwd), `${meta.id}.json`), 'utf8')) as SessionFile;
      const session = new Session(cwd, meta.id);
      session.name = data.name ?? '';
      session.forkedFrom = data.forkedFrom ?? '';
      session.createdAt = data.createdAt ?? data.updatedAt;
      return { session, messages: data.messages ?? [] };
    } catch {
      return null;
    }
  }

  static loadLatest(cwd: string): { session: Session; messages: Message[] } | null {
    return Session.list(cwd).length ? Session.load(cwd, '1') : null;
  }
}
