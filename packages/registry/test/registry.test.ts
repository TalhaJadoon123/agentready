import { describe, expect, it } from 'vitest';
import {
  submitToOfficialRegistry,
  fetchOfficialEntry,
  searchOfficialRegistry,
  submitToSmithery,
  searchSmithery,
  fetchSmitheryStatus,
  submitToMcpSo,
  checkMcpSoListing,
  publishToAll,
  checkRegistryStatus,
  discoverServer,
  isRegistryName,
  buildSmitheryProfile,
  buildMcpSoPayload,
  smitheryServerUrl,
  mcpSoUrl,
  REGISTRY_TARGETS,
  REGISTRY_NAMES,
} from '../src/index.js';
import { validateManifest } from '@agentready/mcp';

const validManifest = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json',
  name: 'acme-store',
  description: 'Acme catalogue exposed for AI agents',
  version: '1.0.0',
  repository: { url: 'https://github.com/acme-store/mcp-server', source: 'github' },
  packages: [
    {
      registryType: 'mcp-publisher',
      registryBaseUrl: 'https://registry.modelcontextprotocol.io',
      identifier: { name: 'acme-store', version: '1.0.0' },
      version: '1.0.0',
      transport: { type: 'streamable-http', url: 'https://acme-store-mcp.workers.dev/mcp' },
    },
  ],
  remotes: [{ type: 'streamable-http', url: 'https://acme-store-mcp.workers.dev/mcp' }],
};

/** A fetch mock that answers each registry's expected shape. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('registry targets', () => {
  it('knows three registries', () => {
    expect(REGISTRY_NAMES).toEqual(['official', 'smithery', 'mcp-so']);
    expect(REGISTRY_TARGETS).toHaveLength(3);
  });

  it('recognizes valid registry names', () => {
    expect(isRegistryName('official')).toBe(true);
    expect(isRegistryName('nope')).toBe(false);
  });
});

describe('official registry', () => {
  it('rejects an invalid manifest before any network call', async () => {
    const result = await submitToOfficialRegistry({
      manifest: { name: 'Bad Name', version: 'x' },
      serverUrl: 'https://x.workers.dev',
    });
    expect(result.status).toBe('rejected');
    expect(result.error).toContain('local validation');
  });

  it('validates the happy-path manifest', () => {
    expect(validateManifest(validManifest).valid).toBe(true);
  });

  it('dry-runs without submitting', async () => {
    const result = await submitToOfficialRegistry({
      manifest: validManifest,
      serverUrl: 'https://acme-store-mcp.workers.dev',
      dryRun: true,
    });
    expect(result.status).toBe('dry-run');
    expect(result.logs?.some((l) => l.includes('dry-run'))).toBe(true);
  });

  it('submits via the publisher API when a token is present', async () => {
    const seen: string[] = [];
    const result = await submitToOfficialRegistry({
      manifest: validManifest,
      serverUrl: 'https://acme-store-mcp.workers.dev',
      token: 'pub-token',
      fetchImpl: mockFetch((url) => {
        seen.push(url);
        return ok({ id: 'srv_1' }, 202);
      }),
    });
    expect(result.status).toBe('submitted');
    expect(seen[0]).toContain('/v0/publish');
  });

  it('treats 409 as already published rather than an error', async () => {
    const result = await submitToOfficialRegistry({
      manifest: validManifest,
      serverUrl: 'https://acme-store-mcp.workers.dev',
      token: 'pub-token',
      fetchImpl: mockFetch(() => ok({ error: 'name taken' }, 409)),
    });
    expect(result.status).toBe('submitted');
    expect(result.logs?.some((l) => l.includes('409'))).toBe(true);
  });

  it('falls back to instructions without a token', async () => {
    const result = await submitToOfficialRegistry({
      manifest: validManifest,
      serverUrl: 'https://acme-store-mcp.workers.dev',
    });
    expect(result.status).toBe('pending');
    expect(result.logs?.join(' ')).toContain('servers/acme-store/1.0.0/server.json');
  });

  it('reads an existing entry', async () => {
    const entry = await fetchOfficialEntry('acme-store', {
      fetchImpl: mockFetch(() => ok({ servers: [{ server: { name: 'acme-store', version: '1.0.0' } }] })),
    });
    expect(entry?.['server']).toMatchObject({ version: '1.0.0' });
  });

  it('returns undefined when the registry is unreachable', async () => {
    const entry = await fetchOfficialEntry('acme-store', {
      fetchImpl: mockFetch(() => new Response('nope', { status: 500 })),
    });
    expect(entry).toBeUndefined();
  });

  it('searches the registry', async () => {
    const results = await searchOfficialRegistry('acme', {
      fetchImpl: mockFetch(() => ok({ servers: [{ server: { name: 'acme-store' } }] })),
    });
    expect(results).toHaveLength(1);
  });
});

describe('smithery', () => {
  it('builds a profile file', () => {
    const yaml = buildSmitheryProfile({ serverName: 'acme-store', description: 'Acme' });
    expect(yaml).toContain('startCommand:');
    expect(yaml).toContain('type: stdio');
  });

  it('gives instructions when no key is set', async () => {
    const result = await submitToSmithery({
      serverName: 'acme-store',
      description: 'Acme',
      apiKey: '',
    });
    expect(result.status).toBe('pending');
    expect(result.logs?.join(' ')).toContain('SMITHERY_API_KEY');
  });

  it('registers with the API when a key is set', async () => {
    const result = await submitToSmithery({
      serverName: 'acme-store',
      description: 'Acme',
      apiKey: 'smithery-key',
      fetchImpl: mockFetch(() => ok({ ok: true }, 202)),
    });
    expect(result.status).toBe('submitted');
  });

  it('reports a 404 as not deployed', async () => {
    const status = await fetchSmitheryStatus('agentready', 'acme-store', {
      fetchImpl: mockFetch(() => new Response('', { status: 404 })),
    });
    expect(status.deployed).toBe(false);
  });

  it('searches', async () => {
    const results = await searchSmithery('acme', { fetchImpl: mockFetch(() => ok({ servers: [{ name: 'a' }] })) });
    expect(results).toHaveLength(1);
  });

  it('builds the server URL', () => {
    expect(smitheryServerUrl('agentready', 'acme-store')).toBe('https://smithery.ai/agentready/acme-store');
  });
});

describe('mcp.so', () => {
  it('builds the expected payload', () => {
    const payload = buildMcpSoPayload({
      serverName: 'acme-store',
      description: 'Acme',
      serverUrl: 'https://acme-store-mcp.workers.dev/mcp',
      toolNames: ['search_products'],
    });
    expect(payload['transport']).toBe('streamable-http');
    expect(payload['tools']).toEqual(['search_products']);
  });

  it('returns the payload for manual submission without a key', async () => {
    const result = await submitToMcpSo({
      serverName: 'acme-store',
      description: 'Acme',
      serverUrl: 'https://acme-store-mcp.workers.dev/mcp',
    });
    expect(result.status).toBe('pending');
    expect(result.response).toBeDefined();
  });

  it('submits with a key', async () => {
    const result = await submitToMcpSo({
      serverName: 'acme-store',
      description: 'Acme',
      serverUrl: 'https://acme-store-mcp.workers.dev/mcp',
      apiKey: 'key',
      fetchImpl: mockFetch(() => ok({ slug: 'acme-store' }, 201)),
    });
    expect(result.status).toBe('submitted');
    expect(result.url).toBe(mcpSoUrl('acme-store'));
  });

  it('reports listing status', async () => {
    const listed = await checkMcpSoListing('acme-store', { fetchImpl: mockFetch(() => ok({ slug: 'acme-store' })) });
    expect(listed.listed).toBe(true);
    const missing = await checkMcpSoListing('nope', { fetchImpl: mockFetch(() => new Response('', { status: 404 })) });
    expect(missing.listed).toBe(false);
  });
});

describe('publishToAll', () => {
  it('hits all three registries concurrently', async () => {
    const result = await publishToAll({
      manifest: validManifest,
      serverUrl: 'https://acme-store-mcp.workers.dev',
      dryRun: true,
    });
    expect(result.submissions).toHaveLength(3);
    expect(result.pending).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
  });

  it('targets only the requested registries', async () => {
    const result = await publishToAll({
      manifest: validManifest,
      serverUrl: 'https://acme-store-mcp.workers.dev',
      targets: ['official'],
      dryRun: true,
    });
    expect(result.submissions).toHaveLength(1);
    expect(result.submissions[0]?.name).toBe('official');
  });

  it('isolates one registry failing from the others', async () => {
    const result = await publishToAll({
      manifest: validManifest,
      serverUrl: 'https://acme-store-mcp.workers.dev',
      targets: ['official', 'smithery', 'mcp-so'],
      tokens: { official: 'tok' },
      fetchImpl: mockFetch((url) => (url.includes('registry.modelcontextprotocol.io') ? new Response('boom', { status: 500 }) : ok({ slug: 'acme-store' }, 201))),
    });
    // One failure must not suppress the rest.
    expect(result.submissions).toHaveLength(3);
  });
});

describe('status monitoring', () => {
  it('detects synced, missing and drifted states', async () => {
    const statuses = await checkRegistryStatus({
      serverName: 'acme-store',
      expectedVersion: '2.0.0',
      fetchImpl: mockFetch((url) => {
        if (url.includes('modelcontextprotocol.io')) {
          return ok({ servers: [{ server: { name: 'acme-store', version: '1.0.0' } }] });
        }
        return new Response('', { status: 404 });
      }),
    });

    const official = statuses.find((s) => s.name === 'official');
    expect(official?.state).toBe('drifted');
    expect(official?.detail).toContain('1.0.0');

    const smithery = statuses.find((s) => s.name === 'smithery');
    expect(smithery?.listed).toBe(false);
  });

  it('summarizes which registries list the server', async () => {
    const result = await discoverServer('acme-store', {
      fetchImpl: mockFetch((url) => (url.includes('modelcontextprotocol.io') ? ok({ servers: [{ server: { name: 'acme-store', version: '1.0.0' } }] }) : new Response('', { status: 404 }))),
    });
    expect(result.listedIn).toContain('official');
    expect(result.listedIn).not.toContain('smithery');
  });
});