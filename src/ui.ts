// 终端 UI 小工具：颜色、加载动画、输出预览、简易 diff

const colorEnabled = !!process.stdout.isTTY && !process.env.NO_COLOR;

const wrap =
  (open: string, close = '39') =>
  (s: string) =>
    colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  underline: wrap('4', '24'),
  strike: wrap('9', '29'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private startedAt = 0;
  private label = '';

  start(label: string): void {
    if (!process.stdout.isTTY) return;
    this.stop();
    this.label = label;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.render(), 80);
    this.render();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write('\r\x1b[2K');
  }

  private render(): void {
    const f = FRAMES[this.frame++ % FRAMES.length] ?? '';
    const sec = Math.floor((Date.now() - this.startedAt) / 1000);
    process.stdout.write(`\r\x1b[2K${c.magenta(f)} ${c.dim(`${this.label}… (${sec}s · esc to interrupt)`)}`);
  }
}

/** 将工具输出缩成前几行，用于终端展示 */
export function previewLines(output: string, maxLines = 4, maxWidth = 160): string {
  const lines = output.replace(/\s+$/, '').split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((l) => (l.length > maxWidth ? l.slice(0, maxWidth) + '…' : l));
  if (lines.length > maxLines) shown.push(c.dim(`… +${lines.length - maxLines} lines`));
  return shown.join('\n');
}

/** 带"⎿"前缀的缩进输出 */
export function treeIndent(text: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? `  ${c.dim('⎿')}  ${l}` : `     ${l}`))
    .join('\n');
}

/** 极简 diff：删除行标红，新增行标绿（足够用于确认改动） */
export function simpleDiff(oldText: string, newText: string, startLine = 1, maxLines = 40): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // 去掉公共前后缀，只展示真正变化的部分
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const out: string[] = [];
  const ctxBefore = a.slice(Math.max(0, pre - 2), pre);
  ctxBefore.forEach((l, i) => out.push(c.dim(`${String(startLine + pre - ctxBefore.length + i).padStart(5)}   ${l}`)));
  a.slice(pre, a.length - suf).forEach((l, i) => out.push(c.red(`${String(startLine + pre + i).padStart(5)} - ${l}`)));
  b.slice(pre, b.length - suf).forEach((l, i) => out.push(c.green(`${String(startLine + pre + i).padStart(5)} + ${l}`)));
  b.slice(b.length - suf, Math.min(b.length, b.length - suf + 2)).forEach((l, i) =>
    out.push(c.dim(`${String(startLine + b.length - suf + i).padStart(5)}   ${l}`)),
  );
  if (out.length > maxLines) return out.slice(0, maxLines).join('\n') + '\n' + c.dim(`  … +${out.length - maxLines} lines`);
  return out.join('\n');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
