/** Registry of all eight readiness checks, in report order. */

import type { CheckIdCounted, CheckResult } from '@agentready/shared';
import type { CheckFn } from './base.js';
import type { ScanContext } from '../context.js';
import { checkStructuredData } from './structured-data.js';
import { checkMcpServer } from './mcp-server.js';
import { checkAgentContent } from './agent-content.js';
import { checkPricing } from './pricing.js';
import { checkAvailability } from './availability.js';
import { checkTransactability } from './transactability.js';
import { checkAuth } from './auth.js';
import { checkRateLimit } from './rate-limit.js';

export * from './base.js';
export { checkStructuredData } from './structured-data.js';
export { checkMcpServer } from './mcp-server.js';
export { checkAgentContent, detectFramework } from './agent-content.js';
export { checkPricing } from './pricing.js';
export { checkAvailability } from './availability.js';
export { checkTransactability } from './transactability.js';
export { checkAuth } from './auth.js';
export { checkRateLimit } from './rate-limit.js';

export interface RegisteredCheck {
  id: CheckIdCounted;
  fn: CheckFn;
}

/** All checks, ordered by points weight so reports lead with what matters most. */
export const ALL_CHECKS: RegisteredCheck[] = [
  { id: 'mcp-server', fn: checkMcpServer },
  { id: 'structured-data', fn: checkStructuredData },
  { id: 'pricing', fn: checkPricing },
  { id: 'agent-content', fn: checkAgentContent },
  { id: 'transactability', fn: checkTransactability },
  { id: 'availability', fn: checkAvailability },
  { id: 'auth', fn: checkAuth },
  { id: 'rate-limit', fn: checkRateLimit },
];

export const CHECKS_BY_ID: Record<CheckIdCounted, CheckFn> = Object.fromEntries(
  ALL_CHECKS.map((c) => [c.id, c.fn]),
) as Record<CheckIdCounted, CheckFn>;

/**
 * Run one check. A throwing check is downgraded to a `skip` result rather than
 * failing the whole scan — a partial report is far more useful than none.
 */
export async function runCheck(check: RegisteredCheck, ctx: ScanContext): Promise<CheckResult> {
  try {
    return await check.fn(ctx);
  } catch (err) {
    return {
      id: check.id,
      title: '',
      status: 'skip',
      points: 0,
      maxPoints: 0,
      summary: `Check could not run: ${err instanceof Error ? err.message : String(err)}`,
      fixes: [],
      evidence: { error: true },
      checkedAt: new Date().toISOString(),
    };
  }
}

/** Run a named subset, or all eight when no ids are given. */
export async function runChecks(ctx: ScanContext, ids?: CheckIdCounted[]): Promise<CheckResult[]> {
  const selected = ids?.length ? ALL_CHECKS.filter((c) => ids.includes(c.id)) : ALL_CHECKS;
  const results: CheckResult[] = [];
  for (const check of selected) {
    results.push(await runCheck(check, ctx));
  }
  return results;
}