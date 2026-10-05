/**
 * Pillar 4 — Pricing transparency.
 *
 * "How much does it cost and what are the terms" is the single most common
 * agent query. If the answer requires a form, a phone call or a sales rep,
 * you are invisible to agents. We look for prices in JSON-LD Offers, in
 * OpenGraph/product microdata, in visible text, and in a dedicated pricing
 * page reachable from the homepage.
 */

import { buildResult, partial } from './base.js';
import type { ScanContext } from '../context.js';
import { parsePrice } from '@agentready/shared';
import { resolveUrl } from '../parser.js';

const PRICE_TEXT = /(?:[$€£¥₨]\s?\d[\d,.\s]*\d|\d[\d,.\s]*\s?(?:USD|EUR|GBP|PKR|INR)\b)/gi;
const PLAN_WORDS = /\b(free|starter|pro|basic|plus|enterprise|premium|unlimited|per month|\/mo|monthly|annually|billed)\b/i;

/**
 * Collect every Offer node reachable from a JSON-LD document.
 *
 * Prices live in two shapes and agents need both: a bare `Offer` node, and an
 * `offers` block nested inside a Product/Service. Reading only the top level
 * misses the common case entirely, so we walk into nested offers, aggregate
 * offers, and price specifications.
 */
export function collectOfferNodes(nodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const offers: Array<Record<string, unknown>> = [];

  for (const node of nodes) {
    const type = String(node['@type'] ?? '').toLowerCase();
    const isOfferish = /offer|price|aggregateoffer|unitprice/.test(type);
    if (isOfferish) offers.push(node);

    // nested offers / aggregateOffer.offers / priceSpecification
    for (const key of ['offers', 'hasPrice', 'priceSpecification']) {
      const value = node[key];
      if (!value) continue;
      const list = Array.isArray(value) ? value : [value];
      for (const entry of list) {
        if (entry && typeof entry === 'object') offers.push(entry as Record<string, unknown>);
      }
    }
  }

  return offers;
}

/** Every price-ish value on an Offer, including low/high bounds. */
function offerPriceValues(offer: Record<string, unknown>): unknown[] {
  const nested = offer['priceSpecification'];
  const fromNested =
    nested && typeof nested === 'object'
      ? Array.isArray(nested)
        ? (nested as Array<Record<string, unknown>>).flatMap((n) => [n?.['price']])
        : [(nested as Record<string, unknown>)['price']]
      : [];

  return [
    offer['price'],
    offer['lowPrice'],
    offer['highPrice'],
    ...(Array.isArray(offer['offers']) ? (offer['offers'] as Array<Record<string, unknown>>).flatMap((o) => [o?.['price'], o?.['lowPrice'], o?.['highPrice']]) : []),
    ...fromNested,
  ].filter((v) => v !== undefined && v !== null);
}

export async function checkPricing(ctx: ScanContext) {
  const { page } = ctx;

  // 1. Structured offers — the highest-quality signal.
  const offerNodes = collectOfferNodes(page.jsonLd);
  const structuredPrices = offerNodes.flatMap((n) => offerPriceValues(n)).filter((v) => parsePrice(v as never) !== undefined);

  const hasCurrency = offerNodes.some((n) => typeof n['priceCurrency'] === 'string');

  // 2. Visible text prices.
  const textPrices = [...page.text.matchAll(PRICE_TEXT)].map((m) => m[0]).filter(Boolean);
  const hasPlanLanguage = PLAN_WORDS.test(page.text);

  // 3. A reachable, machine-readable pricing page.
  const pricingLink = page.links.find((l) => /\/pricing|\/plans|\/prices\b/i.test(l.href));
  let pricingPageReadable = false;
  if (pricingLink) {
    const absolute = resolveUrl(pricingLink.href, ctx.finalUrl);
    if (absolute && new URL(absolute).origin === ctx.origin) {
      // We score link presence, not a second full fetch: the homepage already
      // told us the site has a pricing section worth reading.
      pricingPageReadable = true;
    }
  }
  const hasPricingSection = page.hasPricingTable || pricingPageReadable || hasPlanLanguage;

  // Points: 6 structured price, 2 currency, 3 visible price, 2 pricing page, 1 plan language.
  let points = 0;
  points += 6 * partial(structuredPrices.length > 0 ? 1 : 0, 1);
  points += hasCurrency ? 2 : 0;
  points += 3 * partial(textPrices.length > 0 ? 1 : 0, 1);
  points += pricingPageReadable ? 2 : 0;
  points += hasPricingSection && hasPlanLanguage ? 1 : 0;

  const status = structuredPrices.length > 0 ? 'pass' : textPrices.length > 0 || hasPricingSection ? 'warn' : 'fail';

  const fixes: string[] = [];
  if (structuredPrices.length === 0) {
    fixes.push(
      'Add an Offer to your Product/Service schema.org markup with "price" and "priceCurrency". This is how agents read prices without scraping.',
    );
  }
  if (!hasCurrency) fixes.push('Add "priceCurrency": "USD" (or your currency) alongside every price.');
  if (textPrices.length === 0) {
    fixes.push('Put at least your entry price in visible page text — agents cannot read prices hidden behind "Contact us".');
  }
  if (!pricingPageReadable) {
    fixes.push('Publish a public /pricing page linked from the homepage. Gatekeeping pricing removes you from agent answers.');
  }
  if (!hasPlanLanguage) fixes.push('Name your tiers and billing period (e.g. "Starter — $49/month").');

  const summary = structuredPrices.length > 0
    ? `${structuredPrices.length} machine-readable price(s) found in structured data${hasCurrency ? ' with currency' : ''}.`
    : textPrices.length > 0
      ? `Found ${textPrices.length} price(s) in page text, but none in structured data.`
      : 'No discoverable pricing. Agents will skip you when asked "how much does X cost".';

  return buildResult(
    'pricing',
    status,
    points,
    summary,
    fixes,
    {
      structuredPriceCount: structuredPrices.length,
      samplePrices: structuredPrices.slice(0, 5).map((p) => String(p)),
      hasCurrency,
      textPriceCount: textPrices.length,
      sampleTextPrices: textPrices.slice(0, 5),
      pricingPageUrl: pricingLink?.href ?? null,
      hasPricingSection,
      hasPlanLanguage,
    },
  );
}