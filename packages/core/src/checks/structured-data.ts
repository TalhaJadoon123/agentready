/**
 * Pillar 1 — Structured data (schema.org).
 *
 * The single strongest on-page signal an agent has for understanding a site.
 * We reward: a JSON-LD graph at all, an Organization node, Product/Service
 * nodes, Offer/price nodes, and availability inside them. Microdata counts for
 * partial credit; OpenGraph alone does not.
 */

import { buildResult, partial } from './base.js';
import type { ScanContext } from '../context.js';
import { jsonLdTypes } from '../parser.js';
import type { JsonLdNode } from '../parser.js';

/** Types that identify a commercial entity we can serve to an agent. */
const ENTITY_TYPES = ['product', 'service', 'offer', 'softwareapplication', 'localbusiness', 'store'];
const IDENTITY_TYPES = ['organization', 'website', 'localbusiness', 'corporation'];
const OFFER_TYPES = ['offer', 'aggregateoffer', 'unitprice'];
const AVAILABILITY_TYPES = ['instock', 'outofstock', 'preorder', 'backorder', 'discontinued', 'limitedavailability'];

function nodeTypes(node: JsonLdNode): string[] {
  const t = node['@type'];
  if (typeof t === 'string') return [t.toLowerCase()];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
  return [];
}

export async function checkStructuredData(ctx: ScanContext) {
  const types = jsonLdTypes(ctx.page.jsonLd);
  const typeSet = new Set(types);

  const hasJsonLd = types.length > 0;
  const identity = types.filter((t) => IDENTITY_TYPES.includes(t));
  const entities = types.filter((t) => ENTITY_TYPES.includes(t));
  const offers = types.filter((t) => OFFER_TYPES.includes(t));
  const availability = types.filter((t) => AVAILABILITY_TYPES.includes(t));

  const microdataTypes = ctx.page.microdata.map((m) => (m.type || '').toLowerCase()).filter(Boolean);
  const hasMicrodata = microdataTypes.length > 0;

  // Points: 6 for any machine-readable graph, 4 identity, 6 entities, 3 offers, 1 availability.
  let points = 0;
  if (hasJsonLd) points += 6;
  else if (hasMicrodata) points += 3;
  points += 4 * partial(identity.length, 2);
  points += 6 * partial(entities.length, 3);
  points += 3 * partial(offers.length, 2);
  points += 1 * partial(availability.length, 1);

  // A valid @context is a correctness signal worth calling out in evidence.
  const hasContext = ctx.page.jsonLd.some((n) => n['@context'] !== undefined);

  let status: 'pass' | 'warn' | 'fail';
  if (entities.length > 0 && identity.length > 0 && offers.length > 0) status = 'pass';
  else if (hasJsonLd || hasMicrodata) status = 'warn';
  else status = 'fail';

  const fixes: string[] = [];
  if (!hasJsonLd) {
    fixes.push(
      'Add a JSON-LD block in <head>: <script type="application/ld+json"> with @type Organization and @type Product.',
    );
  }
  if (!hasContext) fixes.push('Set "@context": "https://schema.org" on your JSON-LD graph.');
  if (identity.length === 0) fixes.push('Add an Organization or WebSite node with name, url, logo and sameAs.');
  if (entities.length === 0) fixes.push('Mark up your catalogue with Product or Service nodes.');
  if (offers.length === 0) fixes.push('Attach an Offer to each Product/Service so agents can read price without scraping.');
  if (availability.length === 0) fixes.push('Add "availability": "https://schema.org/InStock" inside each Offer.');

  const summary = hasJsonLd
    ? `Found ${types.length} schema.org type(s): ${types.slice(0, 8).join(', ')}.`
    : hasMicrodata
      ? `Found microdata (${microdataTypes.slice(0, 5).join(', ')}) but no JSON-LD — agents parse JSON-LD far more reliably.`
      : 'No structured data found. Agents cannot reliably identify your products, prices or organisation.';

  return buildResult(
    'structured-data',
    status,
    points,
    summary,
    fixes,
    {
      jsonLdTypes: types,
      microdataTypes,
      hasContext,
      entityCount: entities.length,
      offerCount: offers.length,
      availabilityCount: availability.length,
    },
  );
}