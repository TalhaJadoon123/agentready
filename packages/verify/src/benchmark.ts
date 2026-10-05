/**
 * Benchmarking: rank the target against named competitors.
 *
 * Runs the same query set across every site and produces a head-to-head table.
 * This is the "am I winning" view the dashboard leads with, and the artifact a
 * customer forwards to their boss.
 */

import type { Simulation, SimulationReport } from '@agentready/shared';
import { mean, normalizeUrl, originOf, round, clamp } from '@agentready/shared';
import { scanSite } from '@agentready/core';
import { siteName, normalizeName } from './names.js';
import { simulateAgentVisibility, formatSimulationReport, DEFAULT_QUERIES, type PersonaName } from './simulate.js';
import type { GroqOptions } from './groq.js';

export interface BenchmarkInput {
  target: string;
  competitors: string[];
  queries?: string[];
  personas?: PersonaName[];
  siteName?: string;
  /** Also readiness-scan every site. Slower, but the correlation is the point. */
  includeScan?: boolean;
  fetchImpl?: typeof fetch;
  groq?: GroqOptions;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface BenchmarkRow {
  site: string;
  name: string;
  visibilityScore: number;
  winRate: number;
  averageRank: number;
  answerability: number;
  /** Present when includeScan is on. */
  readinessScore?: number;
  grade?: string;
  verdict: string;
}

export interface BenchmarkResult {
  target: string;
  rows: BenchmarkRow[];
  /** The target's position in the ranking, 1-based. */
  rank: number;
  total: number;
  /** Queries where the target beat the field. */
  wins: string[];
  /** Queries where it lost. */
  losses: string[];
  report: SimulationReport;
  scannedAt: string;
  durationMs: number;
}

/** Run a head-to-head benchmark. */
export async function runBenchmark(input: BenchmarkInput): Promise<BenchmarkResult> {
  const started = Date.now();
  const target = normalizeUrl(input.target);
  const competitors = input.competitors.map(normalizeUrl);

  if (competitors.length === 0) {
    // A benchmark against nobody is a simulation; do not pretend otherwise.
    throw new Error('A benchmark needs at least one competitor. Use `agentready simulate` for a single-site check.');
  }

  const queries = input.queries ?? DEFAULT_QUERIES;

  // 1. One simulation covering every site at once — that is the head-to-head.
  const report = await simulateAgentVisibility({
    target,
    competitors,
    queries,
    ...(input.personas ? { personas: input.personas } : {}),
    ...(input.siteName ? { siteName: input.siteName } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.groq ? { groq: input.groq } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });

  // 2. Optional readiness scan per site.
  const scanScores = new Map<string, { score: number; grade: string }>();
  if (input.includeScan) {
    const sites = [target, ...competitors];
    const scanned = await Promise.all(
      sites.map(async (url) => {
        try {
          const result = await scanSite(url, {
            ...(input.fetchImpl ? { fetch: input.fetchImpl } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
            probeMcp: false,
          });
          return [originOf(url), { score: result.score, grade: result.grade ?? '-' }] as const;
        } catch {
          return [originOf(url), { score: 0, grade: '-' }] as const;
        }
      }),
    );
    for (const [key, value] of scanned) scanScores.set(key, value);
  }

  // 3. Build the ranking.
  const rows: BenchmarkRow[] = Object.entries(report.bySource)
    .map(([site, stats]) => {
      const cited = stats.found;
      const total = Math.max(1, stats.total);
      const winRate = round((cited / total) * 100, 1);
      const avgRank = stats.avgRank;
      // Per-site visibility mirrors the composite formula, computed from its
      // own citation share and rank.
      const rankScore = avgRank > 0 ? (avgRank <= 1 ? 30 : avgRank <= 2 ? 22 : avgRank <= 3 ? 14 : 6) : 0;
      const visibilityScore = round(clamp(winRate * 0.5 + rankScore + report.answerability * 0.2, 0, 100), 1);
      const scan = scanScores.get(site);
      return {
        site,
        name: site,
        visibilityScore,
        winRate,
        averageRank: avgRank,
        answerability: report.answerability,
        ...(scan ? { readinessScore: scan.score, grade: scan.grade } : {}),
        verdict: verdictFor(visibilityScore, scan?.score),
      };
    })
    .sort((a, b) => b.visibilityScore - a.visibilityScore);

  const targetKey = siteName(target);
  const rank = rows.findIndex((r) => r.name === targetKey) + 1;

  // 4. Per-query win/loss for the target.
  const wins: string[] = [];
  const losses: string[] = [];
  for (const sim of report.queries) {
    const targetResult = sim.results.find(
      (r) => normalizeName(String((r as { source: string }).source)) === normalizeName(targetKey),
    ) as { cited?: boolean; rank?: number } | undefined;
    const rivalRanks = sim.results
      .filter((r) => normalizeName(String((r as { source: string }).source)) !== normalizeName(targetKey))
      .map((r) => ((r as { rank?: number }).rank ?? 0) as number)
      .filter((n) => n > 0);

    if (!targetResult?.cited) {
      losses.push(sim.query);
    } else if (rivalRanks.length === 0 || (targetResult.rank ?? 99) <= Math.min(...rivalRanks)) {
      wins.push(sim.query);
    } else {
      losses.push(sim.query);
    }
  }

  return {
    target,
    rows,
    rank: rank || rows.length,
    total: rows.length,
    wins,
    losses,
    report,
    scannedAt: report.simulatedAt,
    durationMs: Date.now() - started,
  };
}

function verdictFor(visibility: number, readiness?: number): string {
  if (visibility >= 75) return 'Strong — agents recommend you first';
  if (visibility >= 50) return 'Competitive — present but not preferred';
  if (visibility >= 25) return 'Weak — agents mention you rarely';
  if (readiness !== undefined && readiness >= 70 && visibility < 25) {
    return 'Underperforming — your readiness score is high but agents are not citing you';
  }
  return 'Invisible — agents are not finding you';
}



/** Render a benchmark as a text table. */
export function formatBenchmark(result: BenchmarkResult): string {
  const lines: string[] = [];
  const targetKey = siteName(result.target);

  lines.push('');
  lines.push(`  Benchmark: you vs ${result.total - 1} competitor${result.total - 1 === 1 ? '' : 's'}`);
  lines.push('');
  lines.push('  #  Site                        Visibility  Cited   Rank   Readiness');
  lines.push('  -- --------------------------- ----------  ------  -----  ---------');

  result.rows.forEach((row, i) => {
    const readiness = row.readinessScore !== undefined ? `${row.readinessScore}/100 (${row.grade})` : '—';
    lines.push(
      `  ${String(i + 1).padStart(2)} ${row.name.slice(0, 27).padEnd(27)}  ${String(row.visibilityScore).padStart(9)}  ${(row.winRate + '%').padStart(6)}  ${(row.averageRank > 0 ? row.averageRank.toFixed(1) : '—').padStart(5)}  ${readiness}`,
    );
    if (row.name === targetKey) {
      lines.push(`     └─ your position: #${result.rank} of ${result.total} — ${row.verdict}`);
    }
  });

  if (result.wins.length > 0) {
    lines.push('');
    lines.push(`  Won ${result.wins.length} of ${result.report.queries.length} queries`);
  }
  if (result.losses.length > 0) {
    lines.push('');
    lines.push('  Lost queries (fix these first)');
    for (const q of result.losses.slice(0, 5)) lines.push(`    - ${q}`);
    if (result.losses.length > 5) lines.push(`    ... and ${result.losses.length - 5} more`);
  }

  lines.push('');
  lines.push(formatSimulationReport(result.report).split('\n').slice(1).join('\n'));
  lines.push('');
  return lines.join('\n');
}

/** Compare two benchmark runs to show movement over time. */
export function compareBenchmarks(before: BenchmarkResult, after: BenchmarkResult): {
  rankChange: number;
  visibilityChange: number;
  improved: string[];
  regressed: string[];
} {
  const beforeScores = new Map(before.rows.map((r) => [r.name, r.visibilityScore]));
  const beforeRanks = new Map(before.rows.map((r, i) => [r.name, i + 1]));
  const afterRanks = new Map(after.rows.map((r, i) => [r.name, i + 1]));

  const targetKey = siteName(after.target);
  const rankChange = (beforeRanks.get(targetKey) ?? 0) - (afterRanks.get(targetKey) ?? 0);
  const visibilityChange = round(
    (after.rows.find((r) => r.name === targetKey)?.visibilityScore ?? 0) - (beforeScores.get(targetKey) ?? 0),
    1,
  );

  const improved: string[] = [];
  const regressed: string[] = [];
  for (const row of after.rows) {
    const delta = row.visibilityScore - (beforeScores.get(row.name) ?? 0);
    if (delta > 3) improved.push(`${row.name} +${delta.toFixed(1)}`);
    else if (delta < -3) regressed.push(`${row.name} ${delta.toFixed(1)}`);
  }

  return { rankChange, visibilityChange, improved, regressed };
}

/** Average visibility across a set of reports — used for the dashboard trend. */
export function averageVisibility(reports: SimulationReport[]): number {
  if (reports.length === 0) return 0;
  return round(mean(reports.map((r) => r.visibilityScore)), 1);
}

/** Extract just the queries the target won, for reporting. */
export function winningQueries(report: SimulationReport, target: string): Simulation[] {
  const key = normalizeName(siteName(target));
  return report.queries.filter((s) =>
    s.results.some(
      (r) => normalizeName(String((r as { source: string }).source)) === key && (r as { cited?: boolean }).cited,
    ),
  );
}