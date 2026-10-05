/**
 * Pillar 8 — Rate limiting & docs.
 *
 * An agent integrating your API needs two things spelled out: how much it may
 * call, and what happens when it exceeds that. Silent 429s and undocumented
 * limits are the most common reason agents give up on a site.
 */

import { buildResult, partial } from './base.js';
import type { ScanContext } from '../context.js';

const RATE_DOC =
  /\b(rate[\s_-]?limit|requests?[\s_-]?per[\s_-]?(second|minute|hour|day)|throttl\w*|quota|too many requests|429)\b/i;

export async function checkRateLimit(ctx: ScanContext) {
  const { page, headers } = ctx;

  const llmsTxt = ctx.wellKnown['/llms.txt'];
  const llmsFull = ctx.wellKnown['/llms-full.txt'];
  const hasLlmsTxt = Boolean(llmsTxt?.ok);

  // Documentation corpus: everything an agent would read before integrating.
  const docCorpus = [
    page.text,
    llmsTxt?.body ?? '',
    llmsFull?.body ?? '',
    ctx.wellKnown['/.well-known/openapi.json']?.body ?? '',
    ctx.wellKnown['/openapi.json']?.body ?? '',
  ].join('\n');

  const documentsLimits = RATE_DOC.test(docCorpus);
  const documentsQuota = /\b(daily|monthly|per month)[\s_-]?(quota|limit|cap)\b/i.test(docCorpus);

  // Live headers tell us the limit is real, not just written down.
  const headerLimits = ['ratelimit-limit', 'x-ratelimit-limit', 'ratelimit-remaining', 'x-ratelimit-remaining', 'retry-after']
    .filter((h) => headers[h] !== undefined);
  const advertisesHeaders = headerLimits.length > 0;

  // An OpenAPI spec is the strongest docs signal for autonomous agents.
  const openApi = ctx.wellKnown['/.well-known/openapi.json'] ?? ctx.wellKnown['/openapi.json'] ?? ctx.wellKnown['/api/openapi.json'];
  const hasOpenApi = Boolean(openApi?.ok);

  let has429Response = false;
  if (openApi?.body) {
    has429Response = /["']?429["']?\s*:/.test(openApi.body);
  }

  // Points: 2 llms.txt, 2 documented limits, 1 rate headers, 1 quota terms,
  //         1 OpenAPI spec.
  let points = 0;
  points += hasLlmsTxt ? 2 : 0;
  points += documentsLimits ? 2 : 0;
  points += advertisesHeaders ? 1 : 0;
  points += documentsQuota ? 1 * partial(1, 1) : 0;
  points += hasOpenApi ? 1 : 0;

  const status = documentsLimits && hasLlmsTxt ? 'pass' : documentsLimits || hasLlmsTxt ? 'warn' : 'fail';

  const fixes: string[] = [];
  if (!documentsLimits) {
    fixes.push(
      'State your rate limits in machine-readable docs: "rate limit: 60 requests/minute, 429 + Retry-After on exceed".',
    );
  }
  if (!advertisesHeaders) {
    fixes.push('Send RateLimit-Limit / RateLimit-Remaining headers (or X-RateLimit-*) on API responses.');
  }
  if (!documentsQuota) fixes.push('Publish your quota terms (daily/monthly caps) so agents can budget their calls.');
  if (!hasLlmsTxt) fixes.push('Add /llms.txt describing your API surface and limits.');
  if (!hasOpenApi) fixes.push('Publish an OpenAPI spec at /.well-known/openapi.json.');
  if (hasOpenApi && !has429Response) fixes.push('Document the 429 response shape in your OpenAPI spec.');

  const summary = documentsLimits && advertisesHeaders
    ? 'Rate limits are documented and advertised in headers.'
    : documentsLimits
      ? 'Rate limits are documented but not advertised in response headers.'
      : 'No documented rate limits. An agent cannot predict whether it will be throttled.';

  return buildResult(
    'rate-limit',
    status,
    points,
    summary,
    fixes,
    {
      hasLlmsTxt,
      documentsLimits,
      documentsQuota,
      advertisesHeaders,
      headerLimits,
      hasOpenApi,
      documents429: has429Response,
    },
  );
}