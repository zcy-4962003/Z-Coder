// 进程内 Loop：每轮完成后，按固定间隔重复同一提示词（同一时间只允许一个 Loop）

export interface LoopState {
  prompt: string;
  intervalMs: number;
  /** 已触发的轮数（含第一轮） */
  iterations: number;
  startedAt: number;
  /** 下一次触发时间；本轮仍在执行时为 null */
  nextAt: number | null;
}

const MIN_INTERVAL = 10_000;

/** 解析 30s / 5m / 1h / 1h30m / 纯数字（秒） */
export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr|d)/g;
  let total = 0;
  let consumed = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const n = Number(m[1]);
    const unit = m[2]!;
    total += unit === 'ms' ? n : unit.startsWith('s') ? n * 1000 : unit.startsWith('m') ? n * 60_000 : unit.startsWith('h') ? n * 3_600_000 : n * 86_400_000;
    consumed += m[0];
  }
  return consumed.replace(/\s/g, '') === t.replace(/\s/g, '') && total > 0 ? total : null;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}

export class LoopManager {
  state: LoopState | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  /** 到点时调用（由界面层设置为"提交提示词"） */
  onFire: (prompt: string, iteration: number) => void = () => {};

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  start(prompt: string, intervalMs: number): LoopState {
    if (this.state) throw new Error('A loop is already running. Stop it first with /loop stop.');
    if (intervalMs < MIN_INTERVAL) throw new Error(`Interval must be at least ${MIN_INTERVAL / 1000}s.`);
    this.state = { prompt, intervalMs, iterations: 1, startedAt: Date.now(), nextAt: null };
    this.emit();
    return this.state;
  }

  /** 一轮执行完毕后调用，按间隔安排下一轮 */
  roundFinished(): void {
    const st = this.state;
    if (!st || this.timer) return;
    st.nextAt = Date.now() + st.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.state !== st) return;
      st.nextAt = null;
      st.iterations++;
      this.emit();
      this.onFire(st.prompt, st.iterations);
    }, st.intervalMs);
    this.emit();
  }

  stop(): LoopState | null {
    const st = this.state;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state = null;
    this.emit();
    return st;
  }
}
