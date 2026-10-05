/**
 * Injected fetch. Every network touch in a scan goes through this so tests
 * can drive the scanner with fixture sites and zero sockets.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FetchResult {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
  url: string;
  responseMs: number;
  error?: string;
  contentType?: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Retry budget for this single request. */
  attempts?: number;
  signal?: AbortSignal;
}

/** Agent-ish UA. Some sites serve bots a different page; we want the agent view. */
export const AGENT_USER_AGENT =
  'Mozilla/5.0 (compatible; AgentReady/1.0; +https://agentready.dev/bot) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Single HTTP GET with a hard timeout. Never throws — returns a result object
 * with `ok: false` and `error` so callers can degrade instead of failing a scan.
 */
export async function fetchOnce(
  fetchImpl: FetchLike,
  url: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true });

  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': AGENT_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...opts.headers,
      },
    });
    const text = await res.text();
    const headers = headersToObject(res.headers);
    return {
      status: res.status,
      ok: res.ok,
      body: text,
      headers,
      url: res.url || url,
      responseMs: Date.now() - started,
      contentType: headers['content-type'],
    };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    return {
      status: 0,
      ok: false,
      body: '',
      headers: {},
      url,
      responseMs: Date.now() - started,
      error: aborted ? `timeout after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** GET and parse JSON. Returns `undefined` on any failure. */
export async function fetchJson<T = unknown>(
  fetchImpl: FetchLike,
  url: string,
  opts: FetchOptions = {},
): Promise<T | undefined> {
  const res = await fetchOnce(fetchImpl, url, {
    ...opts,
    headers: { accept: 'application/json', ...opts.headers },
  });
  if (!res.ok || !res.body) return undefined;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return undefined;
  }
}