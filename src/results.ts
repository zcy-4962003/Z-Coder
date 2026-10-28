// 超大工具结果落盘：完整内容写入文件，上下文中只保留头尾预览和文件路径

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CODER_HOME } from './config.js';
import { estimateTextTokens } from './context.js';

const HEAD = 2000;
const TAIL = 1000;
const KEEP_DAYS = 7;

export function projectKey(cwd: string): string {
  const hash = createHash('md5').update(cwd.toLowerCase()).digest('hex').slice(0, 8);
  return `${basename(cwd).replace(/[^\w.-]+/g, '_') || 'root'}-${hash}`;
}

export class ResultStore {
  readonly dir: string;

  constructor(
    cwd: string,
    /** 超过该字符数的结果会落盘 */
    readonly threshold = 20000,
  ) {
    this.dir = join(CODER_HOME, 'tool-results', projectKey(cwd));
  }

  /** 清理过期的落盘文件（启动时调用） */
  cleanup(): void {
    if (!existsSync(this.dir)) return;
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** 结果过大时落盘并返回替代文本，否则原样返回 */
  offload(toolName: string, toolUseId: string, output: string): { content: string; path?: string } {
    if (output.length <= this.threshold) return { content: output };
    mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(this.dir, `${stamp}-${toolName.replace(/[^\w-]+/g, '_')}-${toolUseId.replace(/[^\w-]+/g, '_').slice(-24)}.txt`);
    writeFileSync(file, output, 'utf8');
    const lines = output.split('\n').length;
    const content =
      `[Output too large: ${output.length.toLocaleString()} chars, ${lines.toLocaleString()} lines, ~${estimateTextTokens(output).toLocaleString()} tokens]\n` +
      `Full output saved to: ${file}\n` +
      `Use Read (with offset/limit) or Grep on that file to inspect the parts you need.\n\n` +
      `--- first ${HEAD} chars ---\n${output.slice(0, HEAD)}\n\n--- last ${TAIL} chars ---\n${output.slice(-TAIL)}`;
    return { content, path: file };
  }
}
