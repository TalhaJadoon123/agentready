import { describe, expect, it } from 'vitest';
import {
  buildSchema,
  buildSchemaScript,
  validateSchema,
  validateSchemaString,
  injectIntoHtml,
  inject,
  generateLlmsTxt,
  productNode,
  serviceNode,
  organizationNode,
  generateItemList,
  generateBreadcrumbs,
  parseOpeningHours,
  buildLocalBusiness,
  generateAggregateOffer,
  normalizeAvailability,
  normalizeCurrency,
  AVAILABILITY_MAP,
} from '../src/index.js';
import type { Product } from '@agentready/shared';

const product: Product = {
  id: 'w1',
  name: 'Widget',
  description: 'A useful widget.',
  sku: 'W-1',
  brand: 'Acme',
  category: 'Tools',
  price: 19.99,
  currency: 'USD',
  availability: 'InStock',
  specs: { colour: 'red', weight: '300g' },
  rating: { value: 4.5, count: 20 },
};

describe('schema generation', () => {
  it('builds a valid product with a nested offer', () => {
    const node = productNode(product, { siteUrl: 'https://shop.example' });
    expect(node['@type']).toBe('Product');
    expect(node['name']).toBe('Widget');
    const offers = node['offers'] as Record<string, unknown>;
    expect(offers.price).toBe('19.99');
    expect(offers.priceCurrency).toBe('USD');
    expect(offers.availability).toBe(AVAILABILITY_MAP.InStock);
  });

  it('carries specs through as additionalProperty', () => {
    const node = productNode(product);
    const props = node['additionalProperty'] as Array<Record<string, unknown>>;
    expect(props).toHaveLength(2);
    expect(props.find((p) => p['name'] === 'colour')?.['value']).toBe('red');
  });

  it('omits price rather than emitting an invalid offer', () => {
    const node = productNode({ ...product, price: Number.NaN });
    expect(node['offers']).toBeUndefined();
  });

  it('builds a service with aggregate plan pricing', () => {
    const node = serviceNode(
      {
        name: 'Consulting',
        description: 'Expert advice.',
        provider: 'Acme',
        offers: [{ price: 100, currency: 'USD', availability: 'InStock' }],
      },
      { siteUrl: 'https://shop.example' },
    );
    expect(node['@type']).toBe('Service');
    expect(node['provider']).toMatchObject({ name: 'Acme' });
  });

  it('builds an organization with an @id anchor', () => {
    const node = organizationNode({ name: 'Acme', url: 'https://acme.example' });
    expect(node['@id']).toBe('https://acme.example/#organization');
  });

  it('builds an item list preserving rank order', () => {
    const list = generateItemList([product, { ...product, id: 'w2', name: 'Gadget' }], { siteUrl: 'https://s.example' });
    const items = list['itemListElement'] as Array<Record<string, unknown>>;
    expect(items[0]?.['position']).toBe(1);
    expect(items[1]?.['position']).toBe(2);
  });

  it('builds breadcrumbs', () => {
    const crumbs = generateBreadcrumbs([{ name: 'Home', url: 'https://s.example/' }, { name: 'Shop', url: 'https://s.example/shop' }]);
    expect((crumbs['itemListElement'] as unknown[]).length).toBe(2);
  });

  it('parses opening-hours ranges', () => {
    const parsed = parseOpeningHours('Mon-Fri 09:00-17:00; Sat 10:00-13:00');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.dayOfWeek).toHaveLength(5);
  });

  it('normalizes availability strings', () => {
    expect(normalizeAvailability('in stock')).toBe('InStock');
    expect(normalizeAvailability('SOLD OUT')).toBe('OutOfStock');
    expect(normalizeAvailability(undefined)).toBe('InStock');
  });

  it('normalizes currency symbols to ISO codes', () => {
    expect(normalizeCurrency('$')).toBe('USD');
    expect(normalizeCurrency('eur')).toBe('EUR');
    expect(normalizeCurrency('PKR')).toBe('PKR');
  });

  it('builds an aggregate offer with low/high bounds', () => {
    const agg = generateAggregateOffer([
      { price: 10, currency: 'USD', availability: 'InStock' },
      { price: 30, currency: 'USD', availability: 'OutOfStock' },
    ]);
    expect(agg?.['lowPrice']).toBe('10.00');
    expect(agg?.['highPrice']).toBe('30.00');
    expect(agg?.['offerCount']).toBe(2);
  });

  it('builds a local business node', () => {
    const lb = buildLocalBusiness({ name: 'Corner Shop', url: 'https://shop.example', address: { addressLocality: 'London' } });
    const node = { '@type': lb['@type'], name: lb.name, address: lb.address };
    expect(node['@type']).toBe('LocalBusiness');
  });
});

describe('buildSchema', () => {
  it('assembles a valid graph', () => {
    const result = buildSchema({
      siteUrl: 'https://shop.example',
      organization: { name: 'Acme', url: 'https://shop.example' },
      products: [product],
    });
    expect(result.nodeCount).toBe(2);
    expect(result.types.Organization).toBe(1);
    expect(result.types.Product).toBe(1);
    expect(validateSchema(result.document).valid).toBe(true);
  });

  it('skips products with no usable price and says so', () => {
    const result = buildSchema({ products: [{ ...product, price: Number.NaN }, product] });
    expect(result.skipped.length).toBe(1);
    expect(result.nodeCount).toBe(1);
  });

  it('serializes to a script tag with escaping', () => {
    const script = buildSchemaScript({ products: [product], siteUrl: 'https://shop.example' });
    expect(script).toContain('application/ld+json');
    expect(script).not.toMatch(/<\/script>\s*<\/script>/);
  });
});

describe('validation', () => {
  it('accepts a well-formed document', () => {
    const { document } = buildSchema({
      siteUrl: 'https://shop.example',
      organization: { name: 'Acme', url: 'https://shop.example' },
      products: [product],
    });
    const result = validateSchema(document);
    expect(result.valid).toBe(true);
    expect(result.errors).toBe(0);
  });

  it('rejects a document with no @context', () => {
    const result = validateSchema({ '@graph': [{ '@type': 'Product', name: 'X' }] });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes('@context'))).toBe(true);
  });

  it('rejects an unparsable price', () => {
    const result = validateSchema({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Product', name: 'X', offers: { '@type': 'Offer', price: 'call us' } }],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => /price/i.test(i.message))).toBe(true);
  });

  it('rejects a non-ISO currency', () => {
    const result = validateSchema({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Product', name: 'X', offers: { '@type': 'Offer', price: '1.00', priceCurrency: 'dollars' } }],
    });
    expect(result.issues.some((i) => /ISO 4217/.test(i.message))).toBe(true);
  });

  it('rejects a non-canonical availability', () => {
    const result = validateSchema({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Product', name: 'X', offers: { '@type': 'Offer', price: '1.00', availability: 'maybe' } }],
    });
    expect(result.issues.some((i) => /schema.org URL/.test(i.message))).toBe(true);
  });

  it('warns about a missing price on an offer', () => {
    const result = validateSchema({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Product', name: 'X', offers: { '@type': 'Offer' } }],
    });
    expect(result.valid).toBe(false);
  });

  it('catches a malformed rating', () => {
    const result = validateSchema({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Product', name: 'X', aggregateRating: { '@type': 'AggregateRating', ratingValue: 9, reviewCount: 3 } }],
    });
    expect(result.issues.some((i) => /ratingValue must be 0-5/.test(i.message))).toBe(true);
  });

  it('parses a raw string and reports bad JSON clearly', () => {
    const result = validateSchemaString('{not json');
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain('Not valid JSON');
  });
});

describe('injection', () => {
  it('injects into head and is idempotent', () => {
    const { document } = buildSchema({ products: [product], siteUrl: 'https://s.example' });
    const once = injectIntoHtml('<html><head><title>t</title></head><body></body></html>', document);
    const twice = injectIntoHtml(once, document);
    const count = (twice.match(/application\/ld\+json/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('creates a head when the document has none', () => {
    const { document } = buildSchema({ products: [product] });
    const out = injectIntoHtml('<body>hi</body>', document);
    expect(out).toContain('<head>');
  });

  it('produces platform-specific guidance for each CMS', () => {
    const { document } = buildSchema({ products: [product], siteUrl: 'https://s.example' });
    for (const platform of ['wordpress', 'shopify', 'next', 'custom'] as const) {
      const plan = inject(document, platform, { siteUrl: 'https://s.example' });
      expect(plan.snippet.length).toBeGreaterThan(0);
      expect(plan.instructions.length).toBeGreaterThan(0);
    }
  });

  it('generates an llms.txt with products and pricing', () => {
    const txt = generateLlmsTxt({
      name: 'Acme',
      url: 'https://acme.example',
      description: 'We sell widgets.',
      sections: [{ title: 'Pricing', items: ['Widget: $19.99'] }],
    });
    expect(txt).toContain('# Acme');
    expect(txt).toContain('## Pricing');
    expect(txt).toContain('Widget: $19.99');
  });
});