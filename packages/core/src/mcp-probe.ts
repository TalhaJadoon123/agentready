/** MCP server discovery and liveness probing (Streamable HTTP + SSE). */

import type { MCPServerInfo, MCPTool } from '@agentready/shared';
import { fetchOnce, type FetchLike } from './fetcher.js';

/** JSON-RPC 2.0 request over HTTP. */
export function jsonRpc(id: number | string, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
}

/** Parse a JSON-RPC response body, tolerating SSE framing. */
export function parseRpcBody(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  // Server-Sent Events: take the last `data:` line that parses as JSON.
  if (trimmed.startsWith('data:') || trimmed.startsWith('event:')) {
    const payloads = trimmed
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = payloads.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(payloads[i] as string);
      } catch {
        /* try earlier frame */
      }
    }
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** MCP well-known endpoint paths, in the order a client should try them. */
export const MCP_ENDPOINTS = [
  '/.well-known/mcp.json',
  '/.well-known/mcp',
  '/mcp',
  '/.well-known/mcp-server',
] as const;

/**
 * Probe candidate URLs for a live MCP server and read its tool list.
 *
 * Discovery order:
 *  1. `.well-known/mcp.json` (declarative manifest — cheap, no POST)
 *  2. JSON-RPC `initialize` + `tools/list` against common endpoints
 */
export async function probeMcpServer(
  fetchImpl: FetchLike,
  origin: string,
  timeoutMs = 10_000,
): Promise<MCPServerInfo> {
  const base = origin.replace(/\/$/, '');
  const down = (url: string, error: string): MCPServerInfo => ({ url, tools: [], status: 'down', error });

  // 1. Declarative manifest.
  for (const path of ['/.well-known/mcp.json', '/.well-known/ai-plugin.json']) {
    const url = `${base}${path}`;
    const res = await fetchOnce(fetchImpl, url, { timeoutMs, headers: { accept: 'application/json' } });
    if (!res.ok || !res.body) continue;
    try {
      const manifest = JSON.parse(res.body) as Record<string, unknown>;
      const remote = (manifest as { mcpServers?: Record<string, { url?: string }> }).mcpServers;
      const endpoint = Object.values(remote ?? {})[0]?.url;
      const serverUrl = typeof endpoint === 'string' ? endpoint : url;
      const info = await rpcProbe(fetchImpl, serverUrl, timeoutMs);
      if (info.status === 'live' && info.tools.length >= 0) return info;
      // Manifest exists but we could not speak MCP — still report it as found-but-down.
      return { ...info, url: serverUrl, error: info.error ?? 'manifest found but tools/list unavailable' };
    } catch {
      continue;
    }
  }

  // 2. Direct JSON-RPC probing of well-known endpoints.
  for (const path of MCP_ENDPOINTS) {
    const info = await rpcProbe(fetchImpl, `${base}${path}`, timeoutMs);
    if (info.status === 'live') return info;
  }

  return down('', 'no MCP server found at any well-known endpoint');
}

/** Run `initialize` then `tools/list` against a single endpoint. */
export async function rpcProbe(fetchImpl: FetchLike, url: string, timeoutMs = 10_000): Promise<MCPServerInfo> {
  const started = Date.now();
  const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };

  const post = async (body: string, sessionId?: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: sessionId ? { ...baseHeaders, 'mcp-session-id': sessionId } : baseHeaders,
        body,
      });
      return { res, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. initialize
  let initPayload: any;
  let sessionId: string | undefined;
  let status = 0;
  try {
    const { res, text } = await post(
      jsonRpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agentready-scanner', version: '1.0.0' },
      }),
    );
    status = res.status;
    const sid = res.headers.get('mcp-session-id');
    sessionId = sid ?? undefined;
    initPayload = res.ok ? parseRpcBody(text) : undefined;
  } catch (err) {
    return {
      url,
      tools: [],
      status: 'down',
      error: status === 404 ? 'not found' : err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  }

  if (!initPayload || initPayload.error) {
    return {
      url,
      tools: [],
      status: 'down',
      error: initPayload?.error?.message ?? `initialize failed (HTTP ${status || 'n/a'})`,
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  }

  // 2. tools/list
  let tools: MCPTool[] = [];
  try {
    const { text } = await post(jsonRpc(2, 'tools/list', {}), sessionId);
    const payload = parseRpcBody(text) as { result?: { tools?: unknown } };
    tools = normalizeTools(payload?.result?.tools);
  } catch {
    tools = [];
  }

  return {
    url,
    tools,
    status: 'live',
    transport: 'http',
    protocolVersion: String(initPayload?.result?.protocolVersion ?? '2025-06-18'),
    serverInfo: {
      name: String(initPayload?.result?.serverInfo?.name ?? 'unknown'),
      version: String(initPayload?.result?.serverInfo?.version ?? '0.0.0'),
    },
    latencyMs: Date.now() - started,
    checkedAt: new Date().toISOString(),
  };
}

/** Coerce whatever `tools/list` returned into our MCPTool shape. */
export function normalizeTools(raw: unknown): MCPTool[] {
  if (!Array.isArray(raw)) return [];
  const out: MCPTool[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t['name'] !== 'string') continue;
    out.push({
      name: t['name'],
      description: typeof t['description'] === 'string' ? t['description'] : '',
      inputSchema: (t['inputSchema'] as Record<string, unknown>) ?? { type: 'object', properties: {} },
      ...(t['outputSchema'] ? { outputSchema: t['outputSchema'] as Record<string, unknown> } : {}),
      ...(t['annotations'] ? { annotations: t['annotations'] as Record<string, unknown> } : {}),
    });
  }
  return out;
}

/** The tool names an agent-facing commerce MCP server should expose. */
export const COMMERCE_TOOLS = [
  'search_products',
  'get_product',
  'check_availability',
  'get_pricing',
  'place_order',
] as const;

/** How many of the commerce essentials a server covers. */
export function commerceToolCoverage(tools: MCPTool[]): string[] {
  const names = new Set(tools.map((t) => t.name));
  return COMMERCE_TOOLS.filter((t) => names.has(t)).map(String);
}