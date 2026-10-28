// 交互逻辑：处理用户输入、消息队列、中断、Goal 自动推进、Loop 调度、会话切换、退出

import { relative, sep } from 'node:path';
import type { Agent } from '../agent.js';
import { commandList, handleCommand, type CommandInfo } from '../commands.js';
import type { Message } from '../llm/types.js';
import { LoopManager } from '../loop.js';
import type { Runtime } from '../runtime.js';
import type { Session } from '../session.js';
import { walk } from '../tools/fsutil.js';
import { errorMessage } from '../ui.js';
import type { QueueItem, UIStore } from './store.js';

type Outcome = 'ok' | 'error' | 'aborted';

export class Controller {
  readonly loop = new LoopManager();
  private abort: AbortController | null = null;
  private lastCtrlC = 0;
  private files: string[] = [];
  private filesLoadedAt = 0;
  private loadingFiles = false;
  private interrupted = false;

  constructor(
    readonly store: UIStore,
    readonly agent: Agent,
    readonly runtime: Runtime,
    readonly session: Session,
    private readonly exitApp: () => void,
  ) {
    this.loop.onFire = (prompt, n) => this.enqueue({ text: prompt, origin: 'loop', display: `↻ Loop iteration ${n}: ${prompt}` });
    const refresh = () => this.store.refresh();
    this.loop.onChange(refresh);
    runtime.goal.onChange(refresh);
    runtime.mcp.onChange(refresh);
    runtime.workers?.onChange(() => this.store.set({ workers: runtime.workers!.list() }));
  }

  commands(): CommandInfo[] {
    return commandList(this.runtime);
  }

  submit = (text: string): void => this.enqueue({ text, origin: 'user' });

  private enqueue(item: QueueItem): void {
    const st = this.store.getState();
    if (st.busy) {
      this.store.set({ queue: [...st.queue, item] });
      return;
    }
    void this.process(item);
  }

  private async process(first: QueueItem): Promise<void> {
    this.store.set({ busy: true, busySince: Date.now() });
    let item: QueueItem | undefined = first;
    while (item) {
      const outcome = await this.handle(item);
      const [next, ...rest] = this.store.getState().queue;
      this.store.set({ queue: rest, busySince: Date.now() });
      item = next ?? this.nextGoalStep(outcome);
    }
    this.store.set({ busy: false });
  }

  /** Goal 自动推进：一轮正常结束且队列为空时继续下一轮 */
  private nextGoalStep(outcome: Outcome | null): QueueItem | undefined {
    const goal = this.runtime.goal;
    if (!goal.isActive() || outcome === null) return undefined;
    if (outcome === 'aborted') {
      goal.pause('interrupted by user');
      this.store.print('◎ Goal paused because the turn was interrupted. /goal resume to continue.', 'warn');
      return undefined;
    }
    if (outcome === 'error') {
      goal.pause('an error occurred');
      this.store.print('◎ Goal paused because of an error. /goal resume to retry.', 'warn');
      return undefined;
    }
    const g = goal.goal!;
    if (g.iterations >= g.maxIterations) {
      goal.pause(`reached ${g.maxIterations} auto-continue rounds`);
      this.store.print(`◎ Goal paused after ${g.maxIterations} automatic rounds. Check progress, then /goal resume or /goal check.`, 'warn');
      return undefined;
    }
    const text = goal.continuePrompt();
    return { text, origin: 'goal', display: `◎ Goal auto-continue ${g.iterations}/${g.maxIterations}` };
  }

  /** 返回本次是否运行了 Agent 及其结果；未运行 Agent（如 /help）返回 null */
  private async handle(item: QueueItem): Promise<Outcome | null> {
    if (item.display) this.store.print(item.display, 'dim');
    else this.store.push({ kind: 'user', text: item.text });

    if (item.origin !== 'user' || !item.text.startsWith('/')) {
      const outcome = await this.runPrompt(item.text);
      if (item.origin === 'loop') this.loop.roundFinished();
      return outcome;
    }

    const result = await handleCommand(item.text, {
      agent: this.agent,
      session: this.session,
      runtime: this.runtime,
      print: (t, tone) => this.store.print(t, tone),
      runAbortable: this.runAbortable,
      clearScreen: () => this.clearScreen(),
      showConversation: (messages) => this.showConversation(messages),
      loop: this.loop,
    });
    this.store.refresh();
    if (result.exit) {
      this.exit();
      return null;
    }
    if (!result.prompt) return null;
    const outcome = await this.runPrompt(result.prompt);
    if (result.origin === 'loop') this.loop.roundFinished();
    return outcome;
  }

  private runPrompt(prompt: string): Promise<Outcome> {
    return this.runAbortable((signal) => this.agent.run(prompt, signal));
  }

  runAbortable = async (fn: (signal: AbortSignal) => Promise<void>): Promise<Outcome> => {
    this.abort = new AbortController();
    this.interrupted = false;
    try {
      await fn(this.abort.signal);
      return this.abort.signal.aborted || this.interrupted ? 'aborted' : 'ok';
    } catch (err) {
      this.store.textEnd();
      this.store.setStatus(null);
      if (this.abort.signal.aborted) return 'aborted';
      this.store.print(`✗ ${errorMessage(err)}`, 'error');
      return 'error';
    } finally {
      this.abort = null;
      this.session.save(this.agent.messages);
      this.store.refresh();
    }
  };

  private clearScreen(): void {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    this.store.clearHistory();
  }

  private showConversation(messages: Message[]): void {
    this.clearScreen();
    this.store.push({ kind: 'banner' });
    this.store.replay(messages);
  }

  interrupt = (): void => {
    if (!this.abort) return;
    this.interrupted = true;
    this.abort.abort();
  };

  ctrlCEmpty = (): void => {
    const now = Date.now();
    if (now - this.lastCtrlC < 1500) return this.exit();
    this.lastCtrlC = now;
    this.store.showHint('Press Ctrl+C again to exit');
  };

  cycleMode = (): void => {
    this.runtime.permissions.cycleMode();
    this.store.refresh();
  };

  exit = (): void => {
    this.abort?.abort();
    this.loop.stop();
    this.runtime.workers?.closeAll();
    this.session.save(this.agent.messages);
    void this.runtime.mcp.closeAll();
    this.exitApp();
  };

  /** @ 补全用的文件列表：异步加载并缓存 30 秒 */
  getFiles = (): string[] => {
    if (!this.loadingFiles && Date.now() - this.filesLoadedAt > 30_000) {
      this.loadingFiles = true;
      void (async () => {
        const list: string[] = [];
        for await (const f of walk(this.agent.cwd)) {
          list.push(relative(this.agent.cwd, f).split(sep).join('/'));
          if (list.length >= 20000) break;
        }
        this.files = list.sort();
        this.filesLoadedAt = Date.now();
        this.loadingFiles = false;
        this.store.refresh();
      })();
    }
    return this.files;
  };
}
