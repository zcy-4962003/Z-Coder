// Agent 与界面之间的接口：Agent 只负责产生事件，具体怎么显示由 View 决定
// - ConsoleView：单次运行模式（-p），直接输出到 stdout
// - UIStore（src/tui/store.ts）：交互模式，驱动 Ink 界面

import { c, Spinner, treeIndent } from './ui.js';

export type Tone = 'normal' | 'dim' | 'warn' | 'error' | 'success';
export type ToolStatus = 'ok' | 'error' | 'rejected';

export interface ToolStartEvent {
  id: string;
  name: string;
  summary: string;
}

export interface ToolEndEvent {
  id: string;
  status: ToolStatus;
  /** 展示给用户的结果（可含 ANSI 颜色） */
  display: string;
}

export interface AgentView {
  /** 显示/隐藏加载状态，null 表示隐藏 */
  setStatus(label: string | null): void;
  textDelta(text: string): void;
  textEnd(): void;
  toolStart(e: ToolStartEvent): void;
  toolEnd(e: ToolEndEvent): void;
  print(text: string, tone?: Tone): void;
}

export function toneColor(tone: Tone): (s: string) => string {
  switch (tone) {
    case 'dim':
      return c.dim;
    case 'warn':
      return c.yellow;
    case 'error':
      return c.red;
    case 'success':
      return c.green;
    default:
      return (s) => s;
  }
}

export class ConsoleView implements AgentView {
  private readonly spinner = new Spinner();
  private streaming = false;
  private readonly tools = new Map<string, ToolStartEvent>();

  setStatus(label: string | null): void {
    if (label) this.spinner.start(label);
    else this.spinner.stop();
  }

  textDelta(text: string): void {
    if (!this.streaming) {
      this.spinner.stop();
      process.stdout.write('\n' + c.brand('● '));
      this.streaming = true;
    }
    process.stdout.write(text);
  }

  textEnd(): void {
    if (this.streaming) process.stdout.write('\n');
    this.streaming = false;
  }

  toolStart(e: ToolStartEvent): void {
    this.tools.set(e.id, e);
    console.log(`\n${c.green('●')} ${c.bold(e.name)}${e.summary ? c.dim(`(${e.summary})`) : ''}`);
  }

  toolEnd(e: ToolEndEvent): void {
    this.tools.delete(e.id);
    const color = e.status === 'ok' ? (s: string) => s : c.red;
    if (e.display) console.log(treeIndent(color(e.display)));
  }

  print(text: string, tone: Tone = 'normal'): void {
    this.spinner.stop();
    console.log(toneColor(tone)(text));
  }
}
