/**
 * Pillar 5 — Availability signals.
 *
 * An agent asked to "buy X" must know whether X exists. Availability in
 * schema.org (`Offer.availability`) is the contract. We also credit OpenGraph
 * `product:availability`, stock language in visible text, and a clean HTTP
 * status with no bot-blocking.
 */

import { buildResult, partial } from './base.js';
import type { ScanContext } from '../context.js';
import { collectOfferNodes } from './pricing.js';

const AVAILABILITY_SCHEMA = [
  'https://schema.org/instock',
  'https://schema.org/outofstock',
  'https://schema.org/preorder',
  'https://schema.org/backorder',
  'https://schema.org/limitedavailability',
  'https://schema.org/discontinued',
  'https://schema.org/soldout',
];

const STOCK_WORDS =
  /\b(in stock|out of stock|pre-?order|back-?order|available now|ships today|sold out|low stock|restock(?:ing|es)?)\b/i;

export async function checkAvailability(ctx: ScanContext) {
  const { page, status, headers } = ctx;

  // 1. schema.org availability. Usually nested inside a Product's offers block,
  //    so we walk every reachable Offer node rather than only top-level nodes.
  const availabilityValues: string[] = [];
  for (const node of collectOfferNodes(page.jsonLd)) {
    const avail = node['availability'];
    if (typeof avail === 'string') availabilityValues.push(avail.toLowerCase());
    else if (avail && typeof avail === 'object' && typeof (avail as { '@id'?: unknown })['@id'] === 'string') {
      availabilityValues.push(String((avail as { '@id': string })['@id']).toLowerCase());
    }
  }
  const schemaAvailability = availabilityValues.filter((v) => AVAILABILITY_SCHEMA.includes(v));

  // 2. OpenGraph / product meta.
  const ogAvailability = Object.entries(page.meta).find(
    ([k]) => /availability/i.test(k) && typeof page.meta[k] === 'string',
  )?.[1];

  // 3. Visible stock language.
  const stockMentions = [...page.text.matchAll(new RegExp(STOCK_WORDS.source, 'gi'))].map((m) => m[0]);

  // 4. Serving health — a 403/503 means agents see an error, not a catalogue.
  const serverError = status >= 500;
  const blocked = status === 401 || status === 403 || status === 429;
  const healthy = status >= 200 && status < 300;
  const contentType = headers['content-type'] ?? '';
  const isHtml = contentType.includes('text/html');

  // Points: 5 schema availability, 2 og/meta, 2 stock text, 1 healthy HTML response.
  let points = 0;
  points += 5 * partial(schemaAvailability.length > 0 ? 1 : 0, 1);
  points += ogAvailability ? 2 : 0;
  points += stockMentions.length > 0 ? 2 : 0;
  points += healthy && isHtml ? 1 : 0;

  const status_: 'pass' | 'warn' | 'fail' = serverError || blocked ? 'fail' : schemaAvailability.length > 0 || stockMentions.length > 0 ? (schemaAvailability.length > 0 ? 'pass' : 'warn') : 'warn';

  const fixes: string[] = [];
  if (serverError || blocked) {
    fixes.push(
      `Your site returned HTTP ${status} to agents. Fix the error or allow-list crawler user-agents before anything else matters.`,
    );
  }
  if (schemaAvailability.length === 0) {
    fixes.push(
      'Add "availability": "https://schema.org/InStock" to each Offer. Without it agents assume nothing can be bought.',
    );
  }
  if (!ogAvailability) {
    fixes.push('Add og:availability / product:availability meta as a secondary signal.');
  }
  if (stockMentions.length === 0) {
    fixes.push('Show stock state in visible text on product pages ("In stock — ships today").');
  }

  const summary = serverError || blocked
    ? `Site returned HTTP ${status} — agents cannot read your catalogue at all.`
    : schemaAvailability.length > 0
      ? `Availability declared in structured data (${[...new Set(schemaAvailability)].slice(0, 3).join(', ')}).`
      : stockMentions.length > 0
        ? `Stock state mentioned in text (${stockMentions.length} mention(s)) but not declared in schema.org.`
        : 'No availability signal anywhere. Agents cannot tell if they can buy from you.';

  return buildResult(
    'availability',
    status_,
    points,
    summary,
    fixes,
    {
      schemaAvailability: [...new Set(schemaAvailability)],
      ogAvailability: ogAvailability ?? null,
      stockMentionCount: stockMentions.length,
      httpStatus: status,
      healthy,
      blocked,
      serverError,
      contentType,
    },
  );
}