/**
 * schema.org JSON-LD generation.
 *
 * Design rules, in priority order:
 *  1. Every node must be self-describing to an agent: name, description, and a
 *     resolvable URL are not optional.
 *  2. Use schema.org's canonical URLs for @id and availability, never bare names.
 *  3. Only emit properties we actually have data for — an empty `"price": ""`
 *     is worse than an absent price, because agents trust it.
 */

import type { Offer, Product, Service } from '@agentready/shared';
import { parsePrice, round, serverSlug } from '@agentready/shared';

export const SCHEMA_CONTEXT = 'https://schema.org';
export const SCHEMA_BASE = 'https://schema.org';

/** Canonical schema.org enum for each availability state we support. */
export const AVAILABILITY_MAP: Record<Product['availability'], string> = {
  InStock: `${SCHEMA_BASE}/InStock`,
  OutOfStock: `${SCHEMA_BASE}/OutOfStock`,
  PreOrder: `${SCHEMA_BASE}/PreOrder`,
  BackOrder: `${SCHEMA_BASE}/BackOrder`,
  Discontinued: `${SCHEMA_BASE}/Discontinued`,
};

/** ISO 4217 for common currencies; falls back to uppercasing the input. */
export function normalizeCurrency(currency: string): string {
  const c = currency.trim();
  if (/^[A-Z]{3}$/.test(c)) return c;
  const symbolToCode: Record<string, string> = {
    $: 'USD',
    '€': 'EUR',
    '£': 'GBP',
    '¥': 'JPY',
    '₨': 'PKR',
    '₹': 'INR',
  };
  return symbolToCode[c] ?? (c.toUpperCase() || 'USD');
}

/** Round to 2dp and strip trailing zeros — agents compare these numerically. */
function normalizePrice(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? round(value, 2) : undefined;
  }
  const n = parsePrice(value as string);
  return n === undefined ? undefined : round(n, 2);
}

export interface NodeOptions {
  /** Absolute site URL, used to build @id references. */
  siteUrl?: string;
  /** Include the @context wrapper around a single node. */
  wrap?: boolean;
}

/** Shared fields every agent needs to identify and cite an entity. */
function baseIdentity(name: string, description: string | undefined, url: string | undefined) {
  return {
    name: name.trim(),
    ...(description && description.trim() ? { description: description.trim() } : {}),
    ...(url ? { url } : {}),
  };
}

/**
 * Organization node. This is the root of trust for an agent: it decides who
 * you are, and it links to every other node via @id.
 */
export function organizationNode(org: {
  name: string;
  legalName?: string;
  url: string;
  logo?: string;
  description?: string;
  email?: string;
  telephone?: string;
  address?: { [key: string]: string | undefined };
  sameAs?: string[];
  contactPoint?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@type': 'Organization',
    '@id': `${org.url.replace(/\/$/, '')}/#organization`,
    ...baseIdentity(org.name, org.description, org.url),
    ...(org.legalName ? { legalName: org.legalName } : {}),
    ...(org.logo ? { logo: org.logo } : {}),
    ...(org.email ? { email: org.email } : {}),
    ...(org.telephone ? { telephone: org.telephone } : {}),
    ...(org.address
      ? {
          address: {
            '@type': 'PostalAddress',
            ...Object.fromEntries(Object.entries(org.address).filter(([, v]) => v !== undefined)),
          },
        }
      : {}),
    ...(org.sameAs && org.sameAs.length > 0 ? { sameAs: org.sameAs } : {}),
    ...(org.contactPoint && org.contactPoint.length > 0
      ? {
          contactPoint: org.contactPoint.map((cp) => ({
            '@type': 'ContactPoint',
            contactType: 'customer service',
            ...cp,
          })),
        }
      : {}),
  };
  return node;
}

/** Offer node — the node agents read most. Price + currency + availability. */
export function offerNode(offer: Offer, opts: { productId?: string; siteUrl?: string } = {}): Record<string, unknown> | undefined {
  const price = normalizePrice(offer.price);
  if (price === undefined) return undefined;

  const node: Record<string, unknown> = {
    '@type': 'Offer',
    price: price.toFixed(2),
    priceCurrency: normalizeCurrency(offer.currency),
    availability: AVAILABILITY_MAP[offer.availability] ?? AVAILABILITY_MAP.InStock,
    ...(offer.url ? { url: offer.url } : {}),
    ...(offer.priceValidUntil ? { priceValidUntil: offer.priceValidUntil } : {}),
    ...(offer.seller ? { seller: { '@type': 'Organization', name: offer.seller } } : {}),
  };

  if (offer.shippingDetails) {
    const sd = offer.shippingDetails;
    const rate = normalizePrice(sd.shippingRate);
    if (rate !== undefined) {
      node['shippingDetails'] = {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: rate.toFixed(2), currency: normalizeCurrency(sd.shippingCurrency ?? offer.currency) },
        ...(sd.deliveryTime
          ? {
              shippingDeliveryTime: {
                '@type': 'ShippingDeliveryTime',
                handlingTime: { '@type': 'QuantitativeValue', minValue: sd.deliveryTime.min, maxValue: sd.deliveryTime.max, unitCode: sd.deliveryTime.unit.toUpperCase() },
              },
            }
          : {}),
      };
    }
  }

  if (offer.warranty) {
    node['warranty'] = { '@type': 'WarrantyPromise', description: offer.warranty };
  }

  if (opts.productId) node['itemOffered'] = { '@id': opts.productId };
  return node;
}

/**
 * Product node.
 *
 * `additionalProperty` carries specs — this is how an agent answers
 * "does it have 16GB of RAM" without reading your spec table.
 */
export function productNode(product: Product, opts: NodeOptions = {}): Record<string, unknown> {
  const siteUrl = opts.siteUrl?.replace(/\/$/, '') ?? '';
  const url = product.url ?? (siteUrl && product.id ? `${siteUrl}/products/${encodeURIComponent(serverSlug(product.id))}` : undefined);
  const id = url ? `${url}#product` : `#product-${serverSlug(product.id)}`;

  const node: Record<string, unknown> = {
    '@type': 'Product',
    '@id': id,
    ...baseIdentity(product.name, product.description, url),
    ...(product.sku ? { sku: product.sku } : {}),
    ...(product.gtin ? { gtin: product.gtin } : {}),
    ...(product.mpn ? { mpn: product.mpn } : {}),
    ...(product.brand ? { brand: { '@type': 'Brand', name: product.brand } } : {}),
    ...(product.category ? { category: product.category } : {}),
    ...(product.image ? { image: product.image } : {}),
    ...(product.rating
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: round(product.rating.value, 1),
            reviewCount: product.rating.count,
            ...(product.rating.count > 0 ? { bestRating: 5, worstRating: 1 } : {}),
          },
        }
      : {}),
    ...(product.weight
      ? {
          weight: {
            '@type': 'QuantitativeValue',
            value: product.weight.value,
            unitCode: product.weight.unit.toUpperCase(),
          },
        }
      : {}),
  };

  const offer = offerNode(
    {
      price: product.price,
      currency: product.currency,
      availability: product.availability,
      ...(url ? { url } : {}),
    },
    { productId: id },
  );
  if (offer) node['offers'] = offer;

  const specEntries = Object.entries(product.specs ?? {});
  if (specEntries.length > 0) {
    node['additionalProperty'] = specEntries.map(([name, value]) => ({
      '@type': 'PropertyValue',
      name,
      value: String(value),
    }));
  }

  // Preserve untyped extras so nothing the user supplied is silently dropped.
  for (const [k, v] of Object.entries(product.extra ?? {})) {
    if (v !== undefined && v !== null && !(k in node)) node[k] = v;
  }

  return node;
}

/** Service node — the schema.org equivalent of Product for non-goods. */
export function serviceNode(service: Service, opts: NodeOptions = {}): Record<string, unknown> {
  const siteUrl = opts.siteUrl?.replace(/\/$/, '') ?? '';
  const url = service.url ?? (siteUrl ? `${siteUrl}/services/${serverSlug(service.name)}` : undefined);
  const id = url ? `${url}#service` : `#service-${serverSlug(service.name)}`;

  const node: Record<string, unknown> = {
    '@type': 'Service',
    '@id': id,
    ...baseIdentity(service.name, service.description, url),
    ...(service.serviceType ? { serviceType: service.serviceType } : {}),
    ...(service.areaServed ? { areaServed: service.areaServed } : {}),
    ...(service.providerMobility ? { providerMobility: service.providerMobility } : {}),
    ...(service.image ? { image: service.image } : {}),
    provider: { '@type': 'Organization', name: service.provider },
  };

  const offers = (service.offers ?? [])
    .map((o) => offerNode(o, { productId: id }))
    .filter((o): o is Record<string, unknown> => Boolean(o));
  if (offers.length === 1) node['offers'] = offers[0];
  else if (offers.length > 1) node['offers'] = offers;

  return node;
}

/** LocalBusiness node — required for "near me" style agent queries. */
export function localBusinessNode(lb: Record<string, unknown>, opts: NodeOptions = {}): Record<string, unknown> {
  const siteUrl = opts.siteUrl?.replace(/\/$/, '') ?? '';
  const url = typeof lb['url'] === 'string' ? lb['url'] : siteUrl || undefined;

  return {
    '@type': (lb['@type'] as string) || 'LocalBusiness',
    ...(url ? { '@id': `${url}#localbusiness`, url } : {}),
    ...baseIdentity(String(lb['name'] ?? 'Unknown'), lb['description'] as string | undefined, url),
    ...(lb['telephone'] ? { telephone: lb['telephone'] } : {}),
    ...(lb['email'] ? { email: lb['email'] } : {}),
    ...(lb['image'] ? { image: lb['image'] } : {}),
    ...(lb['priceRange'] ? { priceRange: lb['priceRange'] } : {}),
    ...(lb['address'] ? { address: { '@type': 'PostalAddress', ...(lb['address'] as Record<string, unknown>) } } : {}),
    ...(lb['geo'] ? { geo: { '@type': 'GeoCoordinates', ...(lb['geo'] as Record<string, unknown>) } } : {}),
    ...(lb['openingHoursSpecification']
      ? { openingHoursSpecification: lb['openingHoursSpecification'] }
      : {}),
    ...(Array.isArray(lb['sameAs']) ? { sameAs: lb['sameAs'] } : {}),
  };
}

/** Wrap nodes in a single @graph document. */
export function graphDocument(nodes: Record<string, unknown>[]): Record<string, unknown> {
  return {
    '@context': SCHEMA_CONTEXT,
    '@graph': nodes,
  };
}

/** Serialize a document to the `<script>` block an HTML page needs. */
export function toScriptTag(document: Record<string, unknown>, options: { id?: string; pretty?: boolean } = {}): string {
  const json = options.pretty === false ? JSON.stringify(document) : JSON.stringify(document, null, 2);
  // `</script>` inside a JSON-LD block terminates it early — escape it.
  const safe = json.replace(/<\//g, '<\\/');
  const id = options.id ? ` id="${options.id}"` : '';
  return `<script type="application/ld+json"${id}>\n${safe}\n</script>`;
}