import { describe, expect, it } from 'vitest';
import {
  groqChat,
  isGroqConfigured,
  GroqNotConfiguredError,
  parseStringArray,
  parseResponseMeta,
  scoreSimulation,
  deterministicSimulation,
  buildPrompt,
  buildReport,
  formatSimulationReport,
  simulateAgentVisibility,
  runBenchmark,
  formatBenchmark,
  compareBenchmarks,
  buildCorpus,
  extractProducts,
  extractOrganization,
  bucketErrors,
  fingerprintError,
  summarizeUptime,
  probeOnce,
  probeUptime,
  monitorEndpoints,
  describeUptime,
  withinWindow,
  scoreRegressionAlert,
  mcpHealthAlert,
  registryDriftAlert,
  uptimeAlert,
  visibilityAlert,
  dedupeAlerts,
  buildAlert,
  dispatchAlert,
  renderAlert,
  mcpHealthUrl,
  DEFAULT_QUERIES,
  PERSONAS,
} from '../src/index.js';
import { fixtureFetch, excellentSite, shopifySite } from '../../core/test/fixtures.js';

/** A fetch that answers the Groq chat endpoint with a canned response. */
function mockGroq(content: string, model = 'llama-3.3-70b-versatile'): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        model,
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { total_tokens: 120 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
}

describe('groq client', () => {
  it('reports whether it is configured', () => {
    expect(isGroqConfigured('gsk_test')).toBe(true);
    expect(isGroqConfigured(undefined)).toBe(false);
  });

  it('throws a specific error with no API key', async () => {
    await expect(groqChat([{ role: 'user', content: 'hi' }], { apiKey: '' })).rejects.toBeInstanceOf(GroqNotConfiguredError);
  });

  it('returns the completion', async () => {
    const result = await groqChat([{ role: 'user', content: 'hi' }], { apiKey: 'test', fetchImpl: mockGroq('hello') });
    expect(result.text).toBe('hello');
    expect(result.tokensUsed).toBe(120);
  });

  it('falls back to a smaller model on a 429', async () => {
    let calls = 0;
    const flaky = (async (_url: string, init?: RequestInit) => {
      calls++;
      const model = JSON.parse(String(init?.body)).model as string;
      if (model.includes('70b')) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ model, choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await groqChat([{ role: 'user', content: 'hi' }], { apiKey: 'test', fetchImpl: flaky, baseDelayMs: 1 } as never);
    expect(result.text).toBe('ok');
    expect(calls).toBeGreaterThan(1);
  });
});

describe('query and response parsing', () => {
  it('extracts a JSON array', () => {
    expect(parseStringArray('["a question", "another"]')).toEqual(['a question', 'another']);
  });

  it('extracts a fenced array', () => {
    expect(parseStringArray('```json\n["one", "two"]\n```')).toEqual(['one', 'two']);
  });

  it('falls back to line extraction', () => {
    expect(parseStringArray('- first query\n- second query')).toEqual(['first query', 'second query']);
  });

  it('reads SOURCES and ANSWERABILITY', () => {
    const meta = parseResponseMeta('blah\nSOURCES: acme.com, rival.com\nANSWERABILITY: 80');
    expect(meta.sources).toEqual(['acme.com', 'rival.com']);
    expect(meta.answerability).toBe(80);
  });

  it('clamps an out-of-range answerability', () => {
    expect(parseResponseMeta('ANSWERABILITY: 900').answerability).toBe(100);
  });
});

describe('simulation scoring', () => {
  it('marks a first-place citation as rank 1', () => {
    const sim = scoreSimulation('q', 'SOURCES: acme.com, rival.com\nANSWERABILITY: 90', 'https://acme.com', ['https://rival.com']);
    expect(sim.found).toBe(true);
    expect(sim.rank).toBe(1);
    expect(sim.answerability).toBe(90);
  });

  it('marks a later citation with its real rank', () => {
    const sim = scoreSimulation('q', 'SOURCES: rival.com, acme.com\nANSWERABILITY: 90', 'https://acme.com', ['https://rival.com']);
    expect(sim.rank).toBe(2);
  });

  it('treats an uncited target as not found', () => {
    const sim = scoreSimulation('q', 'SOURCES: rival.com\nANSWERABILITY: 90', 'https://acme.com', ['https://rival.com']);
    expect(sim.found).toBe(false);
    expect(sim.rank).toBe(0);
  });

  it('treats an answer with no sources as unanswerable', () => {
    const sim = scoreSimulation('q', 'I have no idea.', 'https://acme.com', []);
    expect(sim.answerability).toBe(0);
  });

  it('scores answerability structurally in deterministic mode', () => {
    const sim = deterministicSimulation(
      'q',
      [{ name: 'acme.com', url: 'https://acme.com', content: 'x', signals: { hasPrices: 1, productCount: 3, hasAvailability: 1, hasMcp: 1, hasStructuredData: 1, wordCount: 900 } }],
      'https://acme.com',
      [],
    );
    expect(sim.answerability).toBeGreaterThan(60);
    // Deterministic mode must not look like a failure.
    expect(sim.error).toBeUndefined();
  });
});

describe('simulation reports', () => {
  const sims = [
    { query: 'q1', results: [{ source: 'acme.com', cited: true, rank: 1 }], source: 'acme.com', rank: 1, found: true, answerability: 90 },
    { query: 'q2', results: [{ source: 'rival.com', cited: true, rank: 1 }], source: 'rival.com', rank: 0, found: false, answerability: 40 },
  ];

  it('aggregates win rate, rank and visibility', () => {
    const report = buildReport({
      target: 'https://acme.com',
      competitors: ['https://rival.com'],
      simulations: sims,
      model: 'test',
      simulatedAt: new Date().toISOString(),
      durationMs: 1,
    });
    expect(report.winRate).toBe(50);
    expect(report.averageRank).toBe(1);
    expect(report.visibilityScore).toBeGreaterThan(0);
    expect(report.bySource['acme.com']?.total).toBe(2);
  });

  it('labels deterministic mode honestly', () => {
    const report = buildReport({
      target: 'https://acme.com',
      competitors: [],
      simulations: sims,
      model: 'x',
      simulatedAt: new Date().toISOString(),
      durationMs: 1,
      deterministic: true,
    });
    expect(report.model).toContain('deterministic');
  });

  it('renders a readable report', () => {
    const report = buildReport({ target: 'https://acme.com', competitors: [], simulations: sims, model: 'm', simulatedAt: '', durationMs: 1 });
    const text = formatSimulationReport(report);
    expect(text).toContain('Agent Visibility');
  });
});

describe('corpus building', () => {
  it('extracts products and their offers from JSON-LD', () => {
    const products = extractProducts([
      { '@type': 'Product', name: 'Widget', offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } },
    ]);
    expect(products[0]).toMatchObject({ name: 'Widget', price: 19.99, currency: 'USD', availability: 'InStock' });
  });

  it('extracts the organization name', () => {
    expect(extractOrganization([{ '@type': 'Organization', name: 'Acme' }])).toBe('Acme');
  });

  it('builds a corpus from a fixture site', async () => {
    const corpus = await buildCorpus({ url: excellentSite.origin, name: 'excellent.example' }, { fetchImpl: fixtureFetch(excellentSite) });
    expect(corpus.content.length).toBeGreaterThan(100);
    expect(corpus.signals['productCount']).toBeGreaterThan(0);
    expect(corpus.signals['hasPrices']).toBeTruthy();
  });

  it('never throws on a dead site', async () => {
    const dead = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const corpus = await buildCorpus({ url: 'https://dead.example', name: 'dead' }, { fetchImpl: dead });
    expect(corpus.content).toBe('');
    expect(corpus.signals['error']).toBeTruthy();
  });

  it('labels sites in the prompt', () => {
    const prompt = buildPrompt('what do you sell?', [{ name: 'acme.com', url: 'https://acme.com', content: 'Widgets' }]);
    expect(prompt).toContain('=== SITE: acme.com ===');
    expect(prompt).toContain('CUSTOMER QUERY');
  });
});

describe('end-to-end simulation', () => {
  it('runs deterministically without an API key', async () => {
    const report = await simulateAgentVisibility({
      target: excellentSite.origin,
      queries: ['What do you sell?', 'How much?'],
      // One persona so the query count is predictable (queries x personas).
      personas: ['shopping'],
      fetchImpl: fixtureFetch(excellentSite),
    });
    expect(report.queries).toHaveLength(2);
    expect(report.model).toContain('deterministic');
    expect(report.visibilityScore).toBeGreaterThan(0);
  });

  it('uses Groq when a key is present', async () => {
    const report = await simulateAgentVisibility({
      target: shopifySite.origin,
      queries: ['What do you sell?'],
      fetchImpl: fixtureFetch(shopifySite),
      groq: {
        apiKey: 'test',
        fetchImpl: mockGroq('They sell widgets.\nSOURCES: store.example\nANSWERABILITY: 85'),
      },
    });
    expect(report.model).not.toContain('deterministic');
    expect(report.queries[0]?.found).toBe(true);
  });

  it('has personas and default queries', () => {
    expect(Object.keys(PERSONAS).length).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_QUERIES.length).toBeGreaterThanOrEqual(6);
  });
});

describe('benchmarking', () => {
  it('requires at least one competitor', async () => {
    await expect(runBenchmark({ target: excellentSite.origin, competitors: [] })).rejects.toThrow(/competitor/);
  });

  it('ranks the target against a competitor', async () => {
    const result = await runBenchmark({
      target: excellentSite.origin,
      competitors: [shopifySite.origin],
      queries: ['What do you sell?'],
      fetchImpl: (input) => {
        const url = typeof input === 'string' ? input : input.url;
        return url.includes('excellent') ? fixtureFetch(excellentSite)(input) : fixtureFetch(shopifySite)(input);
      },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.report.queries.length).toBeGreaterThan(0);
  });

  it('renders a benchmark table', async () => {
    const result = await runBenchmark({
      target: excellentSite.origin,
      competitors: [shopifySite.origin],
      queries: ['What do you sell?'],
      fetchImpl: (input) => {
        const url = typeof input === 'string' ? input : input.url;
        return url.includes('excellent') ? fixtureFetch(excellentSite)(input) : fixtureFetch(shopifySite)(input);
      },
    });
    const text = formatBenchmark(result);
    expect(text).toContain('Benchmark');
    expect(text).toContain('your position');
  });

  it('compares two runs', async () => {
    const mk = (score: number) => ({
      target: 'https://acme.com',
      rows: [{ site: 'acme.com', name: 'acme.com', visibilityScore: score, winRate: 50, averageRank: 1, answerability: 50, verdict: 'x' }],
      rank: 1,
      total: 1,
      wins: [],
      losses: [],
      report: buildReport({ target: 'https://acme.com', competitors: [], simulations: [], model: 'm', simulatedAt: '', durationMs: 0 }),
      scannedAt: '',
      durationMs: 0,
    });
    const diff = compareBenchmarks(mk(50), mk(70));
    expect(diff.visibilityChange).toBe(20);
    expect(diff.improved).toHaveLength(1);
  });
});

describe('monitoring', () => {
  const up = () => new Response('ok', { status: 200 });

  it('summarizes uptime samples', () => {
    const report = summarizeUptime('https://x.example', [
      { checkedAt: '2026-01-01T00:00:00Z', ok: true, statusCode: 200, latencyMs: 100 },
      { checkedAt: '2026-01-01T00:01:00Z', ok: false, statusCode: 500, latencyMs: 200 },
    ]);
    expect(report.uptimeRatio).toBe(50);
    expect(report.avgLatencyMs).toBe(150);
    expect(report.failedChecks).toBe(1);
  });

  it('probes a healthy endpoint', async () => {
    const sample = await probeOnce('https://x.example', { fetchImpl: up as unknown as typeof fetch });
    expect(sample.ok).toBe(true);
    expect(sample.statusCode).toBe(200);
  });

  it('records a failure without throwing', async () => {
    const sample = await probeOnce('https://x.example', {
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    });
    expect(sample.ok).toBe(false);
    expect(sample.error).toContain('500');
  });

  it('aggregates over multiple samples', async () => {
    const report = await probeUptime('https://x.example', {
      fetchImpl: up as unknown as typeof fetch,
      samples: 3,
      intervalMs: 0,
    });
    expect(report.totalChecks).toBe(3);
    expect(report.uptimeRatio).toBe(100);
  });

  it('separates healthy from degraded endpoints', async () => {
    const result = await monitorEndpoints(
      { good: 'https://good.example', bad: 'https://bad.example' },
      {
        samples: 1,
        intervalMs: 0,
        fetchImpl: (async (input: string) =>
          input.includes('bad') ? new Response('', { status: 503 }) : new Response('ok', { status: 200 })) as unknown as typeof fetch,
      },
    );
    expect(result.healthy).toContain('good');
    expect(result.degraded.map((d) => d.name)).toContain('bad');
  });

  it('maps an MCP url to its health endpoint', () => {
    expect(mcpHealthUrl('https://x.workers.dev/mcp')).toBe('https://x.workers.dev/.well-known/mcp.json');
    expect(mcpHealthUrl('https://x.workers.dev')).toBe('https://x.workers.dev/.well-known/mcp.json');
  });

  it('describes uptime in one line', () => {
    const report = summarizeUptime('x', [{ checkedAt: '', ok: true, statusCode: 200, latencyMs: 10 }]);
    expect(describeUptime(report)).toContain('healthy');
  });

  it('windows samples by age', () => {
    const old = { checkedAt: '2020-01-01T00:00:00Z', ok: true, statusCode: 200, latencyMs: 1 };
    const fresh = { checkedAt: new Date().toISOString(), ok: true, statusCode: 200, latencyMs: 1 };
    expect(withinWindow([old, fresh], 24)).toHaveLength(1);
  });
});

describe('error bucketing', () => {
  it('groups similar errors and strips volatile ids', () => {
    const a = fingerprintError('Tool search_products failed on product 1234');
    const b = fingerprintError('Tool search_products failed on product 5678');
    expect(a).toBe(b);
  });

  it('separates genuinely different errors', () => {
    expect(fingerprintError('timeout connecting to db')).not.toBe(fingerprintError('tool not found'));
  });

  it('buckets and sorts by count', () => {
    const buckets = bucketErrors([
      { message: 'Tool X failed on product 1', at: '2026-01-01T00:00:00Z' },
      { message: 'Tool X failed on product 2', at: '2026-01-01T00:01:00Z' },
      { message: 'Something else entirely', at: '2026-01-01T00:02:00Z' },
    ]);
    expect(buckets[0]?.count).toBe(2);
  });
});

describe('alerts', () => {
  const scan = (score: number, checks = []) =>
    ({ url: 'https://x.example', score, checks, gaps: [] }) as never;

  it('fires on a significant score drop', () => {
    const alert = scoreRegressionAlert(scan(80), scan(60));
    expect(alert?.severity).toBe('warning');
    expect(alert?.message).toContain('dropped 20 points');
  });

  it('stays quiet on a small change', () => {
    expect(scoreRegressionAlert(scan(80), scan(78))).toBeUndefined();
  });

  it('fires when the MCP server goes down', () => {
    const alert = mcpHealthAlert({ serverName: 'acme', url: 'https://x/mcp', status: 'down', toolCount: 0, error: 'timeout' });
    expect(alert?.severity).toBe('critical');
  });

  it('fires when tools disappear', () => {
    const alert = mcpHealthAlert({ serverName: 'acme', url: 'https://x/mcp', status: 'live', toolCount: 2, previousToolCount: 5 });
    expect(alert?.title).toContain('lost tools');
    expect(alert?.message).toContain('down from 5');
  });

  it('stays quiet when nothing changed', () => {
    expect(mcpHealthAlert({ serverName: 'acme', url: 'https://x/mcp', status: 'live', toolCount: 5, previousToolCount: 5 })).toBeUndefined();
  });

  it('fires per drifted registry', () => {
    const alerts = registryDriftAlert([
      { name: 'official', label: 'Official', state: 'missing', listed: false },
      { name: 'smithery', label: 'Smithery', state: 'drifted', listed: true, detail: 'v1 vs v2' },
      { name: 'mcp-so', label: 'mcp.so', state: 'synced', listed: true },
    ] as never);
    expect(alerts).toHaveLength(2);
  });

  it('fires when uptime drops below the SLO', () => {
    const alert = uptimeAlert(summarizeUptime('x', [
      { checkedAt: '', ok: true, statusCode: 200, latencyMs: 10 },
      { checkedAt: '', ok: false, statusCode: 500, latencyMs: 10 },
    ]));
    expect(alert?.severity).toBe('critical');
  });

  it('stays quiet on good uptime', () => {
    expect(uptimeAlert(summarizeUptime('x', [{ checkedAt: '', ok: true, statusCode: 200, latencyMs: 10 }]))).toBeUndefined();
  });

  it('fires when agent visibility drops', () => {
    const alert = visibilityAlert({ target: 'https://x.example', previous: 80, current: 50 });
    expect(alert?.source).toBe('verification');
  });

  it('keeps only the highest severity per source', () => {
    const alerts = dedupeAlerts([
      buildAlert('info', 'uptime', 'a', 'a'),
      buildAlert('critical', 'uptime', 'b', 'b'),
      buildAlert('warning', 'mcp', 'c', 'c'),
    ]);
    expect(alerts).toHaveLength(2);
    expect(alerts.find((a) => a.source === 'uptime')?.severity).toBe('critical');
  });

  it('reports a missing recipient instead of silently dropping', async () => {
    const result = await dispatchAlert(buildAlert('warning', 'uptime', 't', 'm'), {
      recipients: [],
      transport: { send: async () => ({}) },
    });
    expect(result.errors[0]).toContain('recipient');
  });

  it('delivers to each recipient', async () => {
    const sent: string[] = [];
    await dispatchAlert(buildAlert('warning', 'uptime', 't', 'm'), {
      recipients: ['a@b.co', 'c@d.co'],
      transport: { send: async ({ to }) => { sent.push(to); return {}; } },
    });
    expect(sent).toHaveLength(2);
  });

  it('escapes HTML in the rendered alert', () => {
    const { html } = renderAlert(buildAlert('warning', 'uptime', '<script>x</script>', 'body'));
    expect(html).not.toContain('<script>x</script>');
  });
});