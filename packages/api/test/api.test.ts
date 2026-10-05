/**
 * API integration tests.
 *
 * These boot the real server on an ephemeral port and drive it over HTTP, so
 * routing, validation, auth, quota and serialization are all exercised the way
 * a client would exercise them.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { JsonFileStore, QuotaExceededError, isThisMonth } from '../src/store.js';
import { signToken, verifyToken, mintApiToken } from '../src/auth.js';
import type { App } from '../src/http.js';
import type { Store } from '../src/store.js';

let app: App;
let store: Store;
let baseUrl: string;
let dataDir: string;

const get = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body: body as Record<string, unknown>, headers: res.headers };
};

const post = (path: string, data: unknown) =>
  get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'agentready-api-'));
  const built = await buildServer({ devMode: true, forceFile: true, dbPath: join(dataDir, 'db.json') });
  app = built.app;
  store = built.store;
  const listener = await app.listen(0);
  baseUrl = listener.url;
});

afterAll(async () => {
  await app.close();
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('meta endpoints', () => {
  it('reports health', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(r.body['status']).toBe('ok');
    expect(r.body['store']).toBe('file');
  });

  it('lists its endpoints', async () => {
    const r = await get('/');
    expect((r.body['endpoints'] as string[]).length).toBeGreaterThanOrEqual(7);
  });

  it('reports which integrations are configured, without leaking secrets', async () => {
    const r = await get('/config');
    expect(typeof (r.body['integrations'] as Record<string, unknown>)['groq']).toBe('boolean');
    expect(JSON.stringify(r.body)).not.toMatch(/sk-|gsk_|Bearer /);
  });

  it('answers CORS preflight on any path', async () => {
    const r = await get('/scan', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('404s an unknown route with a typed error', async () => {
    const r = await get('/does-not-exist');
    expect(r.status).toBe(404);
    expect((r.body['error'] as Record<string, unknown>)['code']).toBe('not_found');
  });
});

describe('input validation', () => {
  it('rejects a malformed URL', async () => {
    const r = await post('/scan', { url: 'http://' });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Record<string, unknown>)['code']).toBe('invalid_url');
  });

  it('rejects a missing required field', async () => {
    const r = await post('/scan', {});
    expect(r.status).toBe(400);
    expect((r.body['error'] as Record<string, unknown>)['code']).toBe('invalid_request');
  });

  it('rejects malformed JSON', async () => {
    const r = await get('/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Record<string, unknown>)['code']).toBe('invalid_json');
  });

  it('rejects an unknown data-source kind', async () => {
    const r = await post('/generate/mcp', { serverName: 'x', source: { kind: 'ftp', location: 'x' } });
    expect(r.status).toBe(400);
    expect((r.body['error'] as Record<string, unknown>)['code']).toBe('invalid_source');
  });

  it('requires a url for monitor', async () => {
    const r = await get('/monitor');
    expect(r.status).toBe(400);
  });

  it('requires a url for verify', async () => {
    const r = await get('/verify');
    expect(r.status).toBe(400);
  });
});

describe('POST /generate/mcp', () => {
  it('generates a server from inline products', async () => {
    const r = await post('/generate/mcp', {
      serverName: 'Test Store',
      source: { kind: 'json', location: 'inline', mapping: {} },
      products: [
        { id: 'a', name: 'Alpha', price: 10, currency: 'USD', availability: 'InStock', description: 'First' },
        { id: 'b', name: 'Beta', price: 20, currency: 'USD', availability: 'OutOfStock', description: 'Second' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body['toolNames' as never] ?? r.body['tools']).toHaveLength(5);
    expect(r.body['productCount']).toBe(2);
    // Both manifest shapes are returned, labelled for their audiences.
    expect(r.body['manifest']).toHaveProperty('mcpServers');
    expect(r.body['registryManifest']).toHaveProperty('packages');
  });

  it('omits the worker source unless asked', async () => {
    const r = await post('/generate/mcp', {
      serverName: 'Small',
      source: { kind: 'json', location: 'inline', mapping: {} },
      products: [{ id: 'a', name: 'Alpha', price: 1 }],
    });
    expect(r.body['code']).toBeUndefined();
  });

  it('returns the source when explicitly requested', async () => {
    const r = await post('/generate/mcp', {
      serverName: 'Small',
      source: { kind: 'json', location: 'inline', mapping: {} },
      products: [{ id: 'a', name: 'Alpha', price: 1 }],
      includeCode: true,
    });
    expect(String(r.body['code'])).toContain('tools/list');
  });
});

describe('POST /publish', () => {
  it('produces valid schema plus a snippet and llms.txt', async () => {
    const r = await post('/publish', {
      url: 'https://shop.example',
      platform: 'wordpress',
      entities: {
        organization: { name: 'Shop', url: 'https://shop.example', description: 'A shop' },
        products: [{ id: 'a', name: 'Alpha', price: 10, currency: 'USD', availability: 'InStock', description: 'x' }],
      },
    });
    expect(r.status).toBe(200);
    const schema = r.body['schema'] as Record<string, Record<string, unknown>>;
    expect(schema['validation']!['valid']).toBe(true);
    expect(String(r.body['snippet'])).toContain('application/ld+json');
    expect(String(r.body['llmsTxt'])).toContain('# Shop');
    expect((r.body['instructions'] as string[]).length).toBeGreaterThan(0);
  });
});

describe('POST /register', () => {
  it('dry-runs without claiming anything is live', async () => {
    const r = await post('/register', {
      serverName: 'test-store',
      serverUrl: 'https://test-store-mcp.workers.dev',
      targets: ['official'],
      dryRun: true,
    });
    expect(r.status).toBe(200);
    const submissions = r.body['submissions'] as Array<Record<string, unknown>>;
    expect(submissions[0]!['registry']).toBe('official');
    expect(submissions[0]!['status']).toBe('dry-run');
    expect((r.body['summary'] as Record<string, string[]>)['live']).toHaveLength(0);
  });
});

describe('sites and scans', () => {
  it('creates, lists and fetches sites', async () => {
    const created = await post('/sites', { url: 'https://site.example', name: 'Site' });
    expect(created.status).toBe(200);
    const id = created.body['id'] as string;

    const list = await get('/sites');
    expect((list.body as unknown[]).some((s) => (s as { id: string }).id === id)).toBe(true);

    const scans = await get(`/sites/${id}/scans`);
    expect(Array.isArray(scans.body)).toBe(true);
  });

  it('aggregates a dashboard payload', async () => {
    const r = await get('/dashboard');
    expect(r.status).toBe(200);
    expect(typeof r.body['score']).toBe('number');
    expect(r.body['quota']).toBeDefined();
  });

  it('reports quota', async () => {
    const r = await get('/quota');
    expect(typeof r.body['limit']).toBe('number');
    expect(r.body['plan']).toBeTruthy();
  });
});

describe('auth', () => {
  it('signs and verifies a token', async () => {
    const token = await signToken({ sub: 'user-1', exp: Date.now() + 60_000 }, 'secret');
    const payload = await verifyToken(token, 'secret');
    expect(payload?.['sub']).toBe('user-1');
  });

  it('rejects a tampered token', async () => {
    const token = await signToken({ sub: 'user-1' }, 'secret');
    const [body] = token.split('.');
    const forged = `${body}.deadbeef`;
    expect(await verifyToken(forged, 'secret')).toBeUndefined();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signToken({ sub: 'user-1' }, 'secret');
    expect(await verifyToken(token, 'other')).toBeUndefined();
  });

  it('rejects an expired token', async () => {
    const token = await signToken({ sub: 'user-1', exp: Date.now() - 1000 }, 'secret');
    expect(await verifyToken(token, 'secret')).toBeUndefined();
  });

  it('mints a usable API token', async () => {
    const token = await mintApiToken('user-42', { secret: 's' });
    expect((await verifyToken(token, 's'))?.['sub']).toBe('user-42');
  });
});

describe('store', () => {
  it('persists users, sites and scans', async () => {
    const fresh = new JsonFileStore(join(dataDir, 'store-test.json'));
    await fresh.init();

    await fresh.upsertUser({ id: 'u1', email: 'u1@example.com', plan: 'free' });
    expect((await fresh.getUser('u1'))?.plan).toBe('free');
    expect((await fresh.getUserByEmail('u1@example.com'))?.id).toBe('u1');

    const site = await fresh.createSite({ userId: 'u1', url: 'https://a.example', name: 'A' });
    expect((await fresh.listSites('u1'))).toHaveLength(1);

    await fresh.createScan({ siteId: site.id, url: site.url, score: 80, grade: 'B', result: {} as never });
    expect((await fresh.latestScan(site.id))?.score).toBe(80);

    await fresh.close();
  });

  it('enforces the free-tier scan quota', async () => {
    const fresh = new JsonFileStore(join(dataDir, 'quota-test.json'));
    await fresh.init();
    await fresh.upsertUser({ id: 'u2', email: 'u2@example.com', plan: 'free' });
    const site = await fresh.createSite({ userId: 'u2', url: 'https://b.example', name: 'B' });

    const before = await fresh.quotaFor('u2');
    expect(before.limit).toBe(1);
    expect(before.allowed).toBe(true);

    await fresh.createScan({ siteId: site.id, url: site.url, score: 50, grade: 'F', result: {} as never });

    const after = await fresh.quotaFor('u2');
    expect(after.allowed).toBe(false);
    await expect(fresh.assertScanAllowed('u2')).rejects.toBeInstanceOf(QuotaExceededError);

    await fresh.close();
  });

  it('counts only scans from the current month', async () => {
    const fresh = new JsonFileStore(join(dataDir, 'month-test.json'));
    await fresh.init();
    const site = await fresh.createSite({ userId: 'u3', url: 'https://c.example', name: 'C' });
    await fresh.createScan({ siteId: site.id, url: site.url, score: 1, grade: 'F', result: {} as never, createdAt: '2020-01-15T00:00:00Z' });
    expect(await fresh.countScansThisMonth('u3')).toBe(0);
    expect(isThisMonth('2020-01-15T00:00:00Z')).toBe(false);
    expect(isThisMonth(new Date().toISOString())).toBe(true);
    await fresh.close();
  });

  it('records MCP call counters', async () => {
    const fresh = new JsonFileStore(join(dataDir, 'mcp-test.json'));
    await fresh.init();
    const entry = await fresh.createMcpServer({ siteId: 's', name: 'n', url: 'u', version: '1', toolCount: 5, rpcCalls: 0, monthlyLimit: 25_000, status: 'live' });
    await fresh.recordMcpCall(entry.id);
    expect((await fresh.listMcpServers())[0]?.rpcCalls).toBe(1);
    await fresh.close();
  });

  it('records agent events with revenue', async () => {
    const fresh = new JsonFileStore(join(dataDir, 'events-test.json'));
    await fresh.init();
    await fresh.recordAgentEvent({ siteId: 's', agent: 'chatgpt', tool: 'place_order', revenueCents: 1299, durationMs: 40, ok: true });
    const events = await fresh.listAgentEvents('s');
    expect(events[0]?.revenueCents).toBe(1299);
    await fresh.close();
  });

  it('deletes a site and its scans', async () => {
    const fresh = new JsonFileStore(join(dataDir, 'delete-test.json'));
    await fresh.init();
    const site = await fresh.createSite({ userId: 'u', url: 'https://d.example', name: 'D' });
    await fresh.createScan({ siteId: site.id, url: site.url, score: 1, grade: 'F', result: {} as never });
    expect(await fresh.deleteSite(site.id)).toBe(true);
    expect(await fresh.listScans(site.id)).toHaveLength(0);
    await fresh.close();
  });
});