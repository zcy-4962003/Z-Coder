// WebFetch / WebSearch
// WebSearch 提供方：Tavily / Brave（需 API Key），未配置时退回到解析 Bing 网页结果（无需 Key）

import { defineTool, type ToolContext } from './types.js';
import { c } from '../ui.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 coder-agent';
const MAX_BODY = 5 * 1024 * 1024;

export interface WebSearchConfig {
  provider: 'auto' | 'tavily' | 'brave' | 'bing';
  apiKey?: string;
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ------------------------------------------------------------------ HTML -> 文本

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', laquo: '«', raquo: '»', times: '×', deg: '°',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ''));
/** 只去标签、不解码实体：用于中间步骤，避免 &lt;T&gt; 被提前解码后又当作标签删掉 */
const rawText = (s: string) => s.replace(/<[^>]*>/g, '');

export function htmlToText(html: string, baseUrl: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  let h = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, '');
  // 优先取正文区域
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(h);
  if (main && stripTags(main[2]!).trim().length > 200) h = main[2]!;

  // <pre> 先替换成占位符，避免被空白折叠破坏
  const pres: string[] = [];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    pres.push(stripTags(body.replace(/<br\s*\/?>/gi, '\n')));
    return `\u0000${pres.length - 1}\u0000`;
  });

  h = h
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${rawText(t).trim()}\n\n`)
    .replace(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m, h1?: string, h2?: string, h3?: string, t = '') => {
      const href = h1 ?? h2 ?? h3 ?? '';
      const text = rawText(t).replace(/\s+/g, ' ').trim();
      if (!text) return '';
      try {
        const abs = new URL(decodeEntities(href), baseUrl);
        return /^https?:$/.test(abs.protocol) ? `[${text}](${abs.href})` : text;
      } catch {
        return text;
      }
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|dl|dt|dd|header|figure)>/gi, '\n')
    .replace(/<(p|div|section|tr|blockquote|table)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ');

  let text = decodeEntities(h.replace(/<[^>]*>/g, ''))
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n\n(?=- )/g, '\n') // 列表项之间不留空行
    .trim();
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `\n\`\`\`\n${pres[Number(i)]?.replace(/\n+$/, '')}\n\`\`\`\n`);
  return { title, text };
}

// ------------------------------------------------------------------ WebFetch

function parseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export const webFetchTool = defineTool<{ url: string; max_chars?: number }>({
  name: 'WebFetch',
  kind: 'network',
  description:
    'Fetch a URL (http/https) and return its content. HTML pages are converted to readable text with links preserved; ' +
    'JSON and plain text are returned as-is. Use it to read documentation, issues, or pages found with WebSearch.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL including http:// or https://' },
      max_chars: { type: 'integer', description: 'Maximum characters of content to return (default 100000)' },
    },
    required: ['url'],
  },
  summary: (i) => i.url,
  permissionKey: (i) => parseUrl(i.url)?.hostname ?? i.url,
  checkPermission: (i) => (parseUrl(i.url) ? undefined : { behavior: 'deny', reason: `Invalid or unsupported URL: ${i.url} (only http/https)` }),
  preview: (i) => `Fetch ${i.url}`,
  async run(input, ctx) {
    const url = parseUrl(input.url)!;
    const res = await fetch(url, {
      redirect: 'follow',
      signal: withTimeout(ctx.signal, 30000),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' },
    });
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    const body = await readLimited(res, MAX_BODY);
    const header = `URL: ${res.url || url.href}\nStatus: ${res.status}`;
    if (!res.ok) throw new Error(`${header}\nHTTP ${res.status} ${res.statusText}\n\n${body.slice(0, 2000)}`);

    let content: string;
    if (type.includes('html') || (!type && /^\s*<(!doctype|html)/i.test(body))) {
      const { title, text } = htmlToText(body, res.url || url.href);
      content = `${header}\nTitle: ${title || '(none)'}\n\n${text}`;
    } else if (/json|text|xml|javascript|yaml|csv|markdown/.test(type) || !type) {
      content = `${header}\nContent-Type: ${type || 'unknown'}\n\n${body}`;
    } else {
      throw new Error(`${header}\nUnsupported content type: ${type}`);
    }
    const max = Math.max(1000, input.max_chars ?? 100000);
    return content.length > max ? content.slice(0, max) + `\n\n[Content truncated at ${max} characters]` : content;
  },
  display: (out) => {
    const title = /^Title: (.*)$/m.exec(out)?.[1];
    return `Fetched ${c.bold(String(out.length))} chars${title ? c.dim(` · ${title.slice(0, 80)}`) : ''}`;
  },
});

// ------------------------------------------------------------------ WebSearch

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function resolveProvider(cfg: WebSearchConfig): { provider: 'tavily' | 'brave' | 'bing'; key: string } {
  const tavily = cfg.provider === 'tavily' ? cfg.apiKey ?? process.env.TAVILY_API_KEY : undefined;
  const brave = cfg.provider === 'brave' ? cfg.apiKey ?? process.env.BRAVE_API_KEY : undefined;
  if (cfg.provider === 'tavily') return { provider: 'tavily', key: tavily ?? '' };
  if (cfg.provider === 'brave') return { provider: 'brave', key: brave ?? '' };
  if (cfg.provider === 'bing') return { provider: 'bing', key: '' };
  if (process.env.TAVILY_API_KEY) return { provider: 'tavily', key: process.env.TAVILY_API_KEY };
  if (process.env.BRAVE_API_KEY) return { provider: 'brave', key: process.env.BRAVE_API_KEY };
  return { provider: 'bing', key: '' };
}

async function searchTavily(q: string, n: number, key: string, signal: AbortSignal): Promise<SearchResult[]> {
  if (!key) throw new Error('Tavily API key missing (set TAVILY_API_KEY or webSearch.apiKey)');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, max_results: n }),
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function searchBrave(q: string, n: number, key: string, signal: AbortSignal): Promise<SearchResult[]> {
  if (!key) throw new Error('Brave API key missing (set BRAVE_API_KEY or webSearch.apiKey)');
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, {
    signal,
    headers: { accept: 'application/json', 'x-subscription-token': key },
  });
  if (!res.ok) throw new Error(`Brave error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { web?: { results?: { title: string; url: string; description: string }[] } };
  return (data.web?.results ?? []).map((r) => ({ title: stripTags(r.title), url: r.url, snippet: stripTags(r.description ?? '') }));
}

/** Bing 结果里的跳转链接 https://www.bing.com/ck/a?...&u=a1<base64url> 还原为真实地址 */
function unwrapBingUrl(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const p = u.searchParams.get('u');
      if (p?.startsWith('a1')) return Buffer.from(p.slice(2), 'base64url').toString('utf8');
    }
  } catch {
    /* ignore */
  }
  return href;
}

export function parseBing(html: string, n: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const b = block.replace(/<link[^>]*>/g, '');
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = unwrapBingUrl(decodeEntities(a[1]!));
    if (!/^https?:/.test(url)) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b) ?? /<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i.exec(b);
    out.push({
      title: stripTags(a[2]!).trim(),
      url,
      snippet: stripTags(p?.[1] ?? '').replace(/\s+/g, ' ').trim(),
    });
    if (out.length >= n) break;
  }
  return out;
}

async function searchBing(q: string, n: number, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${Math.min(n + 5, 30)}`, {
    signal,
    headers: { 'user-agent': UA.replace(' coder-agent', ''), 'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8' },
  });
  if (!res.ok) throw new Error(`Bing error ${res.status}`);
  return parseBing(await res.text(), n);
}

export const webSearchTool = defineTool<{ query: string; max_results?: number }>({
  name: 'WebSearch',
  kind: 'network',
  description:
    'Search the web and return a list of results (title, URL, snippet). Use it for up-to-date information, error messages, ' +
    'library documentation, etc. Follow up with WebFetch to read a specific result.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'integer', description: 'Number of results (1-15, default 8)' },
    },
    required: ['query'],
  },
  summary: (i) => i.query,
  permissionKey: () => 'web search',
  preview: (i) => `Search the web for: ${i.query}`,
  async run(input, ctx: ToolContext) {
    const n = Math.min(Math.max(input.max_results ?? 8, 1), 15);
    const { provider, key } = resolveProvider(ctx.runtime.webSearch);
    const signal = withTimeout(ctx.signal, 30000);
    const results =
      provider === 'tavily' ? await searchTavily(input.query, n, key, signal)
      : provider === 'brave' ? await searchBrave(input.query, n, key, signal)
      : await searchBing(input.query, n, signal);
    if (!results.length) return `No results found for "${input.query}" (provider: ${provider}).`;
    return (
      `Search results for "${input.query}" (provider: ${provider}):\n\n` +
      results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n\n')
    );
  },
  display: (out) => {
    const n = (out.match(/^\d+\. /gm) ?? []).length;
    return n ? `Found ${c.bold(String(n))} results` : out.split('\n')[0] ?? '';
  },
});
