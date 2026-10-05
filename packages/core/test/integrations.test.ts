/**
 * Integration tests for the free public APIs, and for the enrichment contract.
 *
 * Every network call is mocked. The point is not that crt.sh is up today — it
 * is that when it is not, the product still works and says so.
 */

import { describe, expect, it } from 'vitest';
import {
  fetchSubdomains,
  fetchDnsRecords,
  fetchArchivePresence,
  fetchDomainInfo,
  enrichTarget,
  describeEnrichment,
} from '../src/integrations.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Route requests by URL substring. */
function router(routes: Array<[string, () => Response]>, fallback: () => Response = () => json({})) {
  return (async (input: string) => {
    const url = String(input);
    for (const [match, respond] of routes) {
      if (url.includes(match)) return respond();
    }
    return fallback();
  }) as unknown as typeof fetch;
}

describe('crt.sh — subdomain discovery', () => {
  it('extracts subdomains from the certificate log', async () => {
    const result = await fetchSubdomains('https://example.com', {
      fetchImpl: router([
        ['crt.sh', () =>
          json([
            { name_value: 'shop.example.com\nwww.example.com', issuer_name: "Let's Encrypt R3", not_before: '2024-01-01' },
            { name_value: 'api.example.com', issuer_name: "Let's Encrypt R3", not_before: '2025-06-01' },
            { name_value: 'unrelated.org', issuer_name: 'Other CA', not_before: '2023-01-01' },
          ]),
        ],
      ]),
    });

    expect(result?.data.subdomains).toContain('shop.example.com');
    expect(result?.data.subdomains).toContain('api.example.com');
    // Wildcard entries are stripped, and unrelated domains are not included.
    expect(result?.data.subdomains.some((s) => s.includes('unrelated.org'))).toBe(false);
    expect(result?.data.subdomains).not.toContain('www.example.com');
    expect(result?.data.issuers.length).toBeGreaterThan(0);
  });

  it('returns undefined when the log has nothing', async () => {
    expect(await fetchSubdomains('https://example.com', { fetchImpl: router([]) })).toBeUndefined();
  });

  it('returns undefined when the service fails', async () => {
    const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await fetchSubdomains('https://example.com', { fetchImpl: failing })).toBeUndefined();
  });

  it('ignores a URL with no hostname', async () => {
    expect(await fetchSubdomains('not a url', { fetchImpl: router([]) })).toBeUndefined();
  });
});

describe('Cloudflare DNS-over-HTTPS', () => {
  it('collects records across record types', async () => {
    // Respond per the actual ?type= value so A and AAAA are told apart.
    const byType = (async (input: string) => {
      const type = new URL(String(input)).searchParams.get('type');
      const answers: Record<string, unknown> = {
        A: [{ type: 1, data: '93.184.216.34', TTL: 300 }],
        AAAA: [],
        MX: [{ type: 15, data: 'mx.example.com', TTL: 3600 }],
        TXT: [{ type: 16, data: 'v=spf1 -all', TTL: 300 }],
        NS: [{ type: 2, data: 'ns1.example.com', TTL: 86400 }],
      };
      return json({ Answer: answers[type ?? ''] ?? [] });
    }) as unknown as typeof fetch;

    const result = await fetchDnsRecords('https://example.com', { fetchImpl: byType });

    expect(result?.data.doesNotResolve).toBe(false);
    const types = result?.data.records.map((r) => r.type).sort();
    expect(types).toContain('A');
    expect(types).toContain('MX');
    expect(types).toContain('TXT');
    // AAAA returned no answers, so it must not appear.
    expect(types).not.toContain('AAAA');
  });

  it('reports a non-resolving domain explicitly', async () => {
    const result = await fetchDnsRecords('https://nothing.example', { fetchImpl: router([]) });
    expect(result?.data.doesNotResolve).toBe(true);
    expect(result?.data.records).toHaveLength(0);
  });
});

describe('Wayback Machine', () => {
  it('reports archive age when a snapshot exists', async () => {
    const result = await fetchArchivePresence('https://example.com', {
      fetchImpl: router([
        ['archive.org', () => json({ archived_snapshots: { available: true, closest: { timestamp: '1100000000' } } })],
      ]),
    });
    expect(result?.data.archived).toBe(true);
    expect(result?.data.yearsArchived).toBeGreaterThan(5);
  });

  it('reports a site with no archive history', async () => {
    const result = await fetchArchivePresence('https://brandnew.example', {
      fetchImpl: router([['archive.org', () => json({ archived_snapshots: {} })]]),
    });
    expect(result?.data.archived).toBe(false);
  });
});

describe('RDAP domain data', () => {
  it('returns registration dates and registrar', async () => {
    const result = await fetchDomainInfo('https://example.com', {
      fetchImpl: router([
        ['verisign', () =>
          json({
            registrar: [{ handle: 'RESERVED-Internet Assigned Numbers Authority' }],
            events: [
              { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
              { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
            ],
            status: ['clientDeleteProhibited'],
          }),
        ],
      ]),
    });
    expect(result?.data.registered).toBe(true);
    expect(result?.data.createdAt).toContain('1995');
    expect(result?.data.registrar).toContain('RESERVED');
  });

  it('returns undefined for a TLD with no known RDAP endpoint', async () => {
    expect(await fetchDomainInfo('https://example.zzzz', { fetchImpl: router([]) })).toBeUndefined();
  });
});

describe('enrichTarget', () => {
  it('gathers everything in one call', async () => {
    const result = await enrichTarget('https://example.com', {
      fetchImpl: router([
        ['crt.sh', () => json([{ name_value: 'api.example.com', not_before: '2024-01-01' }])],
        ['cloudflare-dns', () => json({ Answer: [{ type: 1, data: '93.184.216.34', TTL: 60 }] })],
        ['archive.org', () => json({ archived_snapshots: { available: true, closest: { timestamp: '1100000000' } } })],
        ['verisign', () => json({ events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }], status: [] })],
      ]),
    });

    expect(result.subdomains?.subdomains).toContain('api.example.com');
    expect(result.dns?.doesNotResolve).toBe(false);
    expect(result.archive?.archived).toBe(true);
    expect(result.domain?.createdAt).toContain('1995');
    expect(result.unavailable).toHaveLength(0);
  });

  it('never fails when every integration is down', async () => {
    const failing = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    const result = await enrichTarget('https://example.com', { fetchImpl: failing });
    expect(result.target).toBe('https://example.com');
    expect(result.subdomains).toBeUndefined();
    // Everything is reported as unavailable rather than silently omitted.
    expect(result.unavailable.length).toBeGreaterThan(0);
  });

  it('makes no network calls in offline mode', async () => {
    const explode = (async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    const result = await enrichTarget('https://example.com', { fetchImpl: explode, offline: true });
    expect(result.subdomains).toBeUndefined();
    expect(result.unavailable.length).toBeGreaterThan(0);
  });

  it('survives one integration throwing while others succeed', async () => {
    const partial = (async (input: string) => {
      if (String(input).includes('crt.sh')) throw new Error('crt.sh exploded');
      if (String(input).includes('archive.org')) {
        return json({ archived_snapshots: { available: true, closest: { timestamp: '1100000000' } } });
      }
      return json({});
    }) as unknown as typeof fetch;

    const result = await enrichTarget('https://example.com', { fetchImpl: partial });
    expect(result.unavailable).toContain('crt.sh');
    expect(result.archive?.archived).toBe(true);
  });
});

describe('describeEnrichment', () => {
  it('renders domain age and warns about expiry', async () => {
    const soon = new Date(Date.now() + 60 * 86_400_000).toISOString();
    const lines = describeEnrichment({
      target: 'https://x.example',
      domain: { registered: true, createdAt: '2000-01-01T00:00:00Z', expiresAt: soon, status: [] },
    });
    expect(lines.join(' ')).toContain('expires in');
  });

  it('flags a non-resolving domain', () => {
    const lines = describeEnrichment({
      target: 'https://x.example',
      dns: { records: [], resolver: 'cloudflare-dns.com', doesNotResolve: true },
    });
    expect(lines.join(' ')).toContain('does not resolve');
  });

  it('lists unavailable integrations rather than hiding them', () => {
    const lines = describeEnrichment({ target: 'https://x.example', unavailable: ['rdap'] });
    expect(lines.join(' ')).toContain('Unavailable');
  });

  it('returns nothing for an empty report', () => {
    expect(describeEnrichment({ target: 'https://x.example', unavailable: [] })).toHaveLength(0);
  });
});