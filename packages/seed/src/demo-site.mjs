/**
 * Demo e-commerce site with a live MCP server.
 *
 * Serves on http://localhost:8790:
 *   /                     homepage with schema.org JSON-LD, llms.txt link, pricing
 *   /products             catalogue
 *   /products/:id         product detail with Offer + availability
 *   /pricing              public pricing page
 *   /llms.txt             agent-readable summary
 *   /.well-known/mcp.json discovery manifest
 *   /mcp                  the real MCP JSON-RPC endpoint
 *   /openapi.json         REST description of the catalogue
 *   /robots.txt, /sitemap.xml
 *   /.well-known/oauth-authorization-server   machine auth metadata
 *
 * This is the reference implementation of "what a good site looks like" and it
 * doubles as the seed for the demo dashboard.
 */

import { createServer } from 'node:http';
import { PRODUCTS, ORGANIZATION } from './catalogue.mjs';

const PORT = Number(process.env.DEMO_PORT ?? 8790);
const ORIGIN = process.env.DEMO_ORIGIN ?? `http://localhost:${PORT}`;
const NAME = ORGANIZATION.name;
const CURRENCY = 'USD';

const availabilityUrl = (a) =>
  `https://schema.org/${a === 'OutOfStock' ? 'OutOfStock' : a === 'PreOrder' ? 'PreOrder' : 'InStock'}`;

// --- JSON-LD ---------------------------------------------------------------

function orgNode() {
  return {
    '@type': 'Organization',
    '@id': `${ORIGIN}/#organization`,
    name: NAME,
    url: ORIGIN,
    description: ORGANIZATION.description,
    logo: `${ORIGIN}/logo.svg`,
    sameAs: ORGANIZATION.sameAs,
  };
}

function productNode(p) {
  return {
    '@type': 'Product',
    '@id': `${ORIGIN}/products/${p.id}#product`,
    name: p.name,
    description: p.description,
    sku: p.sku,
    brand: { '@type': 'Brand', name: ORGANIZATION.name },
    category: p.category,
    image: `${ORIGIN}/img/${p.id}.svg`,
    url: `${ORIGIN}/products/${p.id}`,
    ...(p.rating ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating.value, reviewCount: p.rating.count } } : {}),
    offers: {
      '@type': 'Offer',
      url: `${ORIGIN}/checkout?product=${p.id}`,
      priceCurrency: CURRENCY,
      price: p.price.toFixed(2),
      availability: availabilityUrl(p.availability),
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@id': `${ORIGIN}/#organization` },
      shippingDetails: {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: '4.99', currency: CURRENCY },
        shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
      },
    },
    additionalProperty: Object.entries(p.specs).map(([name, value]) => ({
      '@type': 'PropertyValue',
      name,
      value: String(value),
    })),
  };
}

function graph() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      orgNode(),
      {
        '@type': 'WebSite',
        '@id': `${ORIGIN}/#website`,
        url: ORIGIN,
        name: NAME,
        publisher: { '@id': `${ORIGIN}/#organization` },
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${ORIGIN}/products?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
      ...PRODUCTS.map(productNode),
      {
        '@type': 'ItemList',
        name: 'All products',
        numberOfItems: PRODUCTS.length,
        itemListElement: PRODUCTS.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${ORIGIN}/products/${p.id}` })),
      },
      {
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'Do you have an API?',
            acceptedAnswer: { '@type': 'Answer', text: `Yes. We run an MCP server at ${ORIGIN}/mcp exposing search_products, get_product, check_availability, get_pricing and place_order.` },
          },
          {
            '@type': 'Question',
            name: 'How fast is shipping?',
            acceptedAnswer: { '@type': 'Answer', text: 'Orders ship within 24 hours with flat-rate $4.99 shipping.' },
          },
        ],
      },
    ],
  };
}

// --- MCP -------------------------------------------------------------------

const TOOLS = [
  {
    name: 'search_products',
    description: 'Search the product catalogue by free-text query. Returns matching products with price, availability and a canonical URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms. Matches name, description, brand and category.' },
        category: { type: 'string', description: 'Exact category filter.' },
        in_stock_only: { type: 'boolean', description: 'Only return products currently available.' },
        limit: { type: 'number', description: 'Maximum results. Default 10, max 50.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_product',
    description: 'Get the full record for one product by id or SKU, including specifications, price, availability and canonical URL.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, sku: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'check_availability',
    description: 'Check current availability and stock state for one or more products. Call before promising delivery.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
  },
  {
    name: 'get_pricing',
    description: 'Get pricing for one product, or the price range across the whole catalogue.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, currency: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'place_order',
    description: 'Place an order for one or more products. Returns an order id and a payment link.',
    inputSchema: {
      type: 'object',
      required: ['items', 'customer_email'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'quantity'],
            properties: { id: { type: 'string' }, quantity: { type: 'number' } },
          },
        },
        customer_email: { type: 'string' },
        shipping_address: { type: 'string' },
      },
    },
  },
];

function summarize(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description.slice(0, 200),
    sku: p.sku,
    brand: ORGANIZATION.name,
    category: p.category,
    price: p.price,
    currency: CURRENCY,
    formatted_price: `$${p.price.toFixed(2)}`,
    availability: p.availability,
    in_stock: p.availability === 'InStock',
    image: `${ORIGIN}/img/${p.id}.svg`,
    url: `${ORIGIN}/products/${p.id}`,
  };
}

function scoreProduct(p, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 1;
  let score = 0;
  for (const term of q.split(/\s+/).filter(Boolean)) {
    if (p.name.toLowerCase() === term) score += 100;
    else if (p.name.toLowerCase().includes(term)) score += 30;
    if (p.category.toLowerCase().includes(term)) score += 15;
    if (p.specs && Object.values(p.specs).join(' ').toLowerCase().includes(term)) score += 10;
    if (p.description.toLowerCase().includes(term)) score += 5;
  }
  return score;
}

function findProduct(needle) {
  const n = String(needle || '').toLowerCase().trim();
  return PRODUCTS.find((p) => p.id.toLowerCase() === n || p.sku.toLowerCase() === n);
}

function handleTool(name, args) {
  switch (name) {
    case 'search_products': {
      const limit = Math.min(50, Math.max(1, Number(args.limit || 10)));
      let results = PRODUCTS.map((p) => ({ p, score: scoreProduct(p, args.query || '') }));
      if (args.query) results = results.filter((r) => r.score > 0);
      if (args.category) {
        const c = String(args.category).toLowerCase();
        results = results.filter((r) => r.p.category.toLowerCase().includes(c));
      }
      if (args.in_stock_only === true) results = results.filter((r) => r.p.availability === 'InStock');
      results.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
      return { query: args.query || '', total_matches: results.length, currency: CURRENCY, products: results.slice(0, limit).map((r) => summarize(r.p)) };
    }
    case 'get_product': {
      const p = findProduct(args.id || args.sku);
      if (!p) return { error: `No product found: ${args.id || args.sku}`, available_ids: PRODUCTS.map((x) => x.id) };
      return { ...summarize(p), specifications: p.specs, rating: p.rating };
    }
    case 'check_availability': {
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : args.id ? [String(args.id)] : [];
      if (ids.length === 0) return { error: 'Provide id or ids.' };
      const checked = ids.map((needle) => {
        const p = findProduct(needle);
        if (!p) return { id: needle, found: false, available: false };
        return { id: p.id, sku: p.sku, name: p.name, found: true, availability: p.availability, available: p.availability === 'InStock', lead_time: p.availability === 'InStock' ? 'Ships in 24h' : 'Unavailable' };
      });
      const found = checked.filter((c) => c.found);
      return { checked, all_available: found.length > 0 && found.every((c) => c.available), checked_at: new Date().toISOString() };
    }
    case 'get_pricing': {
      if (args.id) {
        const p = findProduct(args.id);
        if (!p) return { error: `No product found: ${args.id}` };
        return { id: p.id, name: p.name, price: p.price, currency: CURRENCY, formatted_price: `$${p.price.toFixed(2)}`, availability: p.availability, url: `${ORIGIN}/products/${p.id}` };
      }
      const prices = PRODUCTS.map((p) => p.price).sort((a, b) => a - b);
      return {
        currency: CURRENCY,
        products: prices.length,
        price_range: { min: prices[0], max: prices[prices.length - 1], median: prices[Math.floor(prices.length / 2)] },
      };
    }
    case 'place_order': {
      const email = String(args.customer_email || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'customer_email must be a valid email address.' };
      const items = Array.isArray(args.items) ? args.items : [];
      if (items.length === 0) return { error: 'Provide at least one item.' };
      const lines = [];
      let total = 0;
      for (const item of items) {
        const p = findProduct(item.id);
        if (!p) return { error: `No product found: ${item.id}`, offending_id: item.id };
        if (p.availability !== 'InStock') return { error: `${p.name} is ${p.availability}`, offending_id: item.id };
        const qty = Math.max(1, Math.floor(Number(item.quantity || 1)));
        const lineTotal = Number((p.price * qty).toFixed(2));
        total += lineTotal;
        lines.push({ id: p.id, sku: p.sku, name: p.name, quantity: qty, unit_price: p.price, line_total: lineTotal });
      }
      const orderId = `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      return {
        order_id: orderId,
        status: 'pending_payment',
        customer_email: email,
        items: lines,
        total: Number(total.toFixed(2)),
        currency: CURRENCY,
        formatted_total: `$${total.toFixed(2)}`,
        payment_url: `${ORIGIN}/checkout?order=${orderId}`,
        created_at: new Date().toISOString(),
      };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function handleRpc(message) {
  const isNotification = message.id === undefined || message.id === null;
  const reply = (payload) => (isNotification ? null : payload);
  switch (message.method) {
    case 'initialize':
      return reply({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: ORGANIZATION.slug, version: '1.0.0' },
        },
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply({ jsonrpc: '2.0', id: message.id, result: {} });
    case 'tools/list':
      return reply({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    case 'tools/call': {
      const name = message.params?.name;
      const handler = TOOLS.find((t) => t.name === name);
      if (!handler) return reply({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      let result;
      try {
        result = handleTool(name, message.params?.arguments || {});
      } catch (err) {
        return reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true } });
      }
      return reply({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(result.error ? { isError: true } : {}) },
      });
    }
    case 'resources/list':
      return reply({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
    case 'prompts/list':
      return reply({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } });
    default:
      return isNotification ? null : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

// --- HTML ------------------------------------------------------------------

const LAYOUT = (title, description, body, extraHead = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${ORIGIN}/">
<link rel="alternate" hreflang="en" href="${ORIGIN}/">
<link rel="alternate" type="text/plain" href="${ORIGIN}/llms.txt" title="Agent summary">
<link rel="alternate" type="application/json" href="${ORIGIN}/.well-known/mcp.json" title="MCP server manifest">
<link rel="stylesheet" href="/style.css">
<script type="application/ld+json">
${JSON.stringify(graph()).replace(/<\//g, '<\\/')}
</script>
${extraHead}
</head>
<body>
<header>
  <a class="brand" href="/">${NAME}</a>
  <nav>
    <a href="/products">Products</a>
    <a href="/pricing">Pricing</a>
    <a href="/llms.txt">llms.txt</a>
    <a href="/docs">API &amp; MCP docs</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <p>${NAME} — ${ORGANIZATION.description}</p>
  <p>
    Machine consumers: <a href="/llms.txt">llms.txt</a> ·
    <a href="/openapi.json">OpenAPI</a> ·
    <a href="/.well-known/mcp.json">MCP manifest</a> ·
    <a href="/.well-known/oauth-authorization-server">OAuth discovery</a>
  </p>
</footer>
</body>
</html>`;

function homePage() {
  const featured = PRODUCTS.slice(0, 6)
    .map(
      (p) => `    <article class="card">
      <h3><a href="/products/${p.id}">${p.name}</a></h3>
      <p class="price">$${p.price.toFixed(2)}</p>
      <p>${p.description.slice(0, 90)}</p>
      <p class="stock ${p.availability === 'InStock' ? 'in' : 'out'}">${p.availability === 'InStock' ? 'In stock — ships in 24 hours' : 'Out of stock'}</p>
    </article>`,
    )
    .join('\n');

  return LAYOUT(
    `${NAME} — ${ORGANIZATION.tagline}`,
    ORGANIZATION.description,
    `<section class="hero">
  <h1>${NAME}</h1>
  <p class="lede">${ORGANIZATION.description}</p>
  <p><a class="cta" href="/products">Browse the catalogue</a> <a class="cta secondary" href="/pricing">See pricing</a></p>
</section>

<h2>What we sell</h2>
<section class="grid">
${featured}
</section>

<h2>Frequently asked</h2>
<h3>Do you have an API?</h3>
<p>Yes. We run a live MCP server at <code>${ORIGIN}/mcp</code> with the tools <code>search_products</code>, <code>get_product</code>, <code>check_availability</code>, <code>get_pricing</code> and <code>place_order</code>. The discovery manifest is at <a href="/.well-known/mcp.json">/.well-known/mcp.json</a> and the full REST description is <a href="/openapi.json">openapi.json</a>.</p>

<h3>How fast is shipping?</h3>
<p>Every in-stock order ships within 24 hours with flat-rate $4.99 shipping. Orders placed through the MCP <code>place_order</code> tool are held for payment for 30 minutes.</p>

<h3>How can I integrate this?</h3>
<p>Read <a href="/llms.txt">llms.txt</a> first — it is the short machine-readable summary of this site. Then either call the MCP endpoint directly or use the REST API described in <a href="/openapi.json">openapi.json</a>. Rate limit is 60 requests per minute per client, and we return <code>Retry-After</code> when you exceed it.</p>

<h3>Do I need an account to order?</h3>
<p>No. Ordering is available to agents and humans alike through the same endpoints. Machine clients should present a bearer token issued by our OAuth server.</p>`,
  );
}

function productsPage() {
  const rows = PRODUCTS.map(
    (p) => `    <tr>
      <td><a href="/products/${p.id}">${p.name}</a></td>
      <td>${p.category}</td>
      <td>${p.sku}</td>
      <td>$${p.price.toFixed(2)}</td>
      <td>${p.availability}</td>
    </tr>`,
  ).join('\n');

  return LAYOUT(
    `All products — ${NAME}`,
    `Every product ${NAME} sells, with prices in ${CURRENCY} and current availability.`,
    `<h1>All products</h1>
<p class="lede">${PRODUCTS.length} products, priced in ${CURRENCY}. Every row here is also available through our <a href="/mcp">MCP server</a>.</p>
<table>
  <thead><tr><th>Product</th><th>Category</th><th>SKU</th><th>Price</th><th>Availability</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<p><a class="cta" href="/pricing">Pricing details</a></p>`,
  );
}

function productPage(id) {
  const p = findProduct(id);
  if (!p) return null;

  const specRows = Object.entries(p.specs)
    .map(([k, v]) => `    <tr><th>${k}</th><td>${v}</td></tr>`)
    .join('\n');

  return LAYOUT(
    `${p.name} — ${NAME}`,
    p.description,
    `<nav class="crumbs"><a href="/">Home</a> / <a href="/products">Products</a> / ${p.name}</nav>
<article class="product">
  <h1>${p.name}</h1>
  <p class="lede">${p.description}</p>
  <p class="price big">$${p.price.toFixed(2)} <span class="sku">${p.sku}</span></p>
  <p class="stock ${p.availability === 'InStock' ? 'in' : 'out'}">
    ${p.availability === 'InStock' ? 'In stock — ships within 24 hours' : `Currently ${p.availability}`}
  </p>
  <form class="cart" method="post" action="/cart/add">
    <input type="hidden" name="id" value="${p.id}">
    <button type="submit">Add to cart</button>
  </form>
  <h2>Specifications</h2>
  <table class="specs">
    <tbody>
${specRows}
    </tbody>
  </table>
  ${p.rating ? `<h2>Reviews</h2><p>Rated ${p.rating.value}/5 from ${p.rating.count} reviews.</p>` : ''}
  <h2>Buy this product</h2>
  <p>Humans can add it to the cart above. Agents should call <code>get_product</code> then <code>place_order</code> on <a href="/mcp">${ORIGIN}/mcp</a>.</p>
</article>`,
    // Per-product JSON-LD so the detail page is independently parseable.
    `<script type="application/ld+json">${JSON.stringify(productNode(p)).replace(/<\//g, '<\\/')}</script>`,
  );
}

function pricingPage() {
  const tiers = [
    { name: 'Standard shipping', price: 4.99, note: 'Ships in 24 hours, 3-5 business days' },
    { name: 'Express shipping', price: 14.99, note: 'Ships same day, next business day' },
    { name: 'Bulk orders', price: null, note: 'From 50 units — contact sales for a quote' },
  ];

  const tierRows = tiers
    .map(
      (t) => `    <tr>
      <td>${t.name}</td>
      <td>${t.price !== null ? `$${t.price.toFixed(2)}` : 'Custom'}</td>
      <td>${t.note}</td>
    </tr>`,
    )
    .join('\n');

  const cheapest = Math.min(...PRODUCTS.map((p) => p.price));
  const dearest = Math.max(...PRODUCTS.map((p) => p.price));

  return LAYOUT(
    `Pricing — ${NAME}`,
    `Product prices start at $${cheapest.toFixed(2)}. Shipping from $4.99.`,
    `<h1>Pricing</h1>
<p class="lede">All prices are in ${CURRENCY} and include tax. There is no subscription and no minimum order.</p>

<h2>Product prices</h2>
<p>Products range from $${cheapest.toFixed(2)} to $${dearest.toFixed(2)}. Full per-product pricing, including price ranges by category, is available from the <code>get_pricing</code> MCP tool without an API key.</p>

<h2>Shipping</h2>
<table>
  <thead><tr><th>Service</th><th>Price</th><th>Delivery</th></tr></thead>
  <tbody>
${tierRows}
  </tbody>
</table>

<h2>For developers</h2>
<p>Reading prices programmatically is free and unmetered. Agents may call <code>get_pricing</code> on our <a href="/mcp">MCP server</a>, or read the <code>offers</code> block in this page's schema.org JSON-LD. There is no rate limit on pricing queries specifically; general limit is 60 requests per minute.</p>`,
  );
}

function docsPage() {
  return LAYOUT(
    `API & MCP docs — ${NAME}`,
    'How to integrate with the AgentReady demo store over MCP, REST and OAuth.',
    `<h1>API &amp; MCP documentation</h1>

<h2>MCP server</h2>
<p>Endpoint: <code>${ORIGIN}/mcp</code> (JSON-RPC 2.0 over HTTP POST). Discovery manifest: <a href="/.well-known/mcp.json">/.well-known/mcp.json</a>.</p>
<pre><code>curl -s ${ORIGIN}/mcp \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>

<h3>Tools</h3>
<table>
  <thead><tr><th>Tool</th><th>Purpose</th></tr></thead>
  <tbody>
${TOOLS.map((t) => `    <tr><td><code>${t.name}</code></td><td>${t.description}</td></tr>`).join('\n')}
  </tbody>
</table>

<h2>REST API</h2>
<p>Every MCP tool has a REST equivalent, described in <a href="/openapi.json">openapi.json</a>.</p>
<ul>
  <li><code>GET /products</code> — search the catalogue</li>
  <li><code>GET /products/{id}</code> — one product</li>
  <li><code>GET /availability?ids=a,b</code> — stock state</li>
  <li><code>GET /pricing</code> — price statistics</li>
  <li><code>POST /orders</code> — place an order</li>
</ul>

<h2>Authentication</h2>
<p>Browsing, search and pricing need no credentials. To place orders, present a bearer token from our OAuth server. Discovery metadata is at <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>, and we support the <code>client_credentials</code> grant so an unattended agent can authenticate.</p>
<pre><code>{
  "issuer": "${ORIGIN}",
  "token_endpoint": "${ORIGIN}/oauth/token",
  "grant_types_supported": ["client_credentials", "authorization_code"],
  "scopes_supported": ["catalog:read", "orders:write"]
}</code></pre>

<h2>Rate limits</h2>
<p>60 requests per minute per client id. Responses include <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and <code>RateLimit-Reset</code>. Exceeding the limit returns HTTP 429 with a <code>Retry-After</code> header.</p>
<p>Daily quota is 50,000 requests per client. If you need more, ask and we will raise it.</p>`,
  );
}

const LLMS_TXT = `# ${NAME}

> ${ORGANIZATION.description}

Site: ${ORIGIN}

## What we sell
${PRODUCTS.map((p) => `- ${p.name} (${p.sku}) — $${p.price.toFixed(2)}, ${p.availability}`).join('\n')}

## Pricing
- Product range: $${Math.min(...PRODUCTS.map((p) => p.price)).toFixed(2)}–$${Math.max(...PRODUCTS.map((p) => p.price)).toFixed(2)}
- Standard shipping: $4.99, ships in 24 hours
- Express shipping: $14.99, next business day
- No subscription, no minimum order

## Availability
${PRODUCTS.map((p) => `- ${p.name}: ${p.availability}`).join('\n')}

## For agents and developers
- MCP server: ${ORIGIN}/mcp (tools: ${TOOLS.map((t) => t.name).join(', ')})
- MCP manifest: ${ORIGIN}/.well-known/mcp.json
- REST API: ${ORIGIN}/openapi.json
- Product catalogue (REST): ${ORIGIN}/products
- Documentation: ${ORIGIN}/docs
- Auth: OAuth client_credentials, discovery at ${ORIGIN}/.well-known/oauth-authorization-server

## Rate limits
- 60 requests per minute per client id
- Daily quota 50,000 requests per client
- Exceeding the limit returns HTTP 429 with a Retry-After header

## Contact
${ORGANIZATION.email}
`;

const STYLE = `:root{--bg:#fff;--fg:#14161a;--muted:#5b6472;--line:#e4e7ec;--accent:#1c7ed6}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;justify-content:space-between;align-items:center;padding:1rem 2rem;border-bottom:1px solid var(--line)}
.brand{font-weight:700;text-decoration:none;color:var(--fg)}
nav a{margin-left:1rem;color:var(--muted);text-decoration:none}
nav a:hover{color:var(--accent)}
main{max-width:900px;margin:0 auto;padding:2rem}
.hero{padding:2rem 0 3rem}
.lede{font-size:1.15rem;color:var(--muted)}
h1{font-size:2.2rem;line-height:1.2;margin:0 0 .5rem}
h2{margin-top:2.5rem;border-top:1px solid var(--line);padding-top:1.5rem}
h3{margin-top:1.5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1rem}
.card{border:1px solid var(--line);border-radius:10px;padding:1rem}
.card h3{margin:0 0 .5rem;font-size:1.05rem}
.card a{text-decoration:none;color:var(--fg)}
.price{font-weight:700}
.price.big{font-size:1.8rem}
.sku{font-weight:400;color:var(--muted);font-size:.9rem}
.stock{font-size:.9rem}
.stock.in{color:#2b8a3e}
.stock.out{color:#c92a2a}
.cta{display:inline-block;padding:.6rem 1.1rem;background:var(--accent);color:#fff;border-radius:8px;text-decoration:none;font-weight:600}
.cta.secondary{background:#e7f0fb;color:var(--accent)}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid var(--line);padding:.55rem .7rem;text-align:left;font-size:.94rem}
thead th{background:#f8f9fa}
.specs th{width:40%;background:#f8f9fa;font-weight:600}
button{padding:.6rem 1.2rem;background:var(--fg);color:#fff;border:0;border-radius:8px;font-weight:600;cursor:pointer}
pre{background:#0d1117;color:#e6edf3;padding:1rem;border-radius:8px;overflow-x:auto;font-size:.85rem}
code{background:#f1f3f5;padding:.1rem .35rem;border-radius:4px;font-size:.9em}
pre code{background:none;padding:0;color:inherit}
.crumbs{font-size:.9rem;color:var(--muted);margin-bottom:1rem}
footer{border-top:1px solid var(--line);padding:2rem;color:var(--muted);font-size:.9rem;max-width:900px;margin:2rem auto}
`;

function openApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: `${NAME} API`,
      version: '1.0.0',
      description: ORGANIZATION.description,
      license: { name: 'MIT', identifier: 'MIT' },
      contact: { email: ORGANIZATION.email },
    },
    servers: [{ url: ORIGIN }],
    paths: {
      '/products': {
        get: {
          summary: 'Search the product catalogue',
          operationId: 'searchProducts',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Free-text search' },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'in_stock_only', in: 'query', schema: { type: 'boolean', default: false } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } },
          ],
          responses: { '200': { description: 'Matching products' }, '429': { description: 'Rate limit exceeded' } },
        },
      },
      '/products/{id}': {
        get: {
          summary: 'Get one product',
          operationId: 'getProduct',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Product detail' }, '404': { description: 'Not found' } },
        },
      },
      '/availability': {
        get: {
          summary: 'Check availability',
          operationId: 'checkAvailability',
          parameters: [{ name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'string' } }, description: 'Comma-separated ids or SKUs' }],
          responses: { '200': { description: 'Stock state' } },
        },
      },
      '/pricing': {
        get: { summary: 'Pricing statistics', operationId: 'getPricing', responses: { '200': { description: 'Price range by product and category' } } },
      },
      '/orders': {
        post: {
          summary: 'Place an order',
          operationId: 'placeOrder',
          security: [{ bearerAuth: ['orders:write'] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items', 'customer_email'],
                  properties: {
                    items: { type: 'array', items: { type: 'object', required: ['id', 'quantity'], properties: { id: { type: 'string' }, quantity: { type: 'integer' } } } },
                    customer_email: { type: 'string', format: 'email' },
                    shipping_address: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Order created, pending payment' }, '402': { description: 'Payment required' }, '429': { description: 'Rate limit exceeded' } },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Product: {
          type: 'object',
          required: ['id', 'name', 'price', 'currency', 'availability'],
          properties: {
            id: { type: 'string' },
            sku: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string' },
            price: { type: 'number' },
            currency: { type: 'string', example: 'USD' },
            availability: { type: 'string', enum: ['InStock', 'OutOfStock', 'PreOrder', 'BackOrder'] },
            url: { type: 'string', format: 'uri' },
          },
        },
      },
    },
    'x-mcp': { endpoint: `${ORIGIN}/mcp`, protocolVersion: '2025-06-18', tools: TOOLS.map((t) => t.name) },
  };
}

// --- server ----------------------------------------------------------------

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const text = (body, type, status = 200) =>
  new Response(body, { status, headers: { 'content-type': `${type}; charset=utf-8` } });

/** Rate-limit headers, echoed on every API response as documented. */
const RATE_HEADERS = {
  'ratelimit-limit': '60',
  'ratelimit-remaining': '59',
  'ratelimit-reset': '60',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  /**
   * Send a Response through node:http.
   *
   * `response.body` is a ReadableStream, not a string — it has to be drained.
   * This is the single most common way to get an empty 200 out of a hand-rolled
   * node:http adapter.
   */
  const send = async (response) => {
    const headers = { ...RATE_HEADERS, ...Object.fromEntries(response.headers) };
    if (!res.headersSent) res.writeHead(response.status, headers);
    if (response.body === null) {
      res.end();
      return;
    }
    res.end(await response.text());
  };

  /** Send a bare status with no body (204/202). */
  const sendStatus = (status) => {
    if (!res.headersSent) res.writeHead(status, RATE_HEADERS);
    res.end();
  };

  void sendStatus;

  try {
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' });
      res.end();
      return;
    }

    // -- MCP --------------------------------------------------------------
    if (path === '/mcp' && method === 'POST') {
      let body;
      try {
        body = await new Promise((resolve, reject) => {
          let raw = '';
          req.on('data', (c) => {
            raw += c;
            if (raw.length > 2_000_000) reject(new Error('body too large'));
          });
          req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
          req.on('error', reject);
        });
      } catch {
        await send(json({ error: 'Invalid JSON' }, 400));
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      const responses = messages.map(handleRpc).filter(Boolean);
      await send(responses.length === 0 ? new Response('', { status: 202 }) : json(responses.length === 1 ? responses[0] : responses));
      return;
    }

    if (path === '/.well-known/mcp.json') {
      await send(json({
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json',
        name: `${ORGANIZATION.slug}-mcp`,
        description: ORGANIZATION.description,
        version: '1.0.0',
        protocolVersion: '2025-06-18',
        websiteUrl: ORIGIN,
        mcpServers: { [ORGANIZATION.slug]: { type: 'http', url: `${ORIGIN}/mcp`, websiteUrl: ORIGIN } },
        remotes: [{ type: 'streamable-http', url: `${ORIGIN}/mcp` }],
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
      }));
      return;
    }

    // -- machine auth -----------------------------------------------------
    if (path === '/.well-known/oauth-authorization-server') {
      await send(json({
        issuer: ORIGIN,
        token_endpoint: `${ORIGIN}/oauth/token`,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        grant_types_supported: ['client_credentials', 'authorization_code'],
        response_types_supported: ['token', 'code'],
        scopes_supported: ['catalog:read', 'orders:write'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      }));
      return;
    }
    if (path === '/.well-known/oauth-protected-resource') {
      await send(json({ resource: ORIGIN, authorization_servers: [ORIGIN], scopes_supported: ['catalog:read', 'orders:write'] }));
      return;
    }

    // -- machine-readable surfaces ---------------------------------------
    if (path === '/openapi.json') { send(json(openApi())); return; }
    if (path === '/llms.txt') { send(text(LLMS_TXT, 'text/plain')); return; }
    if (path === '/llms-full.txt') { send(text(`${LLMS_TXT}\n## Full product specifications\n\n${PRODUCTS.map((p) => `### ${p.name}\n${p.description}\n\n- SKU: ${p.sku}\n- Price: $${p.price.toFixed(2)}\n- Availability: ${p.availability}\n- Category: ${p.category}\n\nSpecifications:\n${Object.entries(p.specs).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`).join('\n\n')}\n`, 'text/plain')); return; }
    if (path === '/robots.txt') {
      await send(text(`User-agent: *\nAllow: /\nDisallow: /cart/\nDisallow: /checkout\nCrawl-delay: 1\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, 'text/plain'));
      return;
    }
    if (path === '/sitemap.xml') {
      const urls = ['/', '/products', '/pricing', '/docs', ...PRODUCTS.map((p) => `/products/${p.id}`)];
      await send(text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${ORIGIN}${u}</loc></url>`).join('\n')}\n</urlset>`, 'application/xml'));
      return;
    }
    if (path === '/.well-known/agent.json') {
      await send(json({ name: ORGANIZATION.slug, description: ORGANIZATION.description, url: ORIGIN, mcp: `${ORIGIN}/mcp`, api: `${ORIGIN}/openapi.json` }));
      return;
    }

    // -- REST mirrors of the MCP tools -----------------------------------
    if (path === '/products' && method === 'GET') {
      await send(json(handleTool('search_products', {
        query: url.searchParams.get('q') ?? undefined,
        category: url.searchParams.get('category') ?? undefined,
        in_stock_only: url.searchParams.get('in_stock_only') === 'true',
        limit: Number(url.searchParams.get('limit') ?? 10),
      })));
      return;
    }

    const productMatch = /^\/products\/([^/]+)$/.exec(path);
    if (productMatch && method === 'GET') {
      const result = handleTool('get_product', { id: decodeURIComponent(productMatch[1]) });
      if (result.error) { send(json(result, 404)); return; }
      await send(json(result));
      return;
    }

    if (path === '/availability' && method === 'GET') {
      const ids = (url.searchParams.get('ids') ?? url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      await send(json(handleTool('check_availability', { ids })));
      return;
    }

    if (path === '/pricing' && method === 'GET' && url.searchParams.has('format')) {
      await send(json(handleTool('get_pricing', {})));
      return;
    }

    if (path === '/orders' && method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { send(json({ error: 'Invalid JSON' }, 400)); return; }
      const result = handleTool('place_order', body);
      await send(json(result, result.error ? 400 : 201));
      return;
    }

    if (path === '/cart/add' && method === 'POST') {
      res.writeHead(303, { location: '/checkout' });
      res.end();
      return;
    }

    // -- HTML pages -------------------------------------------------------
    if (path === '/style.css') { send(text(STYLE, 'text/css')); return; }
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (path === '/logo.svg') { send(text(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#1c7ed6"/><text x="32" y="43" font-size="30" font-family="sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${ORGANIZATION.initial}</text></svg>`, 'image/svg+xml')); return; }

    if (path === '/') { send(html(homePage())); return; }
    if (path === '/products') { send(html(productsPage())); return; }
    if (productMatch) {
      const page = productPage(decodeURIComponent(productMatch[1]));
      if (page) { send(html(page)); return; }
      await send(html(LAYOUT('Not found', 'Product not found', '<h1>Not found</h1><p>No such product. <a href="/products">Browse all products</a>.</p>'), 404));
      return;
    }
    if (path === '/pricing') { send(html(pricingPage())); return; }
    if (path === '/docs') { send(html(docsPage())); return; }
    if (path === '/checkout') {
      await send(html(LAYOUT('Checkout', 'Complete your order', `<h1>Checkout</h1><p class="lede">Human checkout. Agents should use the <code>place_order</code> MCP tool instead — it returns a payment link for this page.</p><p><a class="cta" href="/products">Continue shopping</a></p>`)));
      return;
    }

    await send(html(LAYOUT('Not found', 'Page not found', `<h1>404</h1><p>Nothing here. Try the <a href="/">homepage</a> or the <a href="/llms.txt">llms.txt</a>.</p>`), 404));
  } catch (err) {
    await send(json({ error: err instanceof Error ? err.message : String(err) }, 500));
  }
});

/**
 * Start the demo site.
 *
 * Exported rather than run at import time so the seed script (and tests) can
 * control the port and shutdown. `node demo-site.mjs` runs it directly.
 */
export function start(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const origin = `http://localhost:${port}`;
      console.log(`${NAME} demo site:  ${origin}`);
      console.log(`MCP endpoint:    ${origin}/mcp`);
      console.log(`Products:        ${PRODUCTS.length}`);
      resolve({ server, origin, port });
    });
  });
}

// Only listen when executed directly, not when imported.
if (typeof process.argv[1] !== 'undefined' && /demo-site\.(mjs|js)$/.test(process.argv[1])) {
  start();
}

export { server, PRODUCTS, ORGANIZATION, graph, handleRpc, TOOLS, PORT };