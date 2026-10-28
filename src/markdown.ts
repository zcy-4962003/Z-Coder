// Markdown -> 带 ANSI 颜色的终端文本（基于 marked 的词法分析器）

import { Lexer, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';
import { fg, theme } from './theme.js';
import { c } from './ui.js';

export function renderMarkdown(src: string, width = 80): string {
  let tokens: Token[];
  try {
    tokens = Lexer.lex(src, { gfm: true });
  } catch {
    return src;
  }
  return blocks(tokens, Math.max(20, width), 0).replace(/\n{3,}/g, '\n\n').trimEnd();
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const unescape = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

function blocks(tokens: Token[], width: number, depth: number): string {
  const out: string[] = [];
  for (const t of tokens) {
    const s = block(t, width, depth);
    if (s !== null) out.push(s);
  }
  return out.join('\n');
}

function block(t: Token, width: number, depth: number): string | null {
  switch (t.type) {
    case 'space':
      return null;
    case 'heading': {
      const h = t as Tokens.Heading;
      const text = inline(h.tokens);
      return (h.depth <= 2 ? c.bold(c.brand(text)) : c.bold(text)) + '\n';
    }
    case 'paragraph':
      return inline((t as Tokens.Paragraph).tokens) + '\n';
    case 'text': {
      const tt = t as Tokens.Text;
      return tt.tokens ? inline(tt.tokens) : unescape(tt.text);
    }
    case 'code': {
      const code = t as Tokens.Code;
      const lang = (code.lang ?? '').trim().split(/\s+/)[0] ?? '';
      const bar = fg(theme.subtle)('│ ');
      const body = code.text
        .split('\n')
        .map((l) => bar + highlight(l, lang))
        .join('\n');
      return (lang ? fg(theme.subtle)('╭ ') + c.dim(lang) + '\n' : '') + body + '\n';
    }
    case 'blockquote': {
      const inner = blocks((t as Tokens.Blockquote).tokens, width - 2, depth).trimEnd();
      return inner.split('\n').map((l) => fg(theme.brandDeep)('▎ ') + c.italic(l)).join('\n') + '\n';
    }
    case 'list':
      return list(t as Tokens.List, width, depth) + (depth === 0 ? '\n' : '');
    case 'hr':
      return fg(theme.subtle)('─'.repeat(Math.min(width, 60))) + '\n';
    case 'table':
      return table(t as Tokens.Table) + '\n';
    case 'html':
      return (t as Tokens.HTML).text;
    default:
      return 'raw' in t ? String(t.raw) : null;
  }
}

const BULLETS = ['•', '◦', '▪'];

function list(l: Tokens.List, width: number, depth: number): string {
  const start = typeof l.start === 'number' ? l.start : 1;
  return l.items
    .map((item, i) => {
      let bullet = l.ordered ? `${start + i}.` : BULLETS[depth % BULLETS.length]!;
      if (item.task) bullet = item.checked ? c.green('☒') : '☐';
      const body = blocks(item.tokens.filter((t) => t.type !== 'checkbox'), width - 3, depth + 1).trimEnd();
      const pad = ' '.repeat(stringWidth(bullet) + 1);
      return body
        .split('\n')
        .filter((line, idx) => idx === 0 || line.trim() !== '')
        .map((line, idx) => (idx === 0 ? `${c.dim(bullet)} ${line}` : pad + line))
        .join('\n');
    })
    .join('\n');
}

function table(t: Tokens.Table): string {
  const head = t.header.map((cell) => inline(cell.tokens));
  const rows = t.rows.map((r) => r.map((cell) => inline(cell.tokens)));
  const widths = head.map((h, i) => Math.max(stringWidth(h), ...rows.map((r) => stringWidth(r[i] ?? ''))));
  const pad = (s: string, i: number) => {
    const w = widths[i] ?? 0;
    const gap = Math.max(0, w - stringWidth(s));
    const align = t.align[i];
    if (align === 'right') return ' '.repeat(gap) + s;
    if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
    return s + ' '.repeat(gap);
  };
  const line = (l: string, m: string, r: string) => c.gray(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const row = (cells: string[], bold = false) =>
    c.gray('│') + cells.map((s, i) => ` ${bold ? c.bold(pad(s, i)) : pad(s, i)} `).join(c.gray('│')) + c.gray('│');
  return [line('┌', '┬', '┐'), row(head, true), line('├', '┼', '┤'), ...rows.map((r) => row(r)), line('└', '┴', '┘')].join('\n');
}

function inline(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens.map(inlineToken).join('');
}

function inlineToken(t: Token): string {
  switch (t.type) {
    case 'text': {
      const tt = t as Tokens.Text;
      return tt.tokens ? inline(tt.tokens) : unescape(tt.text);
    }
    case 'escape':
      return unescape((t as Tokens.Escape).text);
    case 'strong':
      return c.bold(inline((t as Tokens.Strong).tokens));
    case 'em':
      return c.italic(inline((t as Tokens.Em).tokens));
    case 'del':
      return c.strike(inline((t as Tokens.Del).tokens));
    case 'codespan':
      return c.cyan(unescape((t as Tokens.Codespan).text));
    case 'br':
      return '\n';
    case 'link': {
      const l = t as Tokens.Link;
      const text = inline(l.tokens);
      const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
      return plain === l.href || `mailto:${plain}` === l.href ? c.blue(c.underline(text)) : `${c.blue(text)} ${c.dim(`(${l.href})`)}`;
    }
    case 'image': {
      const img = t as Tokens.Image;
      return c.dim(`[image: ${img.text || img.href}]`);
    }
    case 'html':
      return (t as Tokens.HTML).text;
    default:
      return 'raw' in t ? String(t.raw) : '';
  }
}

// ------------------------------------------------------------------ 极简代码高亮

const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new class extends import export from default ' +
    'async await try catch finally throw typeof instanceof in of interface type enum implements public private protected static ' +
    'readonly abstract declare namespace keyof as is void yield delete this super null undefined true false ' +
    'def elif lambda pass with None True False self not and or global nonlocal raise except ' +
    'fn pub struct impl use mod match mut ref trait where loop crate package func go defer select chan map range ' +
    'echo then fi done esac local'
  ).split(' '),
);

const HASH_COMMENT = new Set(['python', 'py', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'toml', 'ruby', 'rb', 'powershell', 'ps1', 'pwsh', 'dockerfile', 'makefile', 'r', 'perl']);
const PLAIN = new Set(['', 'text', 'txt', 'plain', 'output', 'console', 'log', 'markdown', 'md']);

const HL = {
  keyword: fg(theme.code.keyword),
  string: fg(theme.code.string),
  number: fg(theme.code.number),
  comment: fg(theme.code.comment),
};

function highlight(line: string, lang: string): string {
  const l = lang.toLowerCase();
  if (l === 'diff' || l === 'patch') {
    if (line.startsWith('+')) return c.green(line);
    if (line.startsWith('-')) return c.red(line);
    if (line.startsWith('@@')) return c.cyan(line);
    return line;
  }
  if (PLAIN.has(l)) return line;
  const comment = HASH_COMMENT.has(l) ? '#.*' : l === 'sql' || l === 'lua' ? '--.*' : '\\/\\/.*|\\/\\*.*?(?:\\*\\/|$)';
  const re = new RegExp(
    `(${comment})|("(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|\`(?:\\\\.|[^\`\\\\])*\`?)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)`,
    'g',
  );
  return line.replace(re, (m, cm, str, num, word) => {
    if (cm) return HL.comment(m);
    if (str) return HL.string(m);
    if (num) return HL.number(m);
    if (word && KEYWORDS.has(word)) return HL.keyword(m);
    return m;
  });
}
