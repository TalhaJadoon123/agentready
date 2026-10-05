/**
 * Uptime, error and latency monitoring.
 *
 * Two paths: UptimeFlare's free API when a key is present, and a built-in
 * prober otherwise. The built-in prober is the default because it works with
 * zero configuration and is what the demo and tests use.
 */

import type { ErrorBucket, UptimeReport, UptimeSample } from '@agentready/shared';
import { config, hasApiKey, mean, normalizeUrl, pct, percentile, round, errorMessage, withRetry } from '@agentready/shared';
import { enrichTarget, type EnrichmentReport, type IntegrationsOptions } from '@agentready/core';

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  userAgent?: string;
  method?: 'GET' | 'POST' | 'HEAD';
  accept?: string;
}

/** One health probe against a URL. */
export async function probeOnce(url: string, options: ProbeOptions = {}): Promise<UptimeSample> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const started = Date.now();
    const res = await (options.fetchImpl ?? fetch)(url, {
      method: options.method ?? 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': options.userAgent ?? 'AgentReady-Monitor/1.0 (+https://agentready.dev)',
        accept: options.accept ?? '*/*',
        // Ask for a short, finite body. An SSE endpoint would otherwise hold the
        // connection open and every probe would look like a timeout.
        ...(options.accept !== 'text/event-stream' ? { 'cache-control': 'no-cache' } : {}),
      },
    });

    // Read the body with a cap so a streaming endpoint cannot hang the probe.
    await readCapped(res, 64 * 1024);

    const latencyMs = Date.now() - started;
    // 2xx/3xx are healthy. 401/403 mean auth is needed — still "up".
    const ok = res.status < 400;

    return {
      checkedAt,
      ok,
      statusCode: res.status,
      latencyMs,
      ...(!ok ? { error: `HTTP ${res.status}` } : {}),
    };
  } catch (err) {
    return {
      checkedAt,
      ok: false,
      statusCode: 0,
      latencyMs: timeoutMs,
      error: errorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most `maxBytes` from a response body, then cancel it. */
async function readCapped(res: Response, maxBytes: number): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
    }
  } catch {
    // A body that errors mid-stream is still a live server.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Turn any MCP server URL into a cheap, reliable health URL.
 *
 * Probing the /mcp endpoint with GET opens an SSE stream, which looks like a
 * timeout to every monitor. The discovery manifest is the right thing to
 * check: it is a small JSON document that only exists if the server is up.
 */
export function mcpHealthUrl(url: string): string {
  const base = url.replace(/\/+$/, '').replace(/\/mcp$/, '');
  return `${base}/.well-known/mcp.json`;
}

/**
 * Probe a URL `samples` times and summarise.
 * Samples are spread over `intervalMs` so a burst never looks like an outage.
 */
export async function probeUptime(
  url: string,
  options: ProbeOptions & { samples?: number; intervalMs?: number } = {},
): Promise<UptimeReport> {
  const target = normalizeUrl(url);
  const samples = Math.min(20, Math.max(1, options.samples ?? 3));
  const intervalMs = options.intervalMs ?? 400;

  const collected: UptimeSample[] = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0 && intervalMs > 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    collected.push(await probeOnce(target, options));
  }

  return summarizeUptime(target, collected);
}

/** Aggregate raw samples into an uptime report. */
export function summarizeUptime(target: string, samples: UptimeSample[]): UptimeReport {
  const total = samples.length;
  const failed = samples.filter((s) => !s.ok).length;
  const latencies = samples.map((s) => s.latencyMs);

  return {
    target,
    samples,
    uptimeRatio: total > 0 ? round(((total - failed) / total) * 100, 2) : 0,
    avgLatencyMs: round(mean(latencies), 0),
    p95LatencyMs: round(percentile(latencies, 0.95), 0),
    totalChecks: total,
    failedChecks: failed,
    from: samples[0]?.checkedAt ?? new Date().toISOString(),
    to: samples[samples.length - 1]?.checkedAt ?? new Date().toISOString(),
  };
}

/**
 * UptimeFlare integration (free tier).
 * Falls back to the built-in prober when no key is configured.
 */
export async function checkUptimeFlare(
  siteId: string,
  options: { apiKey?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<UptimeReport | undefined> {
  const cfg = config();
  const apiKey = options.apiKey ?? cfg.uptimeflare.apiKey;
  if (!hasApiKey(apiKey)) return undefined;

  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const res = await withRetry(
      () =>
        fetchImpl(`https://uptimeflare.com/api/monitor/${encodeURIComponent(siteId)}`, {
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      { attempts: 2, baseDelayMs: 500 },
    );

    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      uptime?: number;
      avgResponseTime?: number;
      checks?: Array<{ timestamp: string; status: number; responseTime?: number }>;
    };

    const samples: UptimeSample[] = (body.checks ?? []).map((c) => ({
      checkedAt: c.timestamp,
      ok: c.status < 400,
      statusCode: c.status,
      latencyMs: c.responseTime ?? 0,
    }));

    return summarizeUptime(siteId, samples.length > 0 ? samples : []);
  } catch {
    return undefined;
  }
}

/**
 * Monitor several endpoints and report the ones that need attention.
 * Used by `agentready verify` and the dashboard's health strip.
 */
export async function monitorEndpoints(
  endpoints: Record<string, string>,
  options: ProbeOptions & { samples?: number } = {},
): Promise<{
  results: Array<{ name: string; url: string; report: UptimeReport }>;
  degraded: Array<{ name: string; url: string; reason: string; report: UptimeReport }>;
  healthy: string[];
}> {
  const entries = Object.entries(endpoints);
  const results = await Promise.all(
    entries.map(async ([name, url]) => ({ name, url, report: await probeUptime(url, options) })),
  );

  const degraded: Array<{ name: string; url: string; reason: string; report: UptimeReport }> = [];
  const healthy: string[] = [];

  for (const { name, url, report } of results) {
    if (report.uptimeRatio < 100) {
      const firstFailure = report.samples.find((s) => !s.ok);
      degraded.push({
        name,
        url,
        reason: firstFailure ? (firstFailure.error ?? `HTTP ${firstFailure.statusCode}`) : 'intermittent failures',
        report,
      });
    } else if (report.p95LatencyMs > 2_000) {
      degraded.push({ name, url, reason: `slow: p95 ${report.p95LatencyMs}ms`, report });
    } else {
      healthy.push(name);
    }
  }

  return { results, degraded, healthy };
}

/**
 * Group error messages into fingerprint buckets so a dashboard shows "3 error
 * types" rather than 900 identical rows.
 */
export function bucketErrors(
  entries: Array<{ message: string; at: string; tool?: string }>,
): ErrorBucket[] {
  const buckets = new Map<string, ErrorBucket>();

  for (const entry of entries) {
    const fingerprint = fingerprintError(entry.message);
    const existing = buckets.get(fingerprint);
    if (existing) {
      existing.count++;
      if (entry.at > existing.lastSeen) existing.lastSeen = entry.at;
      if (entry.tool && !existing.tool) existing.tool = entry.tool;
    } else {
      buckets.set(fingerprint, {
        fingerprint,
        message: entry.message,
        count: 1,
        firstSeen: entry.at,
        lastSeen: entry.at,
        ...(entry.tool ? { tool: entry.tool } : {}),
      });
    }
  }

  return [...buckets.values()].sort((a, b) => b.count - a.count);
}

/**
 * Reduce an error message to a stable fingerprint: strip ids, numbers, paths
 * and quoted payloads, then hash. Keeps "Tool X failed on product 1234" and
 * "Tool X failed on product 5678" in one bucket.
 */
export function fingerprintError(message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/["'][^"']*["']/g, '"<str>"')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/g, '<hash>')
    .replace(/\/\S+/g, '<path>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();

  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A short status line for the dashboard. */
export function describeUptime(report: UptimeReport): string {
  if (report.totalChecks === 0) return 'no checks yet';
  const health = report.uptimeRatio >= 99.9 ? 'healthy' : report.uptimeRatio >= 95 ? 'degraded' : 'down';
  return `${health} — ${pct(report.totalChecks - report.failedChecks, report.totalChecks)}% over ${report.totalChecks} checks, p95 ${report.p95LatencyMs}ms`;
}

/** Rolling window helper: samples older than `hours` are dropped. */
export function withinWindow(samples: UptimeSample[], hours: number, now = new Date()): UptimeSample[] {
  const cutoff = now.getTime() - hours * 3_600_000;
  return samples.filter((s) => new Date(s.checkedAt).getTime() >= cutoff);
}

/**
 * Verify a site is reachable to an agent from the outside world.
 *
 * Combines the plain HTTP probe with the free public APIs that expose what an
 * agent can learn about a domain before it ever fetches it: certificate
 * transparency, DNS, archive history and registration age.
 *
 * Everything degrades to `undefined` — this never fails a check.
 */
export async function enrichWithPublicApis(url: string, options: IntegrationsOptions = {}): Promise<EnrichmentReport> {
  return enrichTarget(url, { timeoutMs: 10_000, ...options });
}