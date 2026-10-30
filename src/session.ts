// 会话持久化：~/.coder/sessions/<项目名-hash>/<sessionId>.jsonl，按项目隔离
// 每次变更都以追加写入的方式记录为一行 JSON 事件；每个事件都带 sessionId / ts / cwd / uuid / parentUuid
// 支持列出、按序号/ID/名称恢复、重命名、分叉，以及过期会话清理和手动删除

import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CODER_HOME } from './config.js';
import type { Message } from './llm/types.js';
import { projectKey } from './results.js';

/** 会话默认保留天数；设为 0 可关闭自动清理 */
export const SESSION_TTL_DAYS = 30;

export function sessionDir(cwd: string): string {
  return join(CODER_HOME, 'sessions', projectKey(cwd));
}

function sessionsRoot(): string {
  return join(CODER_HOME, 'sessions');
}

export function sessionTtlDays(): number {
  const raw = Number(process.env.CODER_SESSION_TTL_DAYS);
  return Number.isFinite(raw) && raw >= 0 ? raw : SESSION_TTL_DAYS;
}

function newId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

function newUuid(): string {
  return randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- 事件格式

export interface SessionEventBase {
  /** 事件类型 */
  type: SessionEventType;
  /** 事件所属会话 */
  sessionId: string;
  /** 事件写入时间（ISO 8601） */
  ts: string;
  /** 事件产生时的工作目录 */
  cwd: string;
  /** 事件自身的唯一 ID */
  uuid: string;
  /** 父事件（消息链上一条）的 uuid，首条为 null */
  parentUuid: string | null;
}

export type SessionEventType = 'session_start' | 'message' | 'reset' | 'rename';

export interface SessionStartEvent extends SessionEventBase {
  type: 'session_start';
  name: string | null;
  /** 分叉来源：父会话 ID 与分叉点消息的 uuid */
  forkedFrom: { sessionId: string; messageUuid: string | null } | null;
}

export interface MessageEvent extends SessionEventBase {
  type: 'message';
  message: Message;
}

export interface StoredMessage {
  uuid: string;
  parentUuid: string | null;
  ts: string;
  message: Message;
}

/** 历史被压缩或裁剪时，用一次全量快照替换此前的消息链 */
export interface ResetEvent extends SessionEventBase {
  type: 'reset';
  messages: StoredMessage[];
}

export interface RenameEvent extends SessionEventBase {
  type: 'rename';
  name: string;
}

export type SessionEvent = SessionStartEvent | MessageEvent | ResetEvent | RenameEvent;

// ---------------------------------------------------------------- 元信息

export interface SessionMeta {
  id: string;
  name: string;
  updatedAt: string;
  messageCount: number;
  /** 第一条用户消息，作为默认标题 */
  firstPrompt: string;
  /** 分叉来源的会话 ID */
  forkedFrom?: string;
  /** 分叉点消息的 uuid */
  forkPoint?: string;
}

interface ReplayState {
  messages: Message[];
  uuids: string[];
  parents: (string | null)[];
  name: string;
  forkedFrom: string;
  forkPoint: string;
  createdAt: string;
  updatedAt: string;
  lastUuid: string | null;
  events: number;
}

function emptyState(): ReplayState {
  return {
    messages: [],
    uuids: [],
    parents: [],
    name: '',
    forkedFrom: '',
    forkPoint: '',
    createdAt: '',
    updatedAt: '',
    lastUuid: null,
    events: 0,
  };
}

function firstPrompt(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
    if (text.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  return '';
}

function sameMessage(a: Message, b: Message): boolean {
  // 引用相同即视为未变（就地折叠等修改不重复落盘）；否则按内容比较
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------- 重放

function replay(file: string): ReplayState | null {
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const st = emptyState();
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    let ev: SessionEvent;
    try {
      ev = JSON.parse(raw) as SessionEvent;
    } catch {
      continue; // 损坏的行直接跳过
    }
    if (!ev || typeof ev !== 'object') continue;
    st.events++;
    if (typeof ev.ts === 'string') st.updatedAt = ev.ts;
    switch (ev.type) {
      case 'session_start':
        if (!st.createdAt) st.createdAt = ev.ts;
        if (typeof ev.name === 'string' && ev.name) st.name = ev.name;
        if (ev.forkedFrom) {
          st.forkedFrom = ev.forkedFrom.sessionId;
          st.forkPoint = ev.forkedFrom.messageUuid ?? '';
        }
        break;
      case 'message':
        if (!ev.message) break;
        st.messages.push(ev.message);
        st.uuids.push(ev.uuid);
        st.parents.push(ev.parentUuid ?? null);
        st.lastUuid = ev.uuid;
        break;
      case 'reset': {
        const stored = Array.isArray(ev.messages) ? ev.messages : [];
        st.messages = stored.map((m) => m.message);
        st.uuids = stored.map((m) => m.uuid);
        st.parents = stored.map((m) => m.parentUuid ?? null);
        st.lastUuid = stored.length ? stored[stored.length - 1]!.uuid : ev.uuid;
        break;
      }
      case 'rename':
        if (typeof ev.name === 'string') st.name = ev.name;
        break;
      default:
        break;
    }
  }
  return st;
}

/** 序号（列表中的编号，1 为最近）、ID（可只写前缀）或名称 → 元信息 */
function matchRef(list: SessionMeta[], ref: string): SessionMeta | null {
  const r = ref.trim();
  if (!r) return null;
  const lower = r.toLowerCase();
  const n = Number(r);
  if (/^\d+$/.test(r) && n >= 1 && n <= list.length && r.length < 4) return list[n - 1]!;
  return (
    list.find((m) => m.id === r) ??
    list.find((m) => m.name.toLowerCase() === lower) ??
    list.find((m) => m.id.startsWith(r)) ??
    list.find((m) => m.name.toLowerCase().includes(lower)) ??
    null
  );
}

// ---------------------------------------------------------------- Session

export class Session {
  id: string;
  name = '';
  forkedFrom = '';
  forkPoint = '';
  createdAt = nowIso();

  private messages: Message[] = [];
  private uuids: string[] = [];
  private parents: (string | null)[] = [];
  private lastUuid: string | null = null;
  private started = false;
  private ready = false;

  constructor(
    private readonly cwd: string,
    id?: string,
  ) {
    this.id = id ?? newId();
  }

  get file(): string {
    return join(sessionDir(this.cwd), `${this.id}.jsonl`);
  }

  /** 首次使用时从磁盘重放已有事件（恢复会话后继续追加） */
  private loadState(): void {
    if (this.ready) return;
    this.ready = true;
    const st = replay(this.file);
    if (!st) return;
    this.apply(st);
    this.started = true;
  }

  private apply(st: ReplayState): void {
    // 与调用方（Agent）持有的数组解耦：Agent 会在自己的数组里 push 新消息
    this.messages = st.messages.slice();
    this.uuids = st.uuids.slice();
    this.parents = st.parents.slice();
    this.lastUuid = st.lastUuid;
    this.name = st.name;
    this.forkedFrom = st.forkedFrom;
    this.forkPoint = st.forkPoint;
    this.createdAt = st.createdAt || st.updatedAt || this.createdAt;
    this.ready = true;
  }

  private base(parentUuid: string | null, uuid = newUuid()): Omit<SessionEventBase, 'type'> {
    return { sessionId: this.id, ts: nowIso(), cwd: this.cwd, uuid, parentUuid };
  }

  private startEvent(): SessionStartEvent {
    return {
      ...this.base(null),
      type: 'session_start',
      name: this.name || null,
      forkedFrom: this.forkedFrom ? { sessionId: this.forkedFrom, messageUuid: this.forkPoint || null } : null,
    };
  }

  private messageEvent(message: Message, uuid: string, parentUuid: string | null): MessageEvent {
    return { ...this.base(parentUuid, uuid), type: 'message', message };
  }

  /**
   * 计算增量事件：
   * - 新会话写入 session_start + 每条 message
   * - 历史只在末尾增长时追加新 message
   * - 压缩 / 裁剪导致前缀变化时写入一次 reset 全量快照
   */
  private syncMessages(messages: Message[]): { events: SessionEvent[]; uuids: string[]; parents: (string | null)[]; last: string | null } {
    const events: SessionEvent[] = [];
    const uuids = this.uuids.slice();
    const parents = this.parents.slice();
    let last = this.lastUuid;

    const prefixOk =
      this.started &&
      messages.length >= this.messages.length &&
      this.messages.every((m, i) => sameMessage(m, messages[i]!));

    if (!this.started) {
      events.push(this.startEvent());
      uuids.length = 0;
      parents.length = 0;
      last = null;
      for (const message of messages) {
        const uuid = newUuid();
        events.push(this.messageEvent(message, uuid, last));
        uuids.push(uuid);
        parents.push(last);
        last = uuid;
      }
    } else if (!prefixOk) {
      // 历史被压缩或裁剪：用快照事件替换整条消息链
      const stored: StoredMessage[] = [];
      let parent = this.lastUuid;
      for (const message of messages) {
        const uuid = newUuid();
        stored.push({ uuid, parentUuid: parent, ts: nowIso(), message });
        parent = uuid;
      }
      const tail = stored.length ? stored[stored.length - 1]!.uuid : newUuid();
      events.push({ ...this.base(this.lastUuid, tail), type: 'reset', messages: stored });
      uuids.length = 0;
      parents.length = 0;
      for (const m of stored) {
        uuids.push(m.uuid);
        parents.push(m.parentUuid);
      }
      last = stored.length ? tail : this.lastUuid;
    } else {
      for (let i = this.messages.length; i < messages.length; i++) {
        const uuid = newUuid();
        const message = messages[i]!;
        events.push(this.messageEvent(message, uuid, last));
        uuids.push(uuid);
        parents.push(last);
        last = uuid;
      }
    }

    return { events, uuids, parents, last };
  }

  private write(events: SessionEvent[]): void {
    if (!events.length) return;
    mkdirSync(sessionDir(this.cwd), { recursive: true });
    // 上次写入若中断在半个事件上，补一个换行，避免新事件与残留内容粘连
    let prefix = '';
    try {
      const { size } = statSync(this.file);
      if (size > 0) {
        const buf = Buffer.alloc(1);
        const fd = openSync(this.file, 'r');
        try {
          readSync(fd, buf, 0, 1, size - 1);
        } finally {
          closeSync(fd);
        }
        if (buf[0] !== 0x0a) prefix = '\n';
      }
    } catch {
      /* 文件尚不存在 */
    }
    appendFileSync(this.file, prefix + events.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    this.started = true;
  }

  private commit(messages: Message[], st: { uuids: string[]; parents: (string | null)[]; last: string | null }): void {
    this.messages = messages.slice();
    this.uuids = st.uuids;
    this.parents = st.parents;
    this.lastUuid = st.last;
    this.started = true;
    this.ready = true;
  }

  /** 切换为另一个会话（保持对象引用不变） */
  adopt(other: Session): void {
    other.loadState();
    this.id = other.id;
    this.name = other.name;
    this.forkedFrom = other.forkedFrom;
    this.forkPoint = other.forkPoint;
    this.createdAt = other.createdAt;
    this.messages = other.messages.slice();
    this.uuids = other.uuids.slice();
    this.parents = other.parents.slice();
    this.lastUuid = other.lastUuid;
    this.started = other.started;
    this.ready = true;
  }

  /** 开始一个新会话（/clear） */
  renew(): void {
    this.id = newId();
    this.name = '';
    this.forkedFrom = '';
    this.forkPoint = '';
    this.createdAt = nowIso();
    this.messages = [];
    this.uuids = [];
    this.parents = [];
    this.lastUuid = null;
    this.started = false;
    this.ready = true;
  }

  /** 追加写入增量事件；内容未变化时不写盘 */
  save(messages: Message[]): void {
    this.loadState();
    if (!messages.length && !this.name && !this.forkedFrom && !this.started) return;
    const st = this.syncMessages(messages);
    if (!st.events.length) return;
    try {
      this.write(st.events);
    } catch {
      return; // 持久化失败不影响主流程
    }
    this.commit(messages, st);
  }

  rename(name: string, messages: Message[]): void {
    this.loadState();
    const trimmed = name.trim();
    const st = this.syncMessages(messages);
    if (trimmed !== this.name) {
      this.name = trimmed;
      st.events.push({ ...this.base(st.last), type: 'rename', name: trimmed });
    }
    if (!st.events.length) return;
    try {
      this.write(st.events);
    } catch {
      return;
    }
    this.commit(messages, st);
  }

  /** 复制当前对话为新会话，并切换到新会话；消息 uuid 与父链保持延续 */
  fork(messages: Message[], name?: string): { from: string } {
    this.save(messages);
    const from = this.id;
    const forkPoint = this.lastUuid;
    const baseName = this.name || firstPrompt(messages).slice(0, 40) || 'session';

    const copiedMessages = messages.slice();
    const copiedUuids = this.uuids.slice();
    const copiedParents = this.parents.slice();
    while (copiedUuids.length < copiedMessages.length) {
      copiedParents.push(copiedUuids.length ? copiedUuids[copiedUuids.length - 1]! : null);
      copiedUuids.push(newUuid());
    }

    this.id = newId();
    this.name = name?.trim() || `${baseName} (fork)`;
    this.forkedFrom = from;
    this.forkPoint = forkPoint ?? '';
    this.createdAt = nowIso();
    this.messages = [];
    this.uuids = [];
    this.parents = [];
    this.lastUuid = null;
    this.started = false;
    this.ready = true;

    const events: SessionEvent[] = [this.startEvent()];
    for (let i = 0; i < copiedMessages.length; i++) {
      const uuid = copiedUuids[i]!;
      events.push(this.messageEvent(copiedMessages[i]!, uuid, copiedParents[i] ?? null));
    }
    try {
      this.write(events);
    } catch {
      /* ignore */
    }
    this.messages = copiedMessages;
    this.uuids = copiedUuids;
    this.parents = copiedParents;
    this.lastUuid = copiedMessages.length ? copiedUuids[copiedUuids.length - 1]! : null;
    this.started = true;
    return { from };
  }

  static list(cwd: string): SessionMeta[] {
    const dir = sessionDir(cwd);
    if (!existsSync(dir)) return [];
    const out: (SessionMeta & { t: number })[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      try {
        const st = replay(p);
        if (!st || !st.events) continue;
        const mtime = statSync(p).mtime;
        const meta: SessionMeta & { t: number } = {
          id: f.slice(0, -'.jsonl'.length),
          name: st.name,
          updatedAt: st.updatedAt || mtime.toISOString(),
          messageCount: st.messages.length,
          firstPrompt: firstPrompt(st.messages),
          t: mtime.getTime(),
        };
        if (st.forkedFrom) meta.forkedFrom = st.forkedFrom;
        if (st.forkPoint) meta.forkPoint = st.forkPoint;
        out.push(meta);
      } catch {
        /* 跳过损坏的文件 */
      }
    }
    return out.sort((a, b) => b.t - a.t).map(({ t: _t, ...m }) => m);
  }

  /** 按序号、ID 前缀或名称找到会话元信息 */
  static find(cwd: string, ref: string): SessionMeta | null {
    return matchRef(Session.list(cwd), ref);
  }

  /** 按序号（/sessions 列表中的编号，1 为最近）、ID（可只写前缀）或名称加载 */
  static load(cwd: string, ref: string): { session: Session; messages: Message[] } | null {
    const meta = Session.find(cwd, ref);
    if (!meta) return null;
    const st = replay(join(sessionDir(cwd), `${meta.id}.jsonl`));
    if (!st) return null;
    const session = new Session(cwd, meta.id);
    session.apply(st);
    session.started = true;
    return { session, messages: st.messages };
  }

  static loadLatest(cwd: string): { session: Session; messages: Message[] } | null {
    return Session.list(cwd).length ? Session.load(cwd, '1') : null;
  }

  /** 删除一个会话文件，返回被删除会话的元信息 */
  static remove(cwd: string, ref: string): SessionMeta | null {
    const meta = Session.find(cwd, ref);
    if (!meta) return null;
    try {
      rmSync(join(sessionDir(cwd), `${meta.id}.jsonl`), { force: true });
    } catch {
      return null;
    }
    return meta;
  }

  /** 清理所有项目中超过保留期的会话文件，返回删除数量 */
  static cleanup(keepDays = sessionTtlDays()): number {
    if (!(keepDays > 0)) return 0;
    const root = sessionsRoot();
    if (!existsSync(root)) return 0;
    const cutoff = Date.now() - keepDays * 86400_000;
    let removed = 0;
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(dir, f);
        try {
          if (statSync(p).mtimeMs < cutoff) {
            rmSync(p, { force: true });
            removed++;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }
}
