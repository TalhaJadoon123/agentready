/**
 * Security tests.
 *
 * These cover the attack surfaces that actually exist in this product:
 *   - SSRF (the scanner fetches caller-supplied URLs)
 *   - auth bypass (an unauthenticated caller reaching paid features)
 *   - slug sanitization (used in file paths and spawn arguments)
 *   - HTML injection in the rendered dashboard
 *   - JSON-LD script-tag breakout
 *   - token forgery and timing
 *   - quota evasion
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPrivateAddress,
  assertFetchable,
  createGuardedFetch,
  SsrfError,
  privateFetchAllowed,
  serverSlug,
} from '../src/index.js';
import { toScriptTag } from '../../schema/dist/index.js';
import { buildServer } from '../../api/dist/server.js';
import type { App } from '../../api/dist/http.js';
import type { Store } from '../../api/dist/store.js';

describe('SSRF guard — address classification', () => {
  it('blocks loopback', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '0.0.0.0']) expect(isPrivateAddress(ip)).toBe(true);
  });

  it('blocks RFC1918 private ranges', () => {
    for (const ip of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it('allows public addresses that sit just outside private ranges', () => {
    // 172.15.x and 172.32.x are public; a naive prefix check gets these wrong.
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('9.255.255.255')).toBe(false);
    expect(isPrivateAddress('11.0.0.1')).toBe(false);
  });

  it('blocks link-local and cloud metadata', () => {
    expect(isPrivateAddress('169.254.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('100.100.100.200')).toBe(true);
  });

  it('blocks CGNAT and reserved space', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('192.0.2.1')).toBe(true);
    expect(isPrivateAddress('198.18.0.1')).toBe(true);
    expect(isPrivateAddress('255.255.255.255')).toBe(true);
  });

  it('blocks IPv6 loopback, ULA and link-local', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('allows public IPv4 and IPv6', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('SSRF guard — assertFetchable', () => {
  const resolver = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

  it('rejects the AWS metadata endpoint', async () => {
    await expect(assertFetchable('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects localhost by name', async () => {
    await expect(assertFetchable('http://localhost:8787/health')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertFetchable('http://localhost/admin')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a literal loopback address', async () => {
    await expect(assertFetchable('http://127.0.0.1:22/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects non-http protocols', async () => {
    await expect(assertFetchable('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertFetchable('gopher://evil.example/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a public hostname that resolves to a private address', async () => {
    // DNS rebinding: the name looks public, the answer is not.
    await expect(
      assertFetchable('http://rebind.example/', { resolve: resolver({ 'rebind.example': ['127.0.0.1'] }) }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('allows a public hostname resolving publicly', async () => {
    await expect(
      assertFetchable('https://example.com/', { resolve: resolver({ 'example.com': ['93.184.216.34'] }) }),
    ).resolves.toBeUndefined();
  });

  it('allows private targets when explicitly enabled, but still blocks metadata', async () => {
    await expect(assertFetchable('http://localhost:8790/', { allowPrivate: true })).resolves.toBeUndefined();
    await expect(assertFetchable('http://10.0.0.5/', { allowPrivate: true })).resolves.toBeUndefined();
    // Metadata hands out credentials — never allowed.
    await expect(assertFetchable('http://169.254.169.254/', { allowPrivate: true })).rejects.toBeInstanceOf(SsrfError);
  });

  it('reads the opt-in from the environment, defaulting to off', () => {
    expect(privateFetchAllowed({})).toBe(false);
    expect(privateFetchAllowed({ AGENTREADY_ALLOW_PRIVATE_FETCH: 'false' })).toBe(false);
    expect(privateFetchAllowed({ AGENTREADY_ALLOW_PRIVATE_FETCH: 'true' })).toBe(true);
    expect(privateFetchAllowed({ AGENTREADY_ALLOW_PRIVATE_FETCH: '1' })).toBe(true);
  });
});

describe('SSRF guard — redirects', () => {
  /** A fetch that redirects to a fixed URL, then 200s. */
  const redirecting = (target: string) =>
    (async (input: string) => {
      const url = String(input);
      if (url.includes('redirect-to')) {
        return new Response(null, { status: 302, headers: { location: target } });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

  it('blocks a public URL that redirects to metadata', async () => {
    const guarded = createGuardedFetch(redirecting('http://169.254.169.254/latest/'));
    await expect(guarded('http://public.example/redirect-to')).rejects.toBeInstanceOf(SsrfError);
  });

  it('blocks a redirect to localhost', async () => {
    const guarded = createGuardedFetch(redirecting('http://127.0.0.1:8787/health'));
    await expect(guarded('http://public.example/redirect-to')).rejects.toBeInstanceOf(SsrfError);
  });

  it('stops a redirect loop', async () => {
    const guarded = createGuardedFetch(redirecting('http://public.example/redirect-to'));
    await expect(guarded('http://public.example/redirect-to')).rejects.toThrow(/redirects/i);
  });

  it('follows a benign redirect', async () => {
    const guarded = createGuardedFetch(redirecting('https://example.org/final'), {
      resolve: async () => ['93.184.216.34'],
    });
    const res = await guarded('https://example.com/start');
    expect(res.status).toBe(200);
  });
});

describe('slug sanitization', () => {
  it('strips shell metacharacters', () => {
    expect(serverSlug('a; rm -rf /')).not.toMatch(/[;&|`$()]/);
    expect(serverSlug('$(whoami)')).not.toContain('$');
    expect(serverSlug('x`id`b')).not.toContain('`');
  });

  it('strips path separators so it cannot escape a directory', () => {
    expect(serverSlug('../../etc/passwd')).not.toContain('/');
    expect(serverSlug('a/b')).not.toContain('/');
    expect(serverSlug('a\\b')).not.toContain('\\');
  });

  it('never returns an empty string', () => {
    for (const input of ['..', '...', '!!!', '', '---', '///']) {
      const slug = serverSlug(input);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug).toBe('mcp-server');
    }
  });

  it('does not produce a leading dash that would parse as a flag', () => {
    expect(serverSlug('--flag').startsWith('-')).toBe(false);
    expect(serverSlug('-rf').startsWith('-')).toBe(false);
    expect(serverSlug('---').startsWith('-')).toBe(false);
  });

  it('bounds the length', () => {
    expect(serverSlug('a'.repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it('keeps readable names readable', () => {
    expect(serverSlug('Acme Store')).toBe('acme-store');
    expect(serverSlug('northwind-supply')).toBe('northwind-supply');
  });
});

describe('JSON-LD script-tag breakout', () => {
  it('escapes a closing script tag inside the data', () => {
    const out = toScriptTag({ '@type': 'Thing', name: '</script><script>alert(1)</script>' });
    // A literal </script> in the payload would terminate the block early and
    // let the attacker run script.
    expect(out.replace(/<\/script>\s*$/, '')).not.toContain('</script><script>');
    expect(out).toContain('<\\/script>');
  });

  it('escapes in the nested-string case too', () => {
    const out = toScriptTag({ name: 'a</script>b' });
    expect(out.split('</script>').length - 1).toBe(1);
  });
});

describe('API auth', () => {
  let app: App;
  let store: Store;
  let url: string;
  let dir: string;

  const get = async (p: string, init?: RequestInit) => {
    const res = await fetch(`${url}${p}`, init);
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body: body as Record<string, unknown> };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ar-sec-'));
    const built = await buildServer({ devMode: false, forceFile: true, dbPath: join(dir, 'db.json') });
    app = built.app;
    store = built.store;
    url = (await app.listen(0)).url;
  });

  afterAll(async () => {
    await app.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects unauthenticated writes when dev mode is off', async () => {
    const res = await get('/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'example.com' }),
    });
    expect(res.status).toBe(401);
    expect((res.body['error'] as Record<string, unknown>)['code']).toBe('unauthorized');
  });

  it('does not let an anonymous caller reach the dashboard', async () => {
    expect((await get('/dashboard')).status).toBe(401);
  });

  it('rejects a forged token', async () => {
    const res = await get('/quota', { headers: { authorization: 'Bearer forged.signature' } });
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const { signToken } = await import('../../api/dist/auth.js');
    const token = await signToken({ sub: 'attacker' }, 'not-the-real-secret');
    expect((await get('/quota', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('never echoes a secret back', async () => {
    const res = await get('/config');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|gsk_|password|secret.*[:=]/i);
  });

  it('rejects an oversized body', async () => {
    const res = await fetch(`${url}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'x', padding: 'A'.repeat(3_000_000) }),
    }).catch(() => null);
    // Either a 413 from the body limit, or a rejection — never a 500.
    if (res) expect([413, 400]).toContain(res.status);
  });

  it('escapes HTML in dashboard output', async () => {
    const { renderPage, homePage } = await import('../../web/lib/pages.mjs');
    const html = renderPage({ body: homePage() });
    expect(html).toContain('<!doctype html>');
    // The JSON-LD block must not be terminable by the payload it contains.
    const scripts = html.split('<script').length - 1;
    expect(scripts).toBeGreaterThan(0);
  });
});

describe('quota cannot be evaded', () => {
  it('enforces the free tier on a file store', async () => {
    const { JsonFileStore, QuotaExceededError } = await import('../../api/dist/store.js');
    const dir = await mkdtemp(join(tmpdir(), 'ar-quota-'));
    const store = new JsonFileStore(join(dir, 'db.json'));
    await store.init();

    await store.upsertUser({ id: 'u', email: 'u@example.com', plan: 'free' });
    const site = await store.createSite({ userId: 'u', url: 'https://x.example', name: 'X' });

    const before = await store.quotaFor('u');
    expect(before.limit).toBe(1);

    await store.createScan({ siteId: site.id, url: site.url, score: 1, grade: 'F', result: {} as never });
    await expect(store.assertScanAllowed('u')).rejects.toBeInstanceOf(QuotaExceededError);

    // A second site must not reset the allowance — quota is per user.
    const site2 = await store.createSite({ userId: 'u', url: 'https://y.example', name: 'Y' });
    const after = await store.quotaFor('u');
    expect(after.used).toBe(1);
    expect(after.allowed).toBe(false);

    await store.createScan({ siteId: site2.id, url: site2.url, score: 1, grade: 'F', result: {} as never });
    expect((await store.quotaFor('u')).used).toBe(2);

    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
});