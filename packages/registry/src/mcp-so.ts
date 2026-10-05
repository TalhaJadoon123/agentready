/**
 * mcp.so submission.
 *
 * mcp.so is a community directory. It accepts a submission through a public
 * JSON API when an API key is configured, and always returns the exact URL and
 * payload needed for the manual form so the user is never stuck.
 */

import type { RegistrySubmission, RegistryTarget } from '@agentready/shared';
import { errorMessage, hasApiKey, newId, registryLimiter } from '@agentready/shared';

export const MCP_SO_TARGET: RegistryTarget = {
  name: 'mcp-so',
  label: 'mcp.so',
  url: 'https://mcp.so',
  limits: 'Free directory listing',
  docs: 'https://mcp.so/submit',
  authRequired: false,
};

export const MCP_SO_API = 'https://mcp.so/api';

export interface McpSoSubmitInput {
  serverName: string;
  description: string;
  serverUrl: string;
  toolNames?: string[];
  homepage?: string;
  githubUrl?: string;
  apiKey?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface McpSoListing {
  slug: string;
  name: string;
  description: string;
  url: string;
  tools: string[];
  homepage?: string;
  submittedAt: string;
}

/** The payload mcp.so expects for a listing. */
export function buildMcpSoPayload(input: McpSoSubmitInput): Record<string, unknown> {
  return {
    name: input.serverName,
    description: input.description,
    url: input.serverUrl,
    ...(input.homepage ? { homepage: input.homepage } : {}),
    ...(input.githubUrl ? { github: input.githubUrl } : {}),
    tools: input.toolNames ?? [],
    transport: 'streamable-http',
    category: 'other',
    license: 'MIT',
  };
}

/** mcp.so listing URL for a server slug. */
export function mcpSoUrl(slug: string): string {
  return `https://mcp.so/server/${slug}`;
}

/** Submit a listing to mcp.so. */
export async function submitToMcpSo(input: McpSoSubmitInput): Promise<RegistrySubmission> {
  const apiKey = input.apiKey;
  const submissionId = newId('reg');
  const payload = buildMcpSoPayload(input);
  const listingUrl = mcpSoUrl(input.serverName);

  if (input.dryRun) {
    return {
      id: submissionId,
      serverName: input.serverName,
      name: 'mcp-so',
      status: 'dry-run',
      url: listingUrl,
      submittedAt: new Date().toISOString(),
      response: payload,
      logs: [
        '[dry-run] payload that would be posted to /api/servers:',
        JSON.stringify(payload, null, 2)
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      ],
    };
  }

  if (!hasApiKey(apiKey)) {
    return {
      id: submissionId,
      serverName: input.serverName,
      name: 'mcp-so',
      status: 'pending',
      url: listingUrl,
      submittedAt: new Date().toISOString(),
      response: payload,
      logs: [
        'No MCP_SO_API_KEY configured, so the listing was not submitted automatically.',
        'Submit it manually at https://mcp.so/submit using this payload:',
        JSON.stringify(payload, null, 2)
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      ],
    };
  }

  try {
    await registryLimiter.take();
    const res = await (input.fetchImpl ?? fetch)(`${MCP_SO_API}/servers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep raw */
    }

    if (res.ok || res.status === 202) {
      const slug = (body as { slug?: string })?.slug ?? input.serverName;
      return {
        id: submissionId,
        serverName: input.serverName,
        name: 'mcp-so',
        status: 'submitted',
        url: mcpSoUrl(slug),
        submittedAt: new Date().toISOString(),
        response: body,
        logs: [`Listed at ${mcpSoUrl(slug)} (HTTP ${res.status}).`],
      };
    }

    return {
      id: submissionId,
      serverName: input.serverName,
      name: 'mcp-so',
      status: 'error',
      error: `mcp.so returned HTTP ${res.status}: ${text.slice(0, 300)}`,
      submittedAt: new Date().toISOString(),
      response: body,
      logs: ['If the API rejects the request, submit the same payload at https://mcp.so/submit'],
    };
  } catch (err) {
    return {
      id: submissionId,
      serverName: input.serverName,
      name: 'mcp-so',
      status: 'error',
      error: errorMessage(err),
      submittedAt: new Date().toISOString(),
      logs: ['Could not reach mcp.so. Submit manually at https://mcp.so/submit'],
    };
  }
}

/** Check whether a server is listed on mcp.so. */
export async function checkMcpSoListing(
  serverName: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ listed: boolean; url?: string; detail: string }> {
  try {
    await registryLimiter.take();
    const res = await (opts.fetchImpl ?? fetch)(`${MCP_SO_API}/servers/${encodeURIComponent(serverName)}`, {
      headers: { accept: 'application/json' },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status === 404) return { listed: false, detail: 'not listed' };
    if (!res.ok) return { listed: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { url?: string; slug?: string };
    return {
      listed: true,
      url: mcpSoUrl(body.slug ?? serverName),
      detail: 'listed',
    };
  } catch (err) {
    return { listed: false, detail: errorMessage(err) };
  }
}