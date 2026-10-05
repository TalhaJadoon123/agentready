/**
 * The AgentReady scanner.
 *
 * One pass: fetch the homepage, robots.txt, sitemap, the well-known agent
 * surface, and probe for a live MCP server. Then run all eight checks against
 * that single snapshot and score it.
 *
 * Concurrency is deliberate but bounded — we fan out the independent well-known
 * probes, but never hammer a target site with parallel requests.
 */

import type { ScanResult } from '@agentready/shared';
import { mapLimit, normalizeUrl, originOf, truncate, createGuardedFetch, assertFetchable } from '@agentready/shared';
import { fetchOnce, type FetchLike } from './fetcher.js';
import { parsePage } from './parser.js';
import { fetchRobots } from './robots.js';
import { discoverSitemap } from './sitemap.js';
import { probeMcpServer } from './mcp-probe.js';
import { emptyContext, WELL_KNOWN_PATHS, type ScanContext, type ScanOptions, type WellKnownKey, type WellKnownMap } from './context.js';
import { runChecks } from './checks/index.js';
import { titleize } from './checks/base.js';
import { assembleScan } from './score.js';

export const AGENTREADY_VERSION = '1.0.0';

/**
 * Probe a set of well-known paths concurrently (bounded).
 * Only successful responses retain a body — we do not want to carry 11 error
 * pages around in memory or in the persisted result.
 */
async function probeWellKnown(
  fetchImpl: FetchLike,
  origin: string,
  paths: readonly string[],
  timeoutMs: number,
): Promise<WellKnownMap> {
  const out: WellKnownMap = {};
  await mapLimit(paths, 6, async (path) => {
    const url = `${origin.replace(/\/$/, '')}${path}`;
    const res = await fetchOnce(fetchImpl, url, { timeoutMs });
    const key = path as WellKnownKey;
    // Keep small text bodies (JSON, txt, xml); drop large or binary payloads.
    const keepBody = res.ok && res.body.length <= 200_000 && !/binary|image|font|video/i.test(res.contentType ?? '');
    out[key] = {
      status: res.status,
      ok: res.ok,
      url,
      ...(res.contentType ? { contentType: res.contentType } : {}),
      ...(keepBody ? { body: res.body } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
  });
  return out;
}

/**
 * Scan a website for agent readiness.
 *
 * @param target Site URL; scheme is optional.
 * @param options Injection points for fetch/timeouts, plus which probes to run.
 */
export async function scanSite(target: string, options: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const scannedAt = new Date().toISOString();
  const url = normalizeUrl(target);
  const origin = originOf(url);

  // Refuse private/internal targets before making a single request. Without
  // this the scanner is an SSRF proxy into whatever network it runs on.
  const guardOptions = {
    ...(options.allowPrivateFetch !== undefined ? { allowPrivate: options.allowPrivateFetch } : {}),
    ...(options.resolve ? { resolve: options.resolve } : {}),
  };
  await assertFetchable(url, guardOptions);

  // An injected fetch is trusted (tests and in-process callers); a real one
  // is wrapped so every redirect hop is re-validated.
  const fetchImpl: FetchLike = options.fetch ?? createGuardedFetch((input, init) => fetch(input as string, init), guardOptions);
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxSitemapUrls = options.maxSitemapUrls ?? 50;

  // 1. The page itself. Everything depends on it.
  const pageRes = await fetchOnce(fetchImpl, url, {
    timeoutMs,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const html = pageRes.body;
  const page = parsePage(html, pageRes.url || url);

  // 2. robots.txt first — it declares the sitemap URL, so it gates discovery.
  const robots = await fetchRobots(fetchImpl, origin, timeoutMs);

  // 3. Everything else is independent; fan these out.
  const [sitemap, wellKnown, mcp] = await Promise.all([
    discoverSitemap(fetchImpl, origin, robots, maxSitemapUrls, timeoutMs),
    options.probeWellKnown === false
      ? Promise.resolve({} as WellKnownMap)
      : probeWellKnown(fetchImpl, origin, WELL_KNOWN_PATHS, Math.min(timeoutMs, 8_000)),
    options.probeMcp === false ? Promise.resolve(undefined) : probeMcpServer(fetchImpl, origin, timeoutMs),
  ]);

  // 4. Merge the freshly-discovered robots sitemaps into the context.
  const context: ScanContext = emptyContext({
    url,
    origin,
    finalUrl: pageRes.url || url,
    status: pageRes.status,
    responseMs: pageRes.responseMs,
    html,
    headers: pageRes.headers,
    page,
    robots: robots.sitemaps.length > 0 ? { ...robots, sitemapDeclared: true } : robots,
    sitemap,
    wellKnown,
    fetch: fetchImpl,
    options: { ...options, timeoutMs, maxSitemapUrls },
    checkedAt: scannedAt,
    ...(mcp ? { mcp } : {}),
  });

  if (options.skipChecks) {
    return assembleScan({ url, checks: [], scannedAt, durationMs: Date.now() - startedAt, version: AGENTREADY_VERSION });
  }

  const raw = await runChecks(context, options.onlyChecks);
  const checks = titleize(raw);

  return assembleScan({
    url,
    checks,
    ...(mcp ? { mcpServer: mcp } : {}),
    scannedAt,
    durationMs: Date.now() - startedAt,
    version: AGENTREADY_VERSION,
  });
}

/**
 * Scan a site and print a text report to stdout. Used by the CLI.
 * Purely presentational — kept beside the scanner so the CLI stays thin.
 */
export function formatScanReport(result: ScanResult, opts: { verbose?: boolean; color?: boolean } = {}): string {
  const { verbose = false, color = false } = opts;
  const paint = (text: string, code: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);

  const gradeColor = result.score >= 85 ? '32' : result.score >= 70 ? '36' : result.score >= 55 ? '33' : '31';
  const icon: Record<string, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };

  const lines: string[] = [];
  lines.push('');
  lines.push(`  Agent-Readiness Score: ${paint(`${result.score}/100 (${result.grade ?? '?'})`, gradeColor)}`);
  lines.push(`  ${paint(result.url, '4')}`);
  lines.push('');
  lines.push('  Pillar                      Score');
  lines.push('  --------------------------  ------------------');

  for (const check of result.checks) {
    const bar = `${check.points}/${check.maxPoints}`;
    const tag = paint(icon[check.status] ?? '????', check.status === 'pass' ? '32' : check.status === 'warn' ? '33' : '31');
    lines.push(`  ${check.title.padEnd(26)}  ${bar.padEnd(6)}  ${tag}`);
    if (verbose) lines.push(`      ${truncate(check.summary, 100)}`);
  }

  if (result.gaps.length > 0) {
    lines.push('');
    lines.push(`  Top ${Math.min(5, result.gaps.length)} fixes`);
    lines.push('  --------------------------  ------------------');
    for (const gap of result.gaps.slice(0, 5)) {
      lines.push(`  [${gap.severity.toUpperCase()}] ${truncate(gap.title, 78)}`);
      lines.push(`      ~${gap.effortMinutes} min`);
      if (verbose && gap.patch) lines.push(`      ${truncate(gap.patch, 100)}`);
    }
  }

  if (result.recommendations?.length) {
    lines.push('');
    lines.push('  Recommended next steps');
    lines.push('  --------------------------');
    for (const rec of result.recommendations) lines.push(`  - ${truncate(rec, 96)}`);
  }

  lines.push('');
  lines.push(`  Scanned in ${result.durationMs ?? 0}ms`);
  lines.push('');
  return lines.join('\n');
}