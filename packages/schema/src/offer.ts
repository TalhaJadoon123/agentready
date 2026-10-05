/** Offer JSON-LD generation, including the aggregate variants. */

import type { Offer } from '@agentready/shared';
import { AVAILABILITY_MAP, normalizeCurrency, offerNode } from './generate.js';

export { offerNode as buildOffer };

/** Normalize a loose availability value ("in stock", "instock") to our union. */
export function normalizeAvailability(value: string | undefined): Offer['availability'] {
  if (!value) return 'InStock';
  const v = value.toLowerCase().replace(/[\s_-]/g, '');
  const table: Array<[string, Offer['availability']]> = [
    ['instock', 'InStock'],
    ['instocksale', 'InStock'],
    ['available', 'InStock'],
    ['outofstock', 'OutOfStock'],
    ['soldout', 'OutOfStock'],
    ['backorder', 'BackOrder'],
    ['preorder', 'PreOrder'],
    ['discontinued', 'Discontinued'],
  ];
  for (const [needle, mapped] of table) if (v.includes(needle)) return mapped;
  return 'InStock';
}

export function generateOffer(offer: Offer, productId?: string): Record<string, unknown> {
  const node = offerNode(offer, productId ? { productId } : {});
  if (!node) throw new Error(`Offer requires a resolvable price (got ${String(offer.price)})`);
  return node;
}

/**
 * AggregateOffer across many SKUs in the same currency.
 * Agents use lowPrice/highPrice to pre-filter before fetching details.
 */
export function generateAggregateOffer(offers: Offer[]): Record<string, unknown> | undefined {
  const priced = offers.map((o) => offerNode(o)).filter((o): o is Record<string, unknown> => Boolean(o));
  if (priced.length === 0) return undefined;

  const prices = priced.map((o) => Number(o['price']));
  const currency = normalizeCurrency(String(priced[0]?.['priceCurrency'] ?? 'USD'));
  const availabilities = new Set(priced.map((o) => String(o['availability'])));

  return {
    '@type': 'AggregateOffer',
    priceCurrency: currency,
    lowPrice: Math.min(...prices).toFixed(2),
    highPrice: Math.max(...prices).toFixed(2),
    offerCount: priced.length,
    // If everything is the same state, say so; otherwise it is mixed.
    availability: availabilities.size === 1 ? [...availabilities][0] : `${AVAILABILITY_MAP.InStock}`,
    offers: priced,
  };
}

/** IntAggregateOffer — sum of component prices, for bundles. */
export function generateIntAggregateOffer(offers: Offer[]): Record<string, unknown> | undefined {
  const priced = offers.map((o) => offerNode(o)).filter((o): o is Record<string, unknown> => Boolean(o));
  if (priced.length === 0) return undefined;
  const total = priced.reduce((sum, o) => sum + Number(o['price']), 0);
  return {
    '@type': 'AggregateOffer',
    priceCurrency: normalizeCurrency(String(priced[0]?.['priceCurrency'] ?? 'USD')),
    lowPrice: total.toFixed(2),
    highPrice: total.toFixed(2),
    offerCount: priced.length,
    offers: priced,
  };
}