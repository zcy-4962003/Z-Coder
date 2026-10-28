import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { defineTool } from './types.js';
import { displayPath, globToRegExp, isBinary, matchGlob, resolvePath, walk } from './fsutil.js';
import { checkPath } from '../permissions.js';
import { c } from '../ui.js';

// ---------------------------------------------------------------- Glob
export const globTool = defineTool<{ pattern: string; path?: string }>({
  name: 'Glob',
  kind: 'read',
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.{js,jsx}", "*.md"). ' +
    'Results are sorted by modification time (newest first). node_modules/.git/dist etc. are skipped.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search in (default: working directory)' },
    },
    required: ['pattern'],
  },
  summary: (i) => (i.path ? `${i.pattern} in ${i.path}` : i.pattern),
  checkPermission: (i, ctx) => checkPath(resolvePath(ctx.cwd, i.path ?? '.'), ctx, 'read'),
  async run(input, ctx) {
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    const re = globToRegExp(input.pattern);
    const found: { path: string; mtime: number }[] = [];
    for await (const file of walk(root, ctx.signal)) {
      if (!matchGlob(re, input.pattern, relative(root, file))) continue;
      const st = await stat(file).catch(() => null);
      found.push({ path: file, mtime: st?.mtimeMs ?? 0 });
      if (found.length >= 5000) break;
    }
    if (!found.length) return 'No files found';
    found.sort((a, b) => b.mtime - a.mtime);
    const limit = 200;
    const list = found.slice(0, limit).map((f) => displayPath(ctx.cwd, f.path));
    if (found.length > limit) list.push(`(${found.length - limit} more files not shown, use a more specific pattern)`);
    return list.join('\n');
  },
  display: (out) => (out === 'No files found' ? out : `Found ${c.bold(String(out.split('\n').length))} files`),
});

// ---------------------------------------------------------------- Grep
interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  output_mode?: 'files_with_matches' | 'content' | 'count';
  head_limit?: number;
}

export const grepTool = defineTool<GrepInput>({
  name: 'Grep',
  kind: 'read',
  description:
    'Search file contents with a JavaScript regular expression. ' +
    'output_mode: "files_with_matches" (default, list files), "content" (matching lines as file:line:text), "count" (matches per file). ' +
    'Use glob to filter files (e.g. "*.ts").',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search (default: working directory)' },
      glob: { type: 'string', description: 'Glob filter for file names, e.g. "*.ts" or "src/**/*.tsx"' },
      ignore_case: { type: 'boolean', description: 'Case insensitive search' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      head_limit: { type: 'integer', description: 'Max number of result lines (default 100)' },
    },
    required: ['pattern'],
  },
  summary: (i) => `"${i.pattern}"${i.path ? ` in ${i.path}` : ''}${i.glob ? ` (${i.glob})` : ''}`,
  checkPermission: (i, ctx) => checkPath(resolvePath(ctx.cwd, i.path ?? '.'), ctx, 'read'),
  async run(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
    } catch (e) {
      throw new Error(`Invalid regex: ${(e as Error).message}`);
    }
    const mode = input.output_mode ?? 'files_with_matches';
    const limit = input.head_limit ?? 100;
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat) throw new Error(`Path does not exist: ${input.path}`);

    const globRe = input.glob ? globToRegExp(input.glob) : null;
    const files: AsyncIterable<string> = rootStat.isFile() ? (async function* () { yield root; })() : walk(root, ctx.signal);

    const out: string[] = [];
    let total = 0;
    for await (const file of files) {
      if (globRe && input.glob && !matchGlob(globRe, input.glob, relative(root, file) || file)) continue;
      const st = await stat(file).catch(() => null);
      if (!st || st.size > 2 * 1024 * 1024) continue;
      const buf = await readFile(file).catch(() => null);
      if (!buf || isBinary(buf)) continue;

      const lines = buf.toString('utf8').split(/\r?\n/);
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!re.test(line)) continue;
        count++;
        if (mode === 'content') {
          total++;
          if (out.length < limit) out.push(`${displayPath(ctx.cwd, file)}:${i + 1}:${line.length > 300 ? line.slice(0, 300) + '…' : line}`);
        } else if (mode === 'files_with_matches') break;
      }
      if (count === 0) continue;
      if (mode === 'files_with_matches') {
        total++;
        if (out.length < limit) out.push(displayPath(ctx.cwd, file));
      } else if (mode === 'count') {
        total++;
        if (out.length < limit) out.push(`${displayPath(ctx.cwd, file)}:${count}`);
      }
    }
    if (!out.length) return 'No matches found';
    if (total > out.length) out.push(`(${total - out.length} more results not shown)`);
    return out.join('\n');
  },
  display: (out) => (out === 'No matches found' ? out : `Found ${c.bold(String(out.split('\n').length))} results`),
});
