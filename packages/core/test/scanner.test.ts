/**
 * Scanner tests.
 *
 * The central claim of the product is "this score means something", so the
 * tests assert both directions: a well-built site scores high, and a badly
 * built one scores low — with twelve fixtures covering the space in between.
 */

import { describe, expect, it } from 'vitest';
import { scanSite, formatScanReport } from '../src/scanner.js';
import { computeScore, buildGaps } from '../src/score.js';
import { CHECK_IDS, CHECK_MAX_POINTS, scoreToGrade } from '@agentready/shared';
import { MAX_SCORE } from '../src/score.js';
import { FIXTURES, fixtureFetch, type Fixture } from './fixtures.js';

describe('scanner', () => {
  it('exposes exactly eight checks whose weights total 100', () => {
    expect(CHECK_IDS).toHaveLength(8);
    const total = CHECK_IDS.reduce((sum, id) => sum + CHECK_MAX_POINTS[id], 0);
    expect(total).toBe(100);
    expect(MAX_SCORE).toBe(100);
  });

  for (const fixture of FIXTURES) {
    describe(`${fixture.name} (${fixture.origin})`, () => {
      const scan = () => scanSite(fixture.origin, { fetch: fixtureFetch(fixture) });

      it(`scores within ${fixture.expect.min}-${fixture.expect.max} (${fixture.expect.grade})`, async () => {
        const result = await scan();
        // eslint-disable-next-line no-console
        console.log(
          `${fixture.name.padEnd(16)} ${String(result.score).padStart(5)}/100 ${result.grade}  ${result.checks
            .map((c) => `${c.id}=${c.status[0].toUpperCase()}`)
            .join(' ')}`,
        );
        expect(result.score).toBeGreaterThanOrEqual(fixture.expect.min);
        expect(result.score).toBeLessThanOrEqual(fixture.expect.max);
        expect(scoreToGrade(result.score)).toBe(fixture.expect.grade);
      });

      it('returns all eight checks with a consistent total', async () => {
        const result = await scan();
        expect(result.checks).toHaveLength(8);
        expect(computeScore(result.checks)).toBe(result.score);
        for (const check of result.checks) {
          expect(check.maxPoints).toBe(CHECK_MAX_POINTS[check.id]);
          expect(check.points).toBeLessThanOrEqual(check.maxPoints);
          expect(check.points).toBeGreaterThanOrEqual(0);
          expect(check.title).not.toBe('');
          expect(check.summary.length).toBeGreaterThan(0);
        }
      });

      it('produces prioritized, actionable gaps', async () => {
        const result = await scan();
        expect(Array.isArray(result.gaps)).toBe(true);

        // Ordering contract: severity first (critical before low), then impact
        // descending within a severity band.
        const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
        for (let i = 1; i < result.gaps.length; i++) {
          const prev = result.gaps[i - 1]!;
          const cur = result.gaps[i]!;
          expect(rank[prev.severity]).toBeLessThanOrEqual(rank[cur.severity]);
          if (prev.severity === cur.severity) {
            expect(prev.impact).toBeGreaterThanOrEqual(cur.impact - 0.001);
          }
        }

        for (const gap of result.gaps) {
          expect(gap.effortMinutes).toBeGreaterThan(0);
          expect(['critical', 'high', 'medium', 'low']).toContain(gap.severity);
          expect(gap.title.length).toBeGreaterThan(0);
        }
      });

      it('renders a report without throwing', async () => {
        const result = await scan();
        const report = formatScanReport(result);
        expect(report).toContain('Agent-Readiness Score');
        expect(report).toContain(fixture.origin);
      });
    });
  }
});

describe('scoring behaviour', () => {
  it('ranks the reference implementation above every other fixture', async () => {
    const scored = await Promise.all(
      FIXTURES.map(async (f) => ({ name: f.name, score: (await scanSite(f.origin, { fetch: fixtureFetch(f) })).score })),
    );
    const sorted = [...scored].sort((a, b) => b.score - a.score);

    // eslint-disable-next-line no-console
    console.table(sorted);

    expect(sorted[0]!.name).toBe('excellent');
    const worst = sorted[sorted.length - 1]!;
    expect(sorted[0]!.score).toBeGreaterThan(worst.score + 40);
  });

  it('scores a site with everything present far above one with nothing', async () => {
    const excellent = FIXTURES.find((f) => f.name === 'excellent')!;
    const bare = FIXTURES.find((f) => f.name === 'bare')!;

    const good = await scanSite(excellent.origin, { fetch: fixtureFetch(excellent) });
    const bad = await scanSite(bare.origin, { fetch: fixtureFetch(bare) });

    expect(good.score).toBeGreaterThanOrEqual(80);
    expect(bad.score).toBeLessThanOrEqual(5);
  });

  it('penalises robots.txt blocking', async () => {
    const blocked = FIXTURES.find((f) => f.name === 'robots-blocked')!;
    const excellent = FIXTURES.find((f) => f.name === 'excellent')!;

    const blockedResult = await scanSite(blocked.origin, { fetch: fixtureFetch(blocked) });
    const goodResult = await scanSite(excellent.origin, { fetch: fixtureFetch(excellent) });

    // Same sort of markup, different crawl policy: the blocked site must lose.
    expect(blockedResult.score).toBeLessThan(goodResult.score);
  });

  it('treats a 5xx as a near-total failure', async () => {
    const down = FIXTURES.find((f) => f.name === 'erroring')!;
    const result = await scanSite(down.origin, { fetch: fixtureFetch(down) });
    expect(result.score).toBeLessThanOrEqual(10);
    const availability = result.checks.find((c) => c.id === 'availability');
    expect(availability?.status).toBe('fail');
    expect(availability?.evidence['httpStatus']).toBe(503);
  });
});

describe('scanner robustness', () => {
  it('never throws when the network fails entirely', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await scanSite('https://unreachable.example', { fetch: failing, timeoutMs: 500 });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(20);
    expect(result.checks).toHaveLength(8);
  });

  it('normalises URLs that omit a scheme', async () => {
    const excellent = FIXTURES.find((f) => f.name === 'excellent')!;
    const result = await scanSite('excellent.example', { fetch: fixtureFetch(excellent) });
    expect(result.url).toBe('https://excellent.example');
  });

  it('strips a trailing slash consistently', async () => {
    const excellent = FIXTURES.find((f) => f.name === 'excellent')!;
    const a = await scanSite('https://excellent.example/', { fetch: fixtureFetch(excellent) });
    const b = await scanSite('https://excellent.example', { fetch: fixtureFetch(excellent) });
    expect(a.url).toBe(b.url);
  });

  it('can restrict which checks run', async () => {
    const excellent = FIXTURES.find((f) => f.name === 'excellent')!;
    const result = await scanSite(excellent.origin, {
      fetch: fixtureFetch(excellent),
      onlyChecks: ['structured-data'],
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.id).toBe('structured-data');
  });

  it('records the MCP server when one is live', async () => {
    const excellent = FIXTURES.find((f) => f.name === 'excellent')!;
    const result = await scanSite(excellent.origin, { fetch: fixtureFetch(excellent) });
    expect(result.mcpServer?.status).toBe('live');
    expect(result.mcpServer?.url).toContain('/mcp');
  });

  it('is deterministic for a given fixture', async () => {
    const shopify = FIXTURES.find((f) => f.name === 'shopify')!;
    const first = await scanSite(shopify.origin, { fetch: fixtureFetch(shopify) });
    const second = await scanSite(shopify.origin, { fetch: fixtureFetch(shopify) });
    expect(first.score).toBe(second.score);
  });
});