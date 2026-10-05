/** Service JSON-LD generation. */

import type { Offer, Service } from '@agentready/shared';
import { offerNode, serviceNode, type NodeOptions } from './generate.js';

export { serviceNode as buildService };
export { offerNode as buildOffer };

export function generateService(service: Service, opts: NodeOptions = {}): Record<string, unknown> {
  return serviceNode(service, opts);
}

/**
 * A Service with tiered plans as an AggregateOffer.
 * Agents comparing "which plan do I need" read this far more reliably than a
 * pricing table, because the tiers carry their own price and description.
 */
export function generateServiceWithPlans(
  service: Service,
  plans: Array<{ name: string; price: number; description?: string; currency?: string; url?: string }>,
  opts: NodeOptions = {},
): Record<string, unknown> {
  const base = serviceNode({ ...service, offers: undefined }, opts);

  const offers = plans
    .map((plan) =>
      offerNode(
        {
          price: plan.price,
          currency: plan.currency ?? 'USD',
          availability: 'InStock',
          ...(plan.url ? { url: plan.url } : {}),
        },
        { productId: base['@id'] as string | undefined },
      ),
    )
    .filter((o): o is Record<string, unknown> => Boolean(o));

  if (offers.length === 0) return base;

  const prices = plans.map((p) => p.price);
  base['offers'] = {
    '@type': 'AggregateOffer',
    priceCurrency: plans[0]?.currency ?? 'USD',
    lowPrice: Math.min(...prices).toFixed(2),
    highPrice: Math.max(...prices).toFixed(2),
    offerCount: offers.length,
    offers: offers.map((o, i) => ({
      ...o,
      name: plans[i]?.name,
      ...(plans[i]?.description ? { description: plans[i].description } : {}),
    })),
  };

  return base;
}

/** A ContactPoint / Offer pair for a service's support terms. */
export function generateWarrantyOffer(serviceName: string, warranty: string, currency = 'USD', price = 0): Offer {
  return { price, currency, availability: 'InStock', warranty, seller: serviceName };
}