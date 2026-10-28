// HTTP 请求（带重试）与 SSE 流解析

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`API error ${status}: ${body.slice(0, 1000)}`);
  }
}

/** POST JSON，对网络错误 / 429 / 5xx 做指数退避重试 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted || attempt >= maxRetries) throw err;
      await sleep(backoff(attempt), signal);
      continue;
    }
    if (res.ok) return res;

    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), signal);
      continue;
    }
    throw new ApiError(res.status, text);
  }
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 16000) + Math.random() * 300;
}

export interface SSEEvent {
  event: string;
  data: string;
}

/** 解析 text/event-stream 响应 */
export async function* readSSE(res: Response): AsyncGenerator<SSEEvent> {
  if (!res.body) throw new Error('Empty response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseEvent(raw);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    const ev = parseEvent(buf);
    if (ev) yield ev;
  } finally {
    reader.cancel().catch(() => {});
  }
}

function parseEvent(raw: string): SSEEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? { event, data: data.join('\n') } : null;
}
