/**
 * A tiny Fastify-compatible HTTP layer over `node:http`.
 *
 * Why not Fastify itself? Because AgentReady's API must run in three places:
 * a laptop, a Cloudflare Worker, and a container. Fastify is excellent but is
 * a hard dependency; this façade gives us the same ergonomics —
 *
 *   app.get('/health', async (req, reply) => ({ ok: true }))
 *   app.post('/scan', handler)
 *   reply.send(payload) / reply.code(429).send(payload)
 *
 * — with zero install weight. Route handlers receive plain, serialisable
 * request objects, so swapping in real Fastify later is a one-file change:
 * replace `createServer()` with `fastify()` and keep every handler.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { errorMessage, logger } from '@agentready/shared';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

export interface Request {
  method: HttpMethod;
  url: string;
  path: string;
  /** Path parameters from `/scan/:id`. */
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  ip: string;
}

export interface Reply {
  code(status: number): Reply;
  header(name: string, value: string): Reply;
  /** Send a JSON (or plain text) payload. */
  send(payload?: unknown): Promise<void>;
  raw: ServerResponse;
}

export type Handler = (request: Request, reply: Reply) => unknown | Promise<unknown>;

interface Route {
  method: HttpMethod;
  /** Path pattern, with `:param` segments. */
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: Handler;
  /** Wildcard route registered for 404 handling. */
  isNotFound?: boolean;
}

export interface ServerOptions {
  logger?: boolean;
  /** Max request body size in bytes. */
  bodyLimit?: number;
  /** Allowed CORS origins, or `true` for any. */
  cors?: boolean | string | string[];
  /** Prefix for health endpoints. */
  basePath?: string;
}

export interface App {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  put(path: string, handler: Handler): void;
  patch(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
  options?(path: string, handler: Handler): void;
  /** Register a handler for any unmatched path. */
  setNotFoundHandler(handler: Handler): void;
  /** Register a handler that wraps every request (auth, timing, logging). */
  addHook(name: 'onRequest' | 'preHandler', fn: (request: Request, reply: Reply) => void | Promise<void>): void;
  listen(port: number, host?: string): Promise<{ port: number; url: string; close: () => Promise<void> }>;
  close(): Promise<void>;
  /** Registered routes, for introspection and the /routes endpoint. */
  routes(): Array<{ method: string; path: string }>;
  /** The underlying node server, for tests. */
  server: Server;
}

/** Compile `/scan/:id` into a regex plus its parameter names. */
function compile(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment) return '';
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '/([^/]+)';
      }
      if (segment === '*') {
        paramNames.push('wildcard');
        return '/(.*)';
      }
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return { regex: new RegExp(`^${source || '/'}/?$`), paramNames };
}

/** Read and JSON-parse a request body, with a size cap. */
async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '');
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `Request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return undefined;

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

/** An error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Create the application. */
export function createServer(options: ServerOptions = {}): App {
  const routes: Route[] = [];
  const hooks: Array<(request: Request, reply: Reply) => void | Promise<void>> = [];
  const bodyLimit = options.bodyLimit ?? 1_000_000;
  let notFoundHandler: Handler | undefined;

  const register = (method: HttpMethod, path: string, handler: Handler) => {
    const { regex, paramNames } = compile(path);
    routes.push({ method, pattern: path, regex, paramNames, handler });
  };

  const corsHeaders = (): Record<string, string> => {
    const { cors } = options;
    if (cors === false) return {};
    const origin =
      cors === true || cors === undefined
        ? '*'
        : Array.isArray(cors)
          ? cors.join(', ')
          : cors;
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-agentready-key',
      'access-control-max-age': '86400',
    };
  };

  const httpServer = createHttpServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;

    // CORS preflight: answer it before routing, so it works for any path
    // without every route needing an OPTIONS handler.
    if (method === 'OPTIONS') {
      const cors = corsHeaders();
      res.writeHead(204, { ...cors, 'content-length': '0' });
      res.end();
      return;
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
      else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
    }

    let payload: unknown;
    try {
      if (method !== 'GET' && method !== 'HEAD') {
        payload = await readBody(req, bodyLimit);
      }
    } catch (err) {
      const httpErr = err instanceof HttpError ? err : new HttpError(400, 'bad_request', errorMessage(err));
      res.writeHead(httpErr.status, { 'content-type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ error: { code: httpErr.code, message: httpErr.message } }));
      return;
    }

    // Match the first route whose method and pattern both fit.
    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(url.pathname);
      if (!m) continue;
      matched = route;
      params = Object.fromEntries(route.paramNames.map((name, i) => [name, decodeURIComponent(m[i + 1] ?? '')]));
      break;
    }

    const request: Request = {
      method,
      url: req.url ?? '/',
      path: url.pathname,
      params,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: payload,
      ip: (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''),
    };

    let sent = false;
    const reply: Reply = {
      raw: res,
      code(status: number) {
        res.statusCode = status;
        return reply;
      },
      header(name: string, value: string) {
        if (!res.headersSent) res.setHeader(name, value);
        return reply;
      },
      async send(body?: unknown) {
        if (sent) return;
        sent = true;

        const finalStatus = res.statusCode;
        const outHeaders: Record<string, string> = { ...corsHeaders() };
        for (const [key, value] of Object.entries(res.getHeaders())) {
          if (value !== undefined) outHeaders[key.toLowerCase()] = String(value);
        }

        if (body === undefined || body === null) {
          res.writeHead(finalStatus);
          res.end();
          return;
        }

        const isString = typeof body === 'string' || Buffer.isBuffer(body);
        const contentType = isString ? (res.getHeader('content-type') ?? 'text/plain; charset=utf-8') : 'application/json; charset=utf-8';
        const text = isString ? String(body) : JSON.stringify(body);

        res.writeHead(finalStatus, { ...outHeaders, 'content-type': String(contentType) });
        res.end(text);
      },
    };

    try {
      for (const hook of hooks) await hook(request, reply);

      const handler = matched?.handler ?? notFoundHandler;
      if (!handler) {
        await reply.code(404).send({
          error: { code: 'not_found', message: `No route for ${method} ${request.path}` },
        });
        return;
      }

      // Fastify-style handlers may either return a value or call reply.send().
      const result = await handler(request, reply);
      if (!sent && result !== undefined) await reply.send(result);
      else if (!sent) await reply.send();
    } catch (err) {
      if (sent) return;

      // An SSRF refusal is a client error, not a server fault. Mapping it here
      // means every route that fetches a caller-supplied URL reports 400
      // consistently instead of leaking a 500.
      if (err instanceof Error && err.name === 'SsrfError') {
        logger.debug(`SSRF blocked on ${method} ${request.path}: ${err.message}`);
        await reply.code(400).send({
          error: { code: 'blocked_target', message: err.message },
        });
        return;
      }

      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : 'internal_error';
      const message = errorMessage(err);

      if (status >= 500) logger.error(`Unhandled error on ${method} ${request.path}`, { message });
      else logger.debug(`${code} on ${method} ${request.path}`, { message });

      await reply.code(status).send({
        error: {
          code,
          message: status >= 500 ? 'Internal server error' : message,
          ...(err instanceof HttpError && err.details ? { details: err.details } : {}),
        },
      });
    } finally {
      if (options.logger !== false) {
        logger.debug(`${method} ${request.path} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  }

  const app: App = {
    get: (path, handler) => register('GET', path, handler),
    post: (path, handler) => register('POST', path, handler),
    put: (path, handler) => register('PUT', path, handler),
    patch: (path, handler) => register('PATCH', path, handler),
    delete: (path, handler) => register('DELETE', path, handler),
    options: (path, handler) => register('OPTIONS', path, handler),
    setNotFoundHandler: (handler) => {
      notFoundHandler = handler;
    },
    addHook: (_name, fn) => {
      hooks.push(fn);
    },
    routes: () => routes.map((r) => ({ method: r.method, path: r.pattern })),
    server: httpServer,
    async listen(port: number, host = '0.0.0.0') {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', reject);
          resolve();
        });
      });
      const actual = (httpServer.address() as { port: number } | null)?.port ?? port;
      return {
        port: actual,
        url: `http://localhost:${actual}`,
        close: () => app.close(),
      };
    },
    async close() {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Drop keep-alive sockets so close() resolves promptly.
        httpServer.closeAllConnections?.();
      });
    },
  };

  return app;
}