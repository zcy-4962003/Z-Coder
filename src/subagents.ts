// 只读子 Agent（worker）：最多 3 个并发，在后台运行，只能读代码/搜索/上网，不能修改文件或执行命令
// root agent 通过 spawn_agent / wait_agent / close_agent 管理它们，并负责所有代码修改

import { Agent } from './agent.js';
import type { Runtime } from './runtime.js';
import { defineTool, type Tool } from './tools/types.js';
import { c, errorMessage } from './ui.js';
import type { AgentView } from './view.js';

export type WorkerStatus = 'running' | 'completed' | 'failed' | 'closed';

export interface WorkerInfo {
  id: string;
  description: string;
  task: string;
  status: WorkerStatus;
  startedAt: number;
  endedAt?: number;
  /** 当前/最近一次工具调用 */
  activity: string;
  toolCalls: number;
  result?: string;
  error?: string;
  /** root 是否已通过 wait_agent 取走结果 */
  consumed: boolean;
}

interface WorkerRecord {
  info: WorkerInfo;
  controller: AbortController;
  done: Promise<void>;
}

/** worker 不输出到终端，只记录活动供状态栏显示 */
class WorkerView implements AgentView {
  constructor(
    private readonly info: WorkerInfo,
    private readonly notify: () => void,
  ) {}
  setStatus(): void {}
  textDelta(): void {}
  textEnd(): void {}
  toolStart(e: { name: string; summary: string }): void {
    this.info.activity = e.summary ? `${e.name}(${e.summary.slice(0, 60)})` : e.name;
    this.info.toolCalls++;
    this.notify();
  }
  toolEnd(): void {}
  print(): void {}
}

export const MAX_WORKERS = 3;

export class WorkerManager {
  private seq = 0;
  private readonly records = new Map<string, WorkerRecord>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly runtime: Runtime,
    private readonly tools: () => Tool[],
    private readonly systemPrompt: () => string,
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit = (): void => {
    for (const l of this.listeners) l();
  };

  list(): WorkerInfo[] {
    return [...this.records.values()].map((r) => r.info);
  }

  running(): WorkerInfo[] {
    return this.list().filter((w) => w.status === 'running');
  }

  get(id: string): WorkerInfo | undefined {
    return this.records.get(id)?.info;
  }

  spawn(task: string, description: string): WorkerInfo {
    if (this.running().length >= MAX_WORKERS) {
      throw new Error(`At most ${MAX_WORKERS} workers can run at the same time. Wait for or close a running worker first.`);
    }
    const id = `worker-${++this.seq}`;
    const info: WorkerInfo = { id, description, task, status: 'running', startedAt: Date.now(), activity: 'starting', toolCalls: 0, consumed: false };
    const controller = new AbortController();
    const agent = new Agent({
      runtime: this.runtime,
      view: new WorkerView(info, this.emit),
      agentId: id,
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      maxTurns: 30,
    });
    const done = agent
      .run(task, controller.signal)
      .then(() => {
        if (info.status !== 'running') return;
        if (controller.signal.aborted) {
          info.status = 'closed';
          return;
        }
        info.status = 'completed';
        info.result = agent.lastAssistantText() || '(worker finished without a final answer)';
      })
      .catch((err) => {
        if (info.status !== 'running') return;
        info.status = controller.signal.aborted ? 'closed' : 'failed';
        info.error = errorMessage(err);
      })
      .finally(() => {
        info.endedAt = Date.now();
        info.activity = info.status;
        this.emit();
      });
    this.records.set(id, { info, controller, done });
    this.emit();
    return info;
  }

  close(id: string): WorkerInfo {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`Unknown worker: ${id}`);
    if (rec.info.status === 'running') {
      rec.info.status = 'closed';
      rec.info.endedAt = Date.now();
      rec.info.activity = 'closed';
      rec.controller.abort();
      this.emit();
    }
    return rec.info;
  }

  closeAll(): number {
    let n = 0;
    for (const w of this.running()) {
      this.close(w.id);
      n++;
    }
    return n;
  }

  /** 等待指定（默认：所有未取走结果的）worker 结束 */
  async wait(ids: string[] | undefined, mode: 'all' | 'any', timeoutMs: number, signal: AbortSignal): Promise<WorkerInfo[]> {
    const targets = ids?.length
      ? ids.map((id) => {
          const r = this.records.get(id);
          if (!r) throw new Error(`Unknown worker: ${id}`);
          return r;
        })
      : [...this.records.values()].filter((r) => !r.info.consumed);
    if (!targets.length) return [];

    const pending = targets.filter((r) => r.info.status === 'running').map((r) => r.done);
    if (pending.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      await Promise.race([
        mode === 'any' ? Promise.race(pending) : Promise.all(pending),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
        new Promise<void>((resolve) => {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    for (const r of targets) if (r.info.status !== 'running') r.info.consumed = true;
    this.emit();
    return targets.map((r) => r.info);
  }
}

// ------------------------------------------------------------------ root 使用的工具

function elapsed(w: WorkerInfo): string {
  return `${Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 1000)}s`;
}

export function formatWorker(w: WorkerInfo, withResult: boolean): string {
  const head = `${w.id} [${w.status}, ${elapsed(w)}, ${w.toolCalls} tool calls] ${w.description}`;
  if (!withResult) return head;
  if (w.status === 'completed') return `${head}\n${w.result}`;
  if (w.status === 'failed') return `${head}\nError: ${w.error}`;
  if (w.status === 'running') return `${head}\n(still running — currently: ${w.activity})`;
  return `${head}\n(closed before finishing)`;
}

function manager(ctx: { runtime: Runtime; agentId: string }): WorkerManager {
  if (ctx.agentId !== 'root') throw new Error('Workers cannot manage other workers.');
  if (!ctx.runtime.workers) throw new Error('Sub-agents are not available in this session.');
  return ctx.runtime.workers;
}

export const spawnAgentTool = defineTool<{ task: string; description?: string }>({
  name: 'spawn_agent',
  kind: 'read',
  description:
    `Start a read-only worker agent in the background (max ${MAX_WORKERS} concurrently) and return its id immediately. ` +
    'Workers can only read files, search code, and browse the web; they cannot edit files or run commands — you make all changes. ' +
    'Use workers to parallelize independent investigations (e.g. "find all usages of X", "understand how module Y works"). ' +
    'The task must be self-contained: workers do not see this conversation. Collect results with wait_agent.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Complete, self-contained instructions, including what to report back' },
      description: { type: 'string', description: 'Short label (3-8 words) shown to the user' },
    },
    required: ['task'],
  },
  summary: (i) => i.description ?? i.task.slice(0, 60),
  async run(input, ctx) {
    const w = manager(ctx).spawn(input.task, input.description?.trim() || input.task.slice(0, 60));
    return `Started ${w.id}: ${w.description}. Call wait_agent to collect its result.`;
  },
  display: (out) => out.split('.')[0] ?? out,
});

export const waitAgentTool = defineTool<{ ids?: string[]; mode?: 'all' | 'any'; timeout_seconds?: number }>({
  name: 'wait_agent',
  kind: 'read',
  description:
    'Wait for worker agents to finish and return their results. Without ids, waits for all workers whose results have not been collected yet. ' +
    'mode "all" (default) waits for every listed worker; "any" returns as soon as one finishes. Times out after timeout_seconds (default 300) ' +
    'and reports workers that are still running.',
  input_schema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Worker ids, e.g. ["worker-1"]' },
      mode: { type: 'string', enum: ['all', 'any'] },
      timeout_seconds: { type: 'integer', description: 'Max seconds to wait (default 300, max 1800)' },
    },
  },
  summary: (i) => (i.ids?.length ? i.ids.join(', ') : 'all'),
  async run(input, ctx) {
    const timeout = Math.min(Math.max(input.timeout_seconds ?? 300, 1), 1800) * 1000;
    const infos = await manager(ctx).wait(input.ids, input.mode ?? 'all', timeout, ctx.signal);
    if (ctx.signal.aborted) throw new Error('Interrupted while waiting for workers.');
    if (!infos.length) return 'No workers to wait for.';
    return infos.map((w) => formatWorker(w, true)).join('\n\n---\n\n');
  },
  display: (out) =>
    out === 'No workers to wait for.'
      ? out
      : out
          .split('\n\n---\n\n')
          .map((s) => s.split('\n')[0]!.replace(/^(worker-\d+) \[(\w+)/, (_m, id, st) => `${c.bold(id)} [${st === 'completed' ? c.green(st) : st === 'running' ? c.yellow(st) : c.red(st)}`))
          .join('\n'),
});

export const closeAgentTool = defineTool<{ id: string }>({
  name: 'close_agent',
  kind: 'read',
  description: 'Stop a running worker agent (e.g. when its result is no longer needed). Returns its final state.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Worker id, e.g. "worker-1"' } },
    required: ['id'],
  },
  summary: (i) => i.id,
  async run(input, ctx) {
    return formatWorker(manager(ctx).close(input.id), false);
  },
});
