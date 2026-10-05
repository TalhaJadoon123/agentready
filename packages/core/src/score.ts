/**
 * Score aggregation and gap prioritization.
 *
 * The score is the sum of each check's earned points (weights total 100).
 * Gaps are ranked by points-at-stake against effort, so a 15-minute fix that
 * unlocks 20 points outranks a two-hour fix that unlocks 5.
 */

import type { CheckIdCounted, CheckResult, Gap, ScanResult } from '@agentready/shared';
import { CHECK_MAX_POINTS, clamp, round, scoreToGrade, stableId } from '@agentready/shared';

/** Sum earned points into a 0-100 score. */
export function computeScore(checks: CheckResult[]): number {
  const total = checks.reduce((sum, c) => sum + c.points, 0);
  return round(clamp(total, 0, 100), 1);
}

/** How much of the available points did we earn overall? */
export function scorePercent(checks: CheckResult[]): number {
  const max = checks.reduce((sum, c) => sum + c.maxPoints, 0);
  if (max === 0) return 0;
  return round((checks.reduce((s, c) => s + c.points, 0) / max) * 100, 1);
}

type Severity = Gap['severity'];

function severityFor(pointsLost: number, maxPoints: number): Severity {
  const ratio = maxPoints > 0 ? pointsLost / maxPoints : 0;
  if (ratio >= 0.75) return 'critical';
  if (ratio >= 0.5) return 'high';
  if (ratio >= 0.25) return 'medium';
  return 'low';
}

/**
 * Estimated minutes to fix, keyed by which check lost the points.
 * These are deliberately conservative and assume the fix is pasted in.
 */
const BASE_EFFORT: Record<CheckIdCounted, number> = {
  'mcp-server': 45,
  'structured-data': 25,
  pricing: 20,
  'agent-content': 40,
  transactability: 90,
  availability: 15,
  auth: 60,
  'rate-limit': 15,
};

/**
 * Build the prioritized gap list.
 *
 * impact = points lost, adjusted so the cheapest high-value fix ranks first.
 * We use points-lost / sqrt(effort) which is a mild version of cost-benefit
 * ordering and avoids the noise of dividing by very small efforts.
 */
export function buildGaps(checks: CheckResult[]): Gap[] {
  const gaps: Gap[] = [];

  for (const check of checks) {
    const pointsLost = round(check.maxPoints - check.points, 2);
    if (pointsLost <= 0) continue;

    const baseEffort = BASE_EFFORT[check.id] ?? 20;
    // More findings inside one check means more surface to fix, but with
    // diminishing returns — the first fix carries most of the value.
    const fixCount = Math.max(1, check.fixes.length);
    const effortMinutes = round(baseEffort * (0.6 + 0.25 * Math.min(fixCount, 4)), 0);
    const impact = round(pointsLost / Math.sqrt(Math.max(effortMinutes, 5)), 3);
    const severity = severityFor(pointsLost, check.maxPoints);

    gaps.push({
      id: stableId('gap', check.id, check.status),
      checkId: check.id,
      title: check.summary,
      description: `${check.title}: ${check.points}/${check.maxPoints} points. ${check.summary}`,
      impact,
      effortMinutes,
      severity,
      patch: check.fixes[0],
    });
  }

  return gaps.sort((a, b) => {
    const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    return b.impact - a.impact;
  });
}

/** Top-line, plain-language next steps derived from the failed checks. */
export function buildRecommendations(checks: CheckResult[], mcpToolCount: number): string[] {
  const out: string[] = [];
  const by = (id: CheckIdCounted) => checks.find((c) => c.id === id);

  const mcp = by('mcp-server');
  if (mcp && mcp.status !== 'pass') {
    out.push(
      mcp.status === 'fail'
        ? 'Ship an MCP server from your catalogue — it is the highest-leverage fix (20 points).'
        : 'Finish your MCP tool surface: add the missing commerce tools and publish a /.well-known/mcp.json manifest.',
    );
  }

  const sd = by('structured-data');
  if (sd && sd.status !== 'pass') out.push('Add JSON-LD Product + Offer + Organization markup with price, currency and availability.');

  const tx = by('transactability');
  if (tx && tx.status !== 'pass') out.push('Add a place_order tool so an agent can complete a purchase without a human.');

  const price = by('pricing');
  if (price && price.status !== 'pass') out.push('Publish public pricing in structured data — gated pricing removes you from agent answers.');

  const content = by('agent-content');
  if (content && content.status !== 'pass') out.push('Add /llms.txt and question-shaped headings; agents answer from those first.');

  const auth = by('auth');
  if (auth && auth.status !== 'pass') out.push('Publish OAuth discovery documents so agents can authenticate unattended.');

  if (mcpToolCount > 0 && (mcp?.status ?? 'fail') === 'pass') {
    out.push(`Register your MCP server with the official registry so agents can find it (${mcpToolCount} tools available).`);
  }

  return out;
}

/** Assemble a complete ScanResult from raw check output. */
export function assembleScan(input: {
  url: string;
  checks: CheckResult[];
  mcpServer?: ScanResult['mcpServer'];
  scannedAt: string;
  durationMs: number;
  userAgent?: string;
  version?: string;
}): ScanResult {
  const score = computeScore(input.checks);
  return {
    url: input.url,
    score,
    checks: input.checks,
    gaps: buildGaps(input.checks),
    ...(input.mcpServer ? { mcpServer: input.mcpServer } : {}),
    grade: scoreToGrade(score),
    recommendations: buildRecommendations(input.checks, input.mcpServer?.tools.length ?? 0),
    scannedAt: input.scannedAt,
    durationMs: input.durationMs,
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    ...(input.version ? { version: input.version } : {}),
  };
}

/** Maximum possible score, useful for progress bars in the dashboard. */
export const MAX_SCORE = Object.values(CHECK_MAX_POINTS).reduce((a, b) => a + b, 0);