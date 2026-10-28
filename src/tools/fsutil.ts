import { readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'target', '.cache',
]);

export function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** 相对 cwd 的展示路径（统一正斜杠） */
export function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  if (!rel) return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return abs.split(sep).join('/');
  return rel.split(sep).join('/');
}

/** 递归遍历目录，跳过常见的依赖/构建目录 */
export async function* walk(dir: string, signal?: AbortSignal): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (signal?.aborted) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) yield* walk(full, signal);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/** glob -> 正则。支持 ** / * / ? / {a,b} */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let inBrace = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      inBrace = true;
      re += '(?:';
    } else if (ch === '}' && inBrace) {
      inBrace = false;
      re += ')';
    } else if (ch === ',' && inBrace) re += '|';
    else if ('\\^$.|+()[]'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

/** 不含 / 的模式（如 *.ts）只匹配文件名 */
export function matchGlob(re: RegExp, pattern: string, relPath: string): boolean {
  const p = relPath.split(sep).join('/');
  return pattern.includes('/') ? re.test(p) : re.test(basename(p));
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
