/**
 * Fixture websites.
 *
 * Each fixture is a complete, self-contained site served from a mocked fetch.
 * Between them they cover every combination the eight checks care about, so
 * the scanner is exercised against realistic pages rather than happy-path
 * fixtures.
 *
 * A `Site` is a map of pathname -> response, so a fixture is just a small
 * description of what a site actually serves.
 */

export interface FixtureResponse {
  body: string;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

export type FixtureSite = Record<string, FixtureResponse>;

export interface Fixture {
  name: string;
  origin: string;
  /** Expected score band, asserted by the tests. */
  expect: { min: number; max: number; grade: string };
  notes: string;
  routes: FixtureSite;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function html(body: string, head = ''): FixtureResponse {
  return {
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
    contentType: 'text/html; charset=utf-8',
  };
}

function jsonLd(nodes: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes })}</script>`;
}

/** Filler prose so word-count heuristics see realistic content. */
const PROSE = `
  <p>We have served field teams since 2014. Every product we sell is chosen because we
  have used it ourselves for at least a season, and we publish the specification sheet
  in full rather than hiding it behind a sales call. If a product is out of stock we say
  so plainly and show you the lead time. If we do not stock something we will tell you
  who does.</p>
  <p>Orders placed before 3pm ship the same working day. Standard shipping is flat rate
  and tracked. Returns are free for thirty days, including worn kit, because we would
  rather have it back than have it in a drawer.</p>
`;

const FAQ = `
  <h2>Frequently asked</h2>
  <h3>How do I place an order?</h3>
  <p>Add items to your cart and check out. We accept all major cards and invoice for
  trade accounts. You will get a tracking link by email within an hour of dispatch.</p>
  <h3>Do you ship internationally?</h3>
  <p>We ship to 38 countries. Duties are calculated at checkout and shown before you pay,
  so there is nothing to settle on arrival.</p>
  <h3>What is your returns policy?</h3>
  <p>Thirty days, return postage on us, no restocking fee. Email us and we will send a
  prepaid label the same working day.</p>
`;

// ---------------------------------------------------------------------------
// 1. bare — the worst realistic site: no signals at all
// ---------------------------------------------------------------------------

export const bareSite: Fixture = {
  name: 'bare',
  origin: 'https://bare.example',
  notes: 'A single HTML page with no structured data, no llms.txt, no pricing, no API.',
  expect: { min: 0, max: 5, grade: 'F' },
  routes: {
    '/': {
      body: `<!doctype html><html><head><title>Welcome</title></head><body><h1>Welcome</h1><p>Welcome to our website. Please contact us for more information.</p></body></html>`,
      contentType: 'text/html',
    },
  },
};

// ---------------------------------------------------------------------------
// 2. wordpress-legacy — WordPress blog with meta tags, no agent surface
// ---------------------------------------------------------------------------

export const wordpressSite: Fixture = {
  name: 'wordpress',
  origin: 'https://blog.example',
  notes: 'Typical WordPress site: meta description, sitemap, no JSON-LD, no pricing.',
  expect: { min: 3, max: 15, grade: 'F' },
  routes: {
    '/': html(
      `<main>
      <h1>Our blog</h1>
      <h2>Latest posts</h2>
      <article><h3>How we work</h3><p>${PROSE}</p></article>
      <article><h3>About the team</h3><p>${PROSE}</p></article>
      <a href="/shop">Shop</a>
      <a href="/contact">Contact</a>
      </main>`,
      `<title>Our Blog</title>
       <meta name="description" content="Notes from the team about how we work and what we build.">
       <link rel="canonical" href="https://blog.example/">
       <meta name="generator" content="WordPress 6.5">`,
    ),
    '/robots.txt': { body: 'User-agent: *\nAllow: /\nDisallow: /wp-admin/\n\nSitemap: https://blog.example/sitemap.xml', contentType: 'text/plain' },
    '/sitemap.xml': {
      body: '<urlset><loc>https://blog.example/</loc><loc>https://blog.example/shop</loc></urlset>',
      contentType: 'application/xml',
    },
  },
};

// ---------------------------------------------------------------------------
// 3. shopify-store — Shopify with product JSON-LD but no MCP server
// ---------------------------------------------------------------------------

export const shopifySite: Fixture = {
  name: 'shopify',
  origin: 'https://store.example',
  notes: 'Shopify store with Product + Offer JSON-LD and visible pricing, but no MCP server and no llms.txt.',
  expect: { min: 30, max: 48, grade: 'D' },
  routes: {
    '/': html(
      `<main>
      <h1>Store</h1>
      <h2>Featured</h2>
      <p>Our bestselling products, in stock and shipping today.</p>
      <p class="price">$49.00</p><p class="price">$129.00</p>
      <a href="/collections/all">All products</a>
      <a href="/pages/pricing">Pricing</a>
      ${PROSE}
      ${FAQ}
      </main>`,
      `<title>Store — Home</title>
       <meta name="description" content="Shop our full range of products, all in stock with fast shipping.">
       <link rel="canonical" href="https://store.example/">
       ${jsonLd([
        { '@type': 'Organization', name: 'Store', url: 'https://store.example' },
        { '@type': 'WebSite', name: 'Store', url: 'https://store.example' },
        {
          '@type': 'Product',
          name: 'Widget',
          description: 'A useful widget for everyday use.',
          sku: 'W-1',
          offers: {
            '@type': 'Offer',
            price: '49.00',
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
          },
        },
        {
          '@type': 'Product',
          name: 'Gadget',
          description: 'A serious gadget for serious work.',
          sku: 'G-2',
          offers: {
            '@type': 'Offer',
            price: '129.00',
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
          },
        },
      ])}`,
    ),
    '/robots.txt': { body: 'User-agent: *\nAllow: /\n\nSitemap: https://store.example/sitemap.xml', contentType: 'text/plain' },
    '/sitemap.xml': { body: '<urlset><loc>https://store.example/</loc></urlset>', contentType: 'application/xml' },
  },
};

// ---------------------------------------------------------------------------
// 4. gated-pricing — great markup, but pricing behind a "contact us"
// ---------------------------------------------------------------------------

export const gatedPricingSite: Fixture = {
  name: 'gated-pricing',
  origin: 'https://b2b.example',
  notes: 'Enterprise site with excellent schema.org but no published prices and no order path.',
  expect: { min: 12, max: 26, grade: 'F' },
  routes: {
    '/': html(
      `<main>
      <h1>B2B Solutions</h1>
      <h2>What we do</h2>
      <p>We build bespoke software for regulated industries. Every engagement is scoped
      individually after a discovery call, so we do not publish a price list. Contact us
      to arrange a conversation and we will put together a proposal.</p>
      <p>Our team has delivered work across finance, healthcare and public sector
      organisations for over a decade. We are ISO 27001 certified and can work under
      your existing supplier frameworks.</p>
      <h2>How to buy</h2>
      <p>Email <a href="mailto:sales@b2b.example">sales@b2b.example</a> and we will respond
      within one business day with next steps and a rate card.</p>
      <a href="/contact">Contact sales</a>
      </main>`,
      `<title>B2B Solutions — Bespoke software for regulated industries</title>
       <meta name="description" content="We build bespoke software for regulated industries. Scoped individually after discovery.">
       <link rel="canonical" href="https://b2b.example/">
       ${jsonLd([
        { '@type': 'Organization', name: 'B2B Solutions', url: 'https://b2b.example', logo: 'https://b2b.example/logo.png' },
        { '@type': 'WebSite', name: 'B2B Solutions', url: 'https://b2b.example' },
        { '@type': 'Service', name: 'Bespoke software development', description: 'Custom software for regulated industries.', provider: { '@type': 'Organization', name: 'B2B Solutions' } },
      ])}`,
    ),
    '/robots.txt': { body: 'User-agent: *\nAllow: /', contentType: 'text/plain' },
  },
};

// ---------------------------------------------------------------------------
// 5. api-first — great machine surface, no visual marketing
// ---------------------------------------------------------------------------

export const apiFirstSite: Fixture = {
  name: 'api-first',
  origin: 'https://api.example',
  notes: 'An API company: strong OpenAPI, OAuth and llms.txt, but little prose and no MCP server.',
  expect: { min: 30, max: 45, grade: 'F' },
  routes: {
    '/': html(
      `<main>
      <h1>Data API</h1>
      <p>A JSON API for geospatial data. Free tier: 1,000 requests per month, no card
      required. Paid plans start at $49 per month. Rate limit is 60 requests per minute
      per client; exceeding it returns HTTP 429 with a Retry-After header.</p>
      <h2>Quick start</h2>
      <p>Get a token with the client_credentials grant, then call /v1/points with it.
      Documentation is at <a href="/docs">/docs</a> and the OpenAPI spec at
      <a href="/openapi.json">/openapi.json</a>.</p>
      ${FAQ}
      </main>`,
      `<title>Data API — geospatial data as JSON</title>
       <meta name="description" content="A JSON API for geospatial data. Free tier with 1,000 requests per month.">
       <link rel="canonical" href="https://api.example/">
       ${jsonLd([
        { '@type': 'Organization', name: 'Data API', url: 'https://api.example' },
        {
          '@type': 'WebSite',
          name: 'Data API',
          url: 'https://api.example',
          potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: 'https://api.example/search?q={q}' }, 'query-input': 'required name=q' },
        },
      ])}`,
    ),
    '/llms.txt': {
      body: '# Data API\n\n> Geospatial data as JSON.\n\nSite: https://api.example\n\n## Pricing\n- Free: 1,000 requests/month\n- Starter: $49/month\n- Business: $149/month\n\n## Rate limits\n60 requests/minute. Exceeding returns 429 with Retry-After.\n',
      contentType: 'text/plain',
    },
    '/openapi.json': {
      body: JSON.stringify({ openapi: '3.1.0', info: { title: 'Data API', version: '1.0.0' }, paths: { '/v1/points': {}, '/v1/orders': {}, '/v1/checkout': {} }, responses: { '429': {} } }),
      contentType: 'application/json',
    },
    '/.well-known/oauth-authorization-server': {
      body: JSON.stringify({ issuer: 'https://api.example', token_endpoint: 'https://api.example/oauth/token', grant_types_supported: ['client_credentials', 'authorization_code'] }),
      contentType: 'application/json',
    },
    '/robots.txt': { body: 'User-agent: *\nAllow: /\n\nSitemap: https://api.example/sitemap.xml', contentType: 'text/plain' },
    '/sitemap.xml': { body: '<urlset><loc>https://api.example/</loc></urlset>', contentType: 'application/xml' },
  },
};

// ---------------------------------------------------------------------------
// 6. robots-blocked — good site, but agents are blocked by robots.txt
// ---------------------------------------------------------------------------

export const blockedSite: Fixture = {
  name: 'robots-blocked',
  origin: 'https://blocked.example',
  notes: 'Excellent markup and pricing, but robots.txt disallows all agents. They are unfindable.',
  expect: { min: 25, max: 42, grade: 'F' },
  routes: {
    '/': html(
      `<main>
      <h1>Blocked Shop</h1>
      <p>We sell excellent products at $19.99 and $39.99, both in stock and shipping today.</p>
      <a href="/pricing">Pricing</a>
      ${PROSE}
      </main>`,
      `<title>Blocked Shop</title>
       <meta name="description" content="We sell excellent products, in stock, shipping today.">
       <link rel="canonical" href="https://blocked.example/">
       ${jsonLd([
        { '@type': 'Organization', name: 'Blocked', url: 'https://blocked.example' },
        {
          '@type': 'Product',
          name: 'Thing',
          description: 'A thing',
          offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
        },
      ])}`,
    ),
    '/robots.txt': { body: 'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /', contentType: 'text/plain' },
  },
};

// ---------------------------------------------------------------------------
// 7. js-only — content only rendered client-side
// ---------------------------------------------------------------------------

export const jsOnlySite: Fixture = {
  name: 'js-only',
  origin: 'https://spa.example',
  notes: 'A single-page app. The HTML agents fetch is almost empty — they see nothing.',
  expect: { min: 0, max: 6, grade: 'F' },
  routes: {
    '/': {
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SPA</title><meta name="generator" content="Next.js"></head><body><div id="__next"></div><script src="/_next/static/chunks/main.js"></script><script src="/_next/static/chunks/framework.js"></script><script>window.__NEXT_DATA__={}</script></body></html>`,
      contentType: 'text/html',
    },
    '/robots.txt': { body: 'User-agent: *\nAllow: /', contentType: 'text/plain' },
  },
};

// ---------------------------------------------------------------------------
// 8. thin-content — real markup, almost no prose
// ---------------------------------------------------------------------------

export const thinSite: Fixture = {
  name: 'thin',
  origin: 'https://thin.example',
  notes: 'Perfect schema.org, no prose. An agent can read the data but cannot answer questions.',
  expect: { min: 18, max: 32, grade: 'F' },
  routes: {
    '/': {
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Catalog</title><meta name="description" content="Catalog">
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'Organization', name: 'Thin', url: 'https://thin.example' },
          { '@type': 'Product', name: 'A', description: 'A', offers: { '@type': 'Offer', price: '1.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } },
        ],
      })}</script></head><body><h1>Catalog</h1><table><tr><td>A</td><td>$1.00</td></tr></table></body></html>`,
      contentType: 'text/html',
    },
    '/robots.txt': { body: 'User-agent: *\nAllow: /', contentType: 'text/plain' },
  },
};

// ---------------------------------------------------------------------------
// 9. service-business — LocalBusiness, no commerce at all
// ---------------------------------------------------------------------------

export const localBusinessSite: Fixture = {
  name: 'local-business',
  origin: 'https://dental.example',
  notes: 'A dental practice: strong LocalBusiness + FAQ markup, no products or ordering.',
  expect: { min: 14, max: 28, grade: 'F' },
  routes: {
    '/': html(
      `<main>
      <h1>Bridge Street Dental</h1>
      <p>We are a family dental practice in the centre of town, open six days a week. New
      patients are welcome and we take most major insurers. Emergency appointments are
      usually available within 24 hours.</p>
      <h2>How much do you charge?</h2>
      <p>A check-up is $95 including an x-ray. Whitening is from $280. We publish our full
      price list at <a href="/prices">/prices</a> and there is no hidden charge for the
      initial consultation.</p>
      <h3>What are your opening hours?</h3>
      <p>Monday to Friday 8am to 6pm, Saturday 9am to 1pm. Closed Sunday.</p>
      ${PROSE}
      </main>`,
      `<title>Bridge Street Dental — family dentist in the centre of town</title>
       <meta name="description" content="Family dental practice open six days a week. Check-ups $95. New patients welcome.">
       <link rel="canonical" href="https://dental.example/">
       ${jsonLd([
        {
          '@type': 'Dentist',
          name: 'Bridge Street Dental',
          url: 'https://dental.example',
          telephone: '+44-20-7946-0000',
          priceRange: '$$',
          address: { '@type': 'PostalAddress', streetAddress: '14 Bridge Street', addressLocality: 'London', postalCode: 'EC4V 6AA', addressCountry: 'GB' },
          openingHoursSpecification: [
            { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '08:00', closes: '18:00' },
          ],
        },
        { '@type': 'WebSite', name: 'Bridge Street Dental', url: 'https://dental.example' },
        {
          '@type': 'FAQPage',
          mainEntity: [
            { '@type': 'Question', name: 'How much do you charge?', acceptedAnswer: { '@type': 'Answer', text: 'A check-up is $95 including an x-ray.' } },
            { '@type': 'Question', name: 'What are your opening hours?', acceptedAnswer: { '@type': 'Answer', text: 'Monday to Friday 8am to 6pm, Saturday 9am to 1pm.' } },
          ],
        },
      ])}`,
    ),
    '/robots.txt': { body: 'User-agent: *\nAllow: /', contentType: 'text/plain' },
  },
};

// ---------------------------------------------------------------------------
// 10. erroring — the site is down for agents
// ---------------------------------------------------------------------------

export const erroringSite: Fixture = {
  name: 'erroring',
  origin: 'https://down.example',
  notes: 'Returns 503 to agents. Nothing else matters until this is fixed.',
  expect: { min: 0, max: 10, grade: 'F' },
  routes: {
    '/': { body: 'Service Unavailable', status: 503, contentType: 'text/plain' },
  },
};

// ---------------------------------------------------------------------------
// 11. no-tls-metadata — broken prices and availability in the markup
// ---------------------------------------------------------------------------

export const brokenMarkupSite: Fixture = {
  name: 'broken-markup',
  origin: 'https://broken.example',
  notes: 'Has JSON-LD but the prices are unparsable and availability is a bare string.',
  expect: { min: 8, max: 22, grade: 'F' },
  routes: {
    '/': html(
      `<main><h1>Broken Shop</h1><p>We sell things. Ask us for a price.</p><a href="/cart">Cart</a></main>`,
      `<title>Broken Shop</title>
       ${jsonLd([
        { '@type': 'Organization' },
        {
          '@type': 'Product',
          name: 'Mystery Item',
          offers: { '@type': 'Offer', price: 'call for pricing', availability: 'maybe' },
        },
      ])}`,
    ),
    '/robots.txt': { body: 'User-agent: *\nAllow: /', contentType: 'text/plain' },
  },
};

// ---------------------------------------------------------------------------
// 12. excellent — the reference implementation
// ---------------------------------------------------------------------------

export const excellentSite: Fixture = {
  name: 'excellent',
  origin: 'https://excellent.example',
  notes: 'Everything an agent needs: schema.org with prices, llms.txt, MCP server, OAuth, OpenAPI, limits.',
  expect: { min: 80, max: 100, grade: 'B' },
  routes: {
    '/': html(
      `<main>
      <h1>Excellent Supply</h1>
      <p class="lede">Field equipment with public pricing, live stock and a machine-readable API.</p>
      <h2>What we sell</h2>
      <p>We sell the Atlas laptop at $1299.00, the Titan power bank at $129.00 and the
      Pelican case at $89.00. The Atlas is in stock and ships within 24 hours.</p>
      <h2>How do I buy?</h2>
      <p>Add to cart and pay online, or call the MCP <code>place_order</code> tool and it
      returns a payment link. Rate limit is 60 requests per minute per client and we send
      <code>Retry-After</code> when you exceed it.</p>
      ${PROSE}
      ${FAQ}
      </main>
      <a href="/products">Products</a>
      <a href="/pricing">Pricing</a>
      <a href="/checkout">Checkout</a>`,
      `<title>Excellent Supply — Field equipment with public pricing</title>
       <meta name="description" content="Field equipment with public pricing, live stock data and a machine-readable API for agents.">
       <link rel="canonical" href="https://excellent.example/">
       <link rel="alternate" type="text/plain" href="https://excellent.example/llms.txt" title="Agent summary">
       ${jsonLd([
        { '@type': 'Organization', name: 'Excellent Supply', url: 'https://excellent.example', logo: 'https://excellent.example/logo.svg', email: 'api@excellent.example' },
        { '@type': 'WebSite', name: 'Excellent Supply', url: 'https://excellent.example' },
        {
          '@type': 'Product',
          name: 'Atlas 14 Field Laptop',
          description: 'A rugged 14-inch laptop for outdoor work, 32GB RAM and 1TB SSD.',
          sku: 'EX-ATLAS-14',
          url: 'https://excellent.example/products/atlas',
          brand: { '@type': 'Brand', name: 'Excellent Supply' },
          offers: { '@type': 'Offer', url: 'https://excellent.example/checkout', price: '1299.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition' },
          aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, reviewCount: 218 },
        },
        {
          '@type': 'Product',
          name: 'Titan 100W Power Bank',
          description: 'A 27,000mAh power bank that charges a laptop at 100W.',
          sku: 'EX-TITAN-100',
          offers: { '@type': 'Offer', price: '129.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
        },
        {
          '@type': 'Product',
          name: 'Pelican 20L Field Case',
          description: 'An IP68 hard-shell case with custom foam.',
          sku: 'EX-PELICAN-20',
          offers: { '@type': 'Offer', price: '89.00', priceCurrency: 'USD', availability: 'https://schema.org/BackOrder' },
        },
        {
          '@type': 'FAQPage',
          mainEntity: [
            { '@type': 'Question', name: 'How do I place an order?', acceptedAnswer: { '@type': 'Answer', text: 'Add to cart and pay, or call the place_order MCP tool.' } },
            { '@type': 'Question', name: 'How fast is shipping?', acceptedAnswer: { '@type': 'Answer', text: 'In-stock orders ship within 24 hours at a flat rate.' } },
          ],
        },
      ])}`,
    ),
    '/llms.txt': {
      body: '# Excellent Supply\n\n> Field equipment with public pricing and a machine-readable API.\n\nSite: https://excellent.example\n\n## Products\n- Atlas 14 Field Laptop — $1299.00, InStock\n- Titan 100W Power Bank — $129.00, InStock\n- Pelican 20L Field Case — $89.00, BackOrder\n\n## Pricing\n- Products from $89.00\n- Standard shipping $4.99\n\n## For agents\n- MCP server: https://excellent.example/mcp\n- MCP manifest: https://excellent.example/.well-known/mcp.json\n- OpenAPI: https://excellent.example/openapi.json\n- Auth: OAuth client_credentials\n\n## Rate limits\n60 requests/minute. Exceeding returns 429 with Retry-After.\n',
      contentType: 'text/plain',
    },
    '/.well-known/mcp.json': {
      body: JSON.stringify({
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json',
        name: 'excellent-supply-mcp',
        version: '1.0.0',
        mcpServers: { 'excellent-supply': { type: 'http', url: 'https://excellent.example/mcp' } },
        remotes: [{ type: 'streamable-http', url: 'https://excellent.example/mcp' }],
      }),
      contentType: 'application/json',
    },
    '/.well-known/oauth-authorization-server': {
      body: JSON.stringify({
        issuer: 'https://excellent.example',
        token_endpoint: 'https://excellent.example/oauth/token',
        grant_types_supported: ['client_credentials', 'authorization_code'],
        scopes_supported: ['catalog:read', 'orders:write'],
      }),
      contentType: 'application/json',
    },
    '/.well-known/oauth-protected-resource': {
      body: JSON.stringify({ resource: 'https://excellent.example', authorization_servers: ['https://excellent.example'] }),
      contentType: 'application/json',
    },
    '/openapi.json': {
      body: JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Excellent Supply API', version: '1.0.0' },
        paths: { '/products': {}, '/products/{id}': {}, '/availability': {}, '/pricing': {}, '/orders': {}, '/checkout': {} },
      }),
      contentType: 'application/json',
    },
    '/robots.txt': {
      body: 'User-agent: *\nAllow: /\nDisallow: /cart/\n\nSitemap: https://excellent.example/sitemap.xml',
      contentType: 'text/plain',
    },
    '/sitemap.xml': {
      body: '<urlset><loc>https://excellent.example/</loc><loc>https://excellent.example/pricing</loc></urlset>',
      contentType: 'application/xml',
    },
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const FIXTURES: Fixture[] = [
  bareSite,
  wordpressSite,
  shopifySite,
  gatedPricingSite,
  apiFirstSite,
  blockedSite,
  jsOnlySite,
  thinSite,
  localBusinessSite,
  erroringSite,
  brokenMarkupSite,
  excellentSite,
];

export const FIXTURE_BY_NAME = new Map(FIXTURES.map((f) => [f.name, f]));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

/**
 * Build a fetch implementation backed by a fixture.
 *
 * Unmatched paths return 404, which is what makes the scanner's "probe every
 * well-known path" logic realistic — a good fixture genuinely lacks most of
 * them.
 */
export function fixtureFetch(fixture: Fixture, options: { host?: string } = {}): typeof fetch {
  const host = options.host ?? new URL(fixture.origin).host;
  const hasMcp = fixture.name === 'excellent';

  const mcpTools = [
    'search_products',
    'get_product',
    'check_availability',
    'get_pricing',
    'place_order',
  ];

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url, fixture.origin);
    const pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '') || '/';

    // A fixture is a single origin; anything else is genuinely absent.
    if (parsed.host !== host) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }

    // A real MCP endpoint speaks JSON-RPC over POST. Anything else is 405.
    if (pathname === '/mcp') {
      if (!hasMcp) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
      if (init?.method !== 'POST') {
        // GET would open an SSE stream in a real server; the scanner does not
        // probe it, so return a small notice instead.
        return new Response('event: endpoint\ndata: /mcp\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }

      let message: { id?: unknown; method?: string } = {};
      try {
        message = JSON.parse(String(init.body ?? '{}')) as typeof message;
      } catch {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' },
        });
      }

      const id = message.id ?? null;
      let result: unknown;

      switch (message.method) {
        case 'initialize':
          result = {
            protocolVersion: '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'excellent-supply', version: '1.0.0' },
          };
          break;
        case 'tools/list':
          result = {
            tools: mcpTools.map((name) => ({
              name,
              description: `${name} for the Excellent Supply catalogue`,
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            })),
          };
          break;
        case 'tools/call':
          result = { content: [{ type: 'text', text: '{"ok":true}' }] };
          break;
        case 'ping':
          result = {};
          break;
        default:
          return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' },
          });
      }

      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' },
      });
    }

    const route = fixture.routes[pathname];
    if (!route) {
      return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    return new Response(route.body, {
      status: route.status ?? 200,
      headers: {
        'content-type': route.contentType ?? 'text/html; charset=utf-8',
        ...route.headers,
      },
    });
  };

  return impl as typeof fetch;
}