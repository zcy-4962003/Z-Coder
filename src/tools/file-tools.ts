import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defineTool, type ToolContext } from './types.js';
import { displayPath, isBinary, resolvePath } from './fsutil.js';
import { checkPath } from '../permissions.js';
import { c, simpleDiff } from '../ui.js';

const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;

async function assertFreshRead(abs: string, ctx: ToolContext): Promise<void> {
  const readAt = ctx.readFiles.get(abs);
  if (readAt === undefined) throw new Error('You must Read the file before editing or overwriting it.');
  const { mtimeMs } = await stat(abs);
  if (mtimeMs > readAt + 1) throw new Error('File has been modified since it was last read. Read it again before editing.');
}

async function markRead(abs: string, ctx: ToolContext): Promise<void> {
  ctx.readFiles.set(abs, (await stat(abs)).mtimeMs);
}

// ---------------------------------------------------------------- Read
export const readTool = defineTool<{ file_path: string; offset?: number; limit?: number }>({
  name: 'Read',
  kind: 'read',
  description:
    'Read a text file from the local filesystem. Returns lines prefixed with line numbers (cat -n style). ' +
    `By default reads up to ${MAX_LINES} lines; use offset/limit for large files. Always read a file before editing it.`,
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path or path relative to the working directory' },
      offset: { type: 'integer', description: '1-based line number to start reading from' },
      limit: { type: 'integer', description: 'Number of lines to read' },
    },
    required: ['file_path'],
  },
  summary: (i) => i.file_path,
  checkPermission: (i, ctx) => checkPath(resolvePath(ctx.cwd, i.file_path), ctx, 'read'),
  async run(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.file_path);
    const st = await stat(abs).catch(() => null);
    if (!st) throw new Error(`File does not exist: ${input.file_path}`);
    if (st.isDirectory()) throw new Error(`${input.file_path} is a directory. Use Glob to list files.`);
    if (st.size > 20 * 1024 * 1024) throw new Error('File is larger than 20MB.');
    const buf = await readFile(abs);
    if (isBinary(buf)) throw new Error('File appears to be binary and cannot be displayed.');
    await markRead(abs, ctx);

    const text = buf.toString('utf8');
    if (text === '') return '(empty file)';
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines.at(-1) === '') lines.pop(); // 末尾换行不算一行
    const start = Math.max(1, input.offset ?? 1);
    const limit = Math.max(1, input.limit ?? MAX_LINES);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice
      .map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…' : l}`)
      .join('\n');
    const remaining = lines.length - (start - 1 + slice.length);
    return remaining > 0 ? `${body}\n\n(${remaining} more lines. Use offset=${start + slice.length} to continue.)` : body;
  },
  display: (out) => {
    const n = out.split('\n').filter((l) => /^\s*\d+\t/.test(l)).length;
    return `Read ${c.bold(String(n))} lines`;
  },
});

// ---------------------------------------------------------------- Write
export const writeTool = defineTool<{ file_path: string; content: string }>({
  name: 'Write',
  kind: 'edit',
  description:
    'Write a file to the local filesystem, overwriting it if it exists (parent directories are created). ' +
    'If the file already exists you must Read it first. Prefer Edit for modifying existing files.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path or path relative to the working directory' },
      content: { type: 'string', description: 'Full content to write' },
    },
    required: ['file_path', 'content'],
  },
  summary: (i) => i.file_path,
  checkPermission: (i, ctx) => checkPath(resolvePath(ctx.cwd, i.file_path), ctx, 'write'),
  async preview(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.file_path);
    const old = await readFile(abs, 'utf8').catch(() => null);
    if (old === null) {
      const lines = input.content.split('\n');
      const shown = lines.slice(0, 30).map((l, i) => c.green(`${String(i + 1).padStart(5)} + ${l}`));
      if (lines.length > 30) shown.push(c.dim(`  … +${lines.length - 30} lines`));
      return `${c.bold('Create')} ${displayPath(ctx.cwd, abs)}\n${shown.join('\n')}`;
    }
    return `${c.bold('Overwrite')} ${displayPath(ctx.cwd, abs)}\n${simpleDiff(old.replace(/\r\n/g, '\n'), input.content)}`;
  },
  async run(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.file_path);
    const exists = await stat(abs).then(() => true, () => false);
    if (exists) await assertFreshRead(abs, ctx);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.content, 'utf8');
    await markRead(abs, ctx);
    const n = input.content === '' ? 0 : input.content.replace(/\n$/, '').split('\n').length;
    return `${exists ? 'Updated' : 'Created'} ${displayPath(ctx.cwd, abs)} (${n} lines)`;
  },
});

// ---------------------------------------------------------------- Edit
interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface PlannedEdit {
  abs: string;
  eol: string;
  before: string;
  after: string;
  firstLine: number;
  count: number;
}

async function planEdit(input: EditInput, ctx: ToolContext): Promise<PlannedEdit> {
  const abs = resolvePath(ctx.cwd, input.file_path);
  const raw = await readFile(abs, 'utf8').catch(() => null);
  if (raw === null) throw new Error(`File does not exist: ${input.file_path}`);
  if (input.old_string === input.new_string) throw new Error('old_string and new_string are identical.');
  if (input.old_string === '') throw new Error('old_string must not be empty. Use Write to create files.');

  // 统一换行符处理，保留文件原本的 CRLF/LF 风格
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const before = raw.replace(/\r\n/g, '\n');
  const oldS = input.old_string.replace(/\r\n/g, '\n');
  const newS = input.new_string.replace(/\r\n/g, '\n');

  const count = before.split(oldS).length - 1;
  if (count === 0) throw new Error('old_string not found in file. Make sure it matches exactly, including whitespace and indentation.');
  if (count > 1 && !input.replace_all)
    throw new Error(`old_string appears ${count} times. Provide more surrounding context to make it unique, or set replace_all=true.`);

  const idx = before.indexOf(oldS);
  const firstLine = before.slice(0, idx).split('\n').length;
  const after = input.replace_all ? before.split(oldS).join(newS) : before.slice(0, idx) + newS + before.slice(idx + oldS.length);
  return { abs, eol, before, after, firstLine, count };
}

export const editTool = defineTool<EditInput>({
  name: 'Edit',
  kind: 'edit',
  description:
    'Perform an exact string replacement in a file. old_string must match the file content exactly (excluding the line-number prefix from Read) ' +
    'and must be unique unless replace_all is true. You must Read the file before editing.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path or path relative to the working directory' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  summary: (i) => i.file_path,
  checkPermission: (i, ctx) => checkPath(resolvePath(ctx.cwd, i.file_path), ctx, 'write'),
  async preview(input, ctx) {
    try {
      const p = await planEdit(input, ctx);
      const oldS = input.old_string.replace(/\r\n/g, '\n');
      const newS = input.new_string.replace(/\r\n/g, '\n');
      const header = `${c.bold('Edit')} ${displayPath(ctx.cwd, p.abs)}${p.count > 1 ? c.dim(` (${p.count} occurrences)`) : ''}`;
      return `${header}\n${simpleDiff(oldS, newS, p.firstLine)}`;
    } catch (e) {
      return c.red(String((e as Error).message));
    }
  },
  async run(input, ctx) {
    const p = await planEdit(input, ctx);
    const abs = p.abs;
    await assertFreshRead(abs, ctx);
    await writeFile(abs, p.after.split('\n').join(p.eol), 'utf8');
    await markRead(abs, ctx);
    const delta = p.after.split('\n').length - p.before.split('\n').length;
    return `Edited ${displayPath(ctx.cwd, abs)}: ${p.count} replacement(s) at line ${p.firstLine} (${delta >= 0 ? '+' : ''}${delta} lines)`;
  },
  display(out, input) {
    const line = Number(/at line (\d+)/.exec(out)?.[1] ?? 1);
    const diff = simpleDiff(input.old_string.replace(/\r\n/g, '\n'), input.new_string.replace(/\r\n/g, '\n'), line, 20);
    return `${out.replace(/^Edited \S+: /, '')}\n${diff}`;
  },
});
