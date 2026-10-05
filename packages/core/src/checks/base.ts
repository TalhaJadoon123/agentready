import type { CheckIdCounted, CheckResult } from '@agentready/shared';
import { CHECK_MAX_POINTS, CHECK_TITLES, clamp, round } from '@agentready/shared';
import type { ScanContext } from '../context.js';
import { jsonLdTypes } from '../parser.js';

export type CheckFn = (ctx: ScanContext) => Promise<CheckResult>;

/** Small helper so every check builds a consistent, scored result. */
export function buildResult(
  id: CheckIdCounted,
  status: CheckResult['status'],
  points: number,
  summary: string,
  fixes: string[] = [],
  evidence: Record<string, unknown> = {},
): CheckResult {
  const maxPoints = CHECK_MAX_POINTS[id];
  return {
    id,
    title: '',
    status,
    points: round(clamp(points, 0, maxPoints), 2),
    maxPoints,
    summary,
    fixes,
    evidence,
    checkedAt: new Date().toISOString(),
  };
}

/** Linearity: fraction of a sub-signal that was satisfied. */
export function partial(got: number, total: number): number {
  if (total <= 0) return 0;
  return clamp(got / total, 0, 1);
}

/** Decorate results with the shared display title so callers never repeat it. */
export function titleize(results: CheckResult[]): CheckResult[] {
  return results.map((r) => ({ ...r, title: CHECK_TITLES[r.id] }));
}