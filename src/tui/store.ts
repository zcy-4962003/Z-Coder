// 交互界面的状态容器：实现 AgentView 接收 Agent 事件，React 通过 useSyncExternalStore 订阅

import type { Message } from '../llm/types.js';
import type { PermissionAnswer, PermissionRequest, Prompter } from '../permissions.js';
import type { Question } from '../runtime.js';
import type { WorkerInfo } from '../subagents.js';
import type { AgentView, ToolEndEvent, ToolStartEvent, ToolStatus, Tone } from '../view.js';

export type HistoryItem =
  | { id: number; kind: 'banner' }
  | { id: number; kind: 'user'; text: string }
  /** continued=true 表示是同一段回复被拆分出的后续部分（不再显示 ● 前缀） */
  | { id: number; kind: 'assistant'; text: string; continued: boolean }
  | { id: number; kind: 'tool'; name: string; summary: string; status: ToolStatus; display: string }
  | { id: number; kind: 'info'; text: string; tone: Tone };

type NewItem = HistoryItem extends infer T ? (T extends HistoryItem ? Omit<T, 'id'> : never) : never;

export interface PendingPermission {
  kind: 'permission';
  id: number;
  req: PermissionRequest;
  resolve: (a: PermissionAnswer) => void;
}

export interface PendingQuestion {
  kind: 'question';
  id: number;
  question: Question;
  resolve: (answer: string) => void;
}

/** 需要用户响应的交互（权限确认 / 澄清问题），多个 worker 可能同时发起，排队逐个展示 */
export type Interaction = PendingPermission | PendingQuestion;

export interface QueueItem {
  text: string;
  origin: 'user' | 'loop' | 'goal';
  /** 内部生成的提示词在历史中显示的简短文字 */
  display?: string;
}

export interface UIState {
  /** 已完成的内容，交给 <Static> 渲染（只追加，不重绘） */
  history: HistoryItem[];
  /** 变化时重新挂载 <Static>（用于 /clear） */
  staticKey: number;
  /** 正在流式输出、尚未固定的回复文本 */
  streaming: string;
  streamingContinued: boolean;
  activeTools: ToolStartEvent[];
  status: { label: string; startedAt: number } | null;
  /** 当前展示的交互（队列首个） */
  interaction: Interaction | null;
  pendingInteractions: number;
  workers: WorkerInfo[];
  busy: boolean;
  /** 本次处理开始时间，用于加载动画计时 */
  busySince: number;
  queue: QueueItem[];
  hint: string | null;
  /** 仅用于触发重渲染（如权限模式变化） */
  tick: number;
}

const TEXT_FLUSH_MS = 40;

/** 找到可以安全切分的位置：最后一个不在代码块内的空行 */
function stableSplit(text: string): number {
  let idx = text.lastIndexOf('\n\n');
  while (idx > 0) {
    const fences = (text.slice(0, idx).match(/^\s*(```|~~~)/gm) ?? []).length;
    if (fences % 2 === 0) return idx;
    idx = text.lastIndexOf('\n\n', idx - 1);
  }
  return -1;
}

export class UIStore implements AgentView {
  private state: UIState = {
    history: [],
    staticKey: 0,
    streaming: '',
    streamingContinued: false,
    activeTools: [],
    status: null,
    interaction: null,
    pendingInteractions: 0,
    workers: [],
    busy: false,
    busySince: 0,
    queue: [],
    hint: null,
    tick: 0,
  };
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private pendingText = '';
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): UIState => this.state;

  set(patch: Partial<UIState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  refresh(): void {
    this.set({ tick: this.state.tick + 1 });
  }

  push(...items: NewItem[]): void {
    const added = items.map((it) => ({ ...it, id: this.nextId++ }) as HistoryItem);
    this.set({ history: [...this.state.history, ...added] });
  }

  clearHistory(): void {
    this.set({ history: [], staticKey: this.state.staticKey + 1, streaming: '' });
  }

  showHint(text: string, ms = 1500): void {
    clearTimeout(this.hintTimer);
    this.set({ hint: text });
    this.hintTimer = setTimeout(() => this.set({ hint: null }), ms);
  }

  // ------------------------------------------------------------ AgentView

  setStatus(label: string | null): void {
    this.set({ status: label ? { label, startedAt: Date.now() } : null });
  }

  textDelta(text: string): void {
    this.pendingText += text;
    // 节流：合并短时间内的增量，减少重绘
    this.flushTimer ??= setTimeout(() => this.flushText(false), TEXT_FLUSH_MS);
  }

  textEnd(): void {
    this.flushText(true);
  }

  private flushText(final: boolean): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    let text = this.state.streaming + this.pendingText;
    this.pendingText = '';
    let continued = this.state.streamingContinued;
    const items: NewItem[] = [];

    if (final) {
      if (text.trim()) items.push({ kind: 'assistant', text: text.trim(), continued });
      text = '';
      continued = false;
    } else {
      // 已完成的段落移入 Static，动态区只保留最后一段，避免长回复超出屏幕导致闪烁
      const cut = stableSplit(text);
      if (cut > 0) {
        const done = text.slice(0, cut).trim();
        if (done) {
          items.push({ kind: 'assistant', text: done, continued });
          continued = true;
        }
        text = text.slice(cut + 2);
      }
    }
    const added = items.map((it) => ({ ...it, id: this.nextId++ }) as HistoryItem);
    if (!added.length && text === this.state.streaming && continued === this.state.streamingContinued) return;
    this.set({ history: added.length ? [...this.state.history, ...added] : this.state.history, streaming: text, streamingContinued: continued });
  }

  toolStart(e: ToolStartEvent): void {
    this.set({ activeTools: [...this.state.activeTools, e] });
  }

  toolEnd(e: ToolEndEvent): void {
    const tool = this.state.activeTools.find((t) => t.id === e.id);
    const activeTools = this.state.activeTools.filter((t) => t.id !== e.id);
    const item: HistoryItem = {
      id: this.nextId++,
      kind: 'tool',
      name: tool?.name ?? '?',
      summary: tool?.summary ?? '',
      status: e.status,
      display: e.display,
    };
    this.set({ activeTools, history: [...this.state.history, item] });
  }

  print(text: string, tone: Tone = 'normal'): void {
    this.flushText(true);
    this.push({ kind: 'info', text, tone });
  }

  // ------------------------------------------------------------ 权限确认 / 澄清问题（排队展示）

  private interactions: Interaction[] = [];
  private interactionSeq = 0;

  private syncInteraction(): void {
    this.set({ interaction: this.interactions[0] ?? null, pendingInteractions: this.interactions.length });
  }

  private enqueue<T>(make: (id: number, resolve: (v: T) => void) => Interaction, signal: AbortSignal, onAbort: T): Promise<T> {
    return new Promise<T>((resolve) => {
      if (signal.aborted) return resolve(onAbort);
      const id = ++this.interactionSeq;
      const finish = (v: T) => {
        signal.removeEventListener('abort', abort);
        this.interactions = this.interactions.filter((i) => i.id !== id);
        this.syncInteraction();
        resolve(v);
      };
      const abort = () => finish(onAbort);
      signal.addEventListener('abort', abort, { once: true });
      this.interactions.push(make(id, finish));
      this.syncInteraction();
    });
  }

  prompter: Prompter = (req, signal) =>
    this.enqueue<PermissionAnswer>((id, resolve) => ({ kind: 'permission', id, req, resolve }), signal, { type: 'no' });

  askUser = (question: Question, signal: AbortSignal): Promise<string> =>
    this.enqueue<string>((id, resolve) => ({ kind: 'question', id, question, resolve }), signal, '');

  // ------------------------------------------------------------ 恢复会话时回放历史

  replay(messages: Message[]): void {
    const items: NewItem[] = [];
    for (const m of messages) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) {
          items.push(m.role === 'user' ? { kind: 'user', text: b.text.trim() } : { kind: 'assistant', text: b.text.trim(), continued: false });
        } else if (b.type === 'tool_use') {
          const summary = typeof b.input.file_path === 'string' ? b.input.file_path : typeof b.input.command === 'string' ? b.input.command : typeof b.input.pattern === 'string' ? b.input.pattern : '';
          items.push({ kind: 'tool', name: b.name, summary: summary.slice(0, 120), status: 'ok', display: '' });
        }
      }
    }
    this.push(...items);
  }
}
