/**
 * MCP server generation.
 *
 * Produces two artifacts from a catalogue:
 *   1. `spec`   — the tool manifest (used by registries and the dashboard)
 *   2. `code`   — a single self-contained JS file implementing the server over
 *                 Streamable HTTP JSON-RPC, ready to run on Cloudflare Workers
 *                 or be published to Smithery.
 *
 * The generated code deliberately embeds its data. A worker with an embedded
 * catalogue has no upstream dependency, no cold-start fetch and no rate limit
 * to inherit — which is exactly what a free-tier deployment needs.
 */

import type { DataSource, MCPServerSpec, MCPTool, Product } from '@agentready/shared';
import { round, serverSlug } from '@agentready/shared';
import { loadRecords } from './data-source.js';
import { buildMcpManifest, buildRegistryManifest, mcpEndpoint } from './manifest.js';
import { buildOpenApiSpec } from './openapi.js';

export const PROTOCOL_VERSION = '2025-06-18';

export interface GenerateOptions {
  name: string;
  description?: string;
  version?: string;
  source: DataSource;
  /** Pre-loaded entities; skips IO when supplied. */
  products?: Product[];
  siteUrl?: string;
  /** Where the server will be reachable — used in manifests and tool output. */
  publicUrl?: string;
  /** Include a place_order tool. Off if the catalogue has no ordering story. */
  includeOrderTool?: boolean;
  maxRecords?: number;
  fetchImpl?: typeof fetch;
}

export interface GenerateResult {
  spec: MCPServerSpec;
  /** Self-contained worker source. */
  code: string;
  /** /.well-known/mcp.json — the client auto-discovery document. */
  manifest: Record<string, unknown>;
  /** server.json — the Official MCP Registry publish manifest. */
  registryManifest: Record<string, unknown>;
  openapi: Record<string, unknown>;
  products: Product[];
  /** Names of tools the generated server exposes. */
  toolNames: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function stringProp(description: string) {
  return { type: 'string', description };
}

/** search_products — the tool an agent calls first, always. */
export const searchProductsTool: MCPTool = {
  name: 'search_products',
  description:
    'Search the product catalogue by free-text query. Returns matching products with price, availability and a canonical URL. Start here when a customer asks what you sell.',
  inputSchema: {
    type: 'object',
    properties: {
      query: stringProp('Search terms. Matches name, description, brand and category. Optional — omit to list everything.'),
      category: stringProp('Exact category filter.'),
      brand: stringProp('Exact brand filter.'),
      min_price: { type: 'number', description: 'Lowest price to include, in the catalogue currency.' },
      max_price: { type: 'number', description: 'Highest price to include, in the catalogue currency.' },
      in_stock_only: { type: 'boolean', description: 'Only return products currently available. Default false.' },
      limit: { type: 'number', description: 'Maximum results to return. Default 10, maximum 50.' },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** get_product — full detail including specs. */
export const getProductTool: MCPTool = {
  name: 'get_product',
  description:
    'Get the full record for one product by id or SKU, including specifications, price, availability and canonical URL. Use after search_products narrows candidates.',
  inputSchema: {
    type: 'object',
    properties: {
      id: stringProp('Product id or SKU. Exactly one of id or sku.'),
      sku: stringProp('Product SKU. Exactly one of id or sku.'),
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** check_availability — the pre-purchase gate. */
export const checkAvailabilityTool: MCPTool = {
  name: 'check_availability',
  description:
    'Check current availability and stock state for one or more products. Call before promising delivery. Returns availability, quantity status and lead time.',
  inputSchema: {
    type: 'object',
    properties: {
      id: stringProp('Product id or SKU.'),
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple product ids or SKUs to check in one call.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** get_pricing — pricing including tier context. */
export const getPricingTool: MCPTool = {
  name: 'get_pricing',
  description:
    'Get pricing for one product, or the price range across the whole catalogue. Returns currency, price, and category price bands so an agent can answer "how much does this cost".',
  inputSchema: {
    type: 'object',
    properties: {
      id: stringProp('Product id or SKU. Omit to get catalogue-wide price statistics.'),
      currency: stringProp('ISO 4217 currency code to report in. Defaults to the catalogue currency.'),
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** place_order — closes the loop. */
export const placeOrderTool: MCPTool = {
  name: 'place_order',
  description:
    'Place an order for one or more products. Returns an order id and a payment link. This is a write operation — confirm the total with the customer before calling it.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Products to order.',
        items: {
          type: 'object',
          properties: {
            id: stringProp('Product id or SKU.'),
            quantity: { type: 'number', description: 'Units to order. Minimum 1.' },
          },
          required: ['id', 'quantity'],
          additionalProperties: false,
        },
      },
      customer_email: stringProp('Email for order confirmation and the payment link.'),
      shipping_address: stringProp('Free-form shipping address.'),
      notes: stringProp('Optional note attached to the order.'),
    },
    required: ['items', 'customer_email'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

/** The five commerce tools, in the order an agent should try them. */
export const DEFAULT_TOOLS: MCPTool[] = [
  searchProductsTool,
  getProductTool,
  checkAvailabilityTool,
  getPricingTool,
  placeOrderTool,
];

// ---------------------------------------------------------------------------
// Handler implementations (also inlined into the generated worker)
// ---------------------------------------------------------------------------

type Ctx = { products: Product[]; siteUrl?: string; publicUrl?: string; currency: string };

/** Score a product against a free-text query. Simple, fast, explainable. */
export function scoreProduct(product: Product, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const terms = q.split(/\s+/).filter(Boolean);

  const name = product.name.toLowerCase();
  const description = product.description.toLowerCase();
  const brand = (product.brand ?? '').toLowerCase();
  const category = (product.category ?? '').toLowerCase();
  const sku = (product.sku ?? '').toLowerCase();
  const specs = Object.entries(product.specs ?? {})
    .map(([k, v]) => `${k} ${String(v)}`.toLowerCase())
    .join(' ');

  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.startsWith(term)) score += 50;
    else if (name.includes(term)) score += 30;
    if (brand.includes(term)) score += 20;
    if (category.includes(term)) score += 15;
    if (sku === term) score += 40;
    if (specs.includes(term)) score += 10;
    if (description.includes(term)) score += 5;
  }
  return score;
}

/** search_products handler. */
export function searchProducts(ctx: Ctx, args: Record<string, unknown>) {
  const limit = Math.min(50, Math.max(1, Number(args['limit'] ?? 10)));
  const query = String(args['query'] ?? '');
  const category = args['category'] ? String(args['category']).toLowerCase() : undefined;
  const brand = args['brand'] ? String(args['brand']).toLowerCase() : undefined;
  const minPrice = args['min_price'] === undefined ? undefined : Number(args['min_price']);
  const maxPrice = args['max_price'] === undefined ? undefined : Number(args['max_price']);
  const inStockOnly = args['in_stock_only'] === true;

  let results = ctx.products.map((p) => ({ product: p, score: scoreProduct(p, query) }));

  if (query) results = results.filter((r) => r.score > 0);
  if (category) results = results.filter((r) => (r.product.category ?? '').toLowerCase().includes(category));
  if (brand) results = results.filter((r) => (r.product.brand ?? '').toLowerCase().includes(brand));
  if (minPrice !== undefined) results = results.filter((r) => r.product.price >= minPrice);
  if (maxPrice !== undefined) results = results.filter((r) => r.product.price <= maxPrice);
  if (inStockOnly) results = results.filter((r) => r.product.availability === 'InStock');

  results.sort((a, b) => b.score - a.score || a.product.price - b.product.price);
  const top = results.slice(0, limit);

  return {
    query,
    total_matches: results.length,
    returned: top.length,
    currency: ctx.currency,
    products: top.map((r) => summarize(r.product, ctx)),
  };
}

/** get_product handler. */
export function getProduct(ctx: Ctx, args: Record<string, unknown>) {
  const needle = String(args['id'] ?? args['sku'] ?? '').trim().toLowerCase();
  if (!needle) {
    return { error: 'Provide either `id` or `sku`. Call search_products first to find a valid id.' };
  }

  const product = ctx.products.find(
    (p) =>
      p.id.toLowerCase() === needle ||
      p.sku?.toLowerCase() === needle ||
      p.name.toLowerCase() === needle,
  );

  if (!product) {
    return {
      error: `No product found with id or sku "${needle}". Use search_products to find valid identifiers.`,
      available_ids: ctx.products.slice(0, 20).map((p) => p.id),
    };
  }

  return {
    ...summarize(product, ctx),
    description: product.description,
    ...(product.specs ? { specifications: product.specs } : {}),
    ...(product.rating ? { rating: product.rating } : {}),
    ...(product.weight ? { weight: product.weight } : {}),
  };
}

/** check_availability handler. */
export function checkAvailability(ctx: Ctx, args: Record<string, unknown>) {
  const ids = args['ids'] ? (args['ids'] as unknown[]).map(String) : args['id'] ? [String(args['id'])] : [];

  if (ids.length === 0) {
    return { error: 'Provide `id` or `ids`.' };
  }

  const checked = ids.map((needle) => {
    const p = ctx.products.find((x) => x.id.toLowerCase() === needle.toLowerCase() || x.sku?.toLowerCase() === needle.toLowerCase());
    if (!p) return { id: needle, found: false, available: false, note: 'No such product.' };
    return {
      id: p.id,
      sku: p.sku ?? null,
      name: p.name,
      found: true,
      availability: p.availability,
      available: p.availability === 'InStock' || p.availability === 'PreOrder' || p.availability === 'BackOrder',
      lead_time: p.availability === 'InStock' ? 'Ships from stock' : p.availability === 'PreOrder' ? 'Pre-order' : p.availability === 'BackOrder' ? 'On backorder' : 'Unavailable',
    };
  });

  const allAvailable = checked.filter((c) => c.found).every((c) => c.available);
  return { checked, all_available: allAvailable && checked.length > 0, checked_at: new Date().toISOString() };
}

/** get_pricing handler. */
export function getPricing(ctx: Ctx, args: Record<string, unknown>) {
  const currency = String(args['currency'] ?? ctx.currency);

  const id = args['id'] === undefined ? undefined : String(args['id']);
  if (id) {
    const product = ctx.products.find((p) => p.id.toLowerCase() === id.toLowerCase() || p.sku?.toLowerCase() === id.toLowerCase());
    if (!product) return { error: `No product found with id "${id}".` };
    return {
      id: product.id,
      name: product.name,
      price: round(product.price, 2),
      currency: product.currency,
      formatted_price: `${product.currency} ${round(product.price, 2)}`,
      availability: product.availability,
      url: product.url ?? null,
    };
  }

  // Catalogue-wide statistics.
  const prices = ctx.products.map((p) => p.price).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (prices.length === 0) return { currency, products: 0, price_range: null };

  const byCategory: Record<string, { count: number; min: number; max: number }> = {};
  for (const p of ctx.products) {
    const key = p.category ?? 'Uncategorised';
    const bucket = (byCategory[key] ??= { count: 0, min: Infinity, max: -Infinity });
    bucket.count++;
    bucket.min = Math.min(bucket.min, p.price);
    bucket.max = Math.max(bucket.max, p.price);
  }

  return {
    currency,
    products: prices.length,
    price_range: {
      min: round(prices[0] ?? 0, 2),
      max: round(prices[prices.length - 1] ?? 0, 2),
      median: round(prices[Math.floor(prices.length / 2)] ?? 0, 2),
      average: round(prices.reduce((a, b) => a + b, 0) / prices.length, 2),
    },
    by_category: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [
        k,
        { count: v.count, min: round(v.min, 2), max: round(v.max, 2) },
      ]),
    ),
  };
}

/** place_order handler. Generates an order id and a payment link. */
export function placeOrder(ctx: Ctx, args: Record<string, unknown>) {
  const email = String(args['customer_email'] ?? '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: 'customer_email must be a valid email address.' };
  }

  const items = (args['items'] as Array<Record<string, unknown>> | undefined) ?? [];
  if (items.length === 0) return { error: 'Provide at least one item in `items`.' };

  const lines: Array<Record<string, unknown>> = [];
  let total = 0;

  for (const item of items) {
    const id = String(item['id'] ?? '');
    const quantity = Math.max(1, Math.floor(Number(item['quantity'] ?? 1)));
    const product = ctx.products.find((p) => p.id.toLowerCase() === id.toLowerCase() || p.sku?.toLowerCase() === id.toLowerCase());

    if (!product) return { error: `No product found with id "${id}".`, offending_id: id };
    if (product.availability === 'OutOfStock' || product.availability === 'Discontinued') {
      return { error: `${product.name} is ${product.availability} and cannot be ordered.`, offending_id: id };
    }

    const lineTotal = round(product.price * quantity, 2);
    total += lineTotal;
    lines.push({
      id: product.id,
      sku: product.sku ?? null,
      name: product.name,
      quantity,
      unit_price: round(product.price, 2),
      line_total: lineTotal,
      availability: product.availability,
    });
  }

  const orderId = `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const currency = lines[0] ? (ctx.products.find((p) => p.id === lines[0]!.id)?.currency ?? ctx.currency) : ctx.currency;

  return {
    order_id: orderId,
    status: 'pending_payment',
    customer_email: email,
    shipping_address: args['shipping_address'] ? String(args['shipping_address']) : null,
    items: lines,
    total: round(total, 2),
    currency,
    formatted_total: `${currency} ${round(total, 2)}`,
    // The generated server does not take payment itself; it hands off to the
    // site's own checkout. Never fake a payment step.
    payment_url: ctx.publicUrl ? `${ctx.publicUrl}/checkout?order=${encodeURIComponent(orderId)}` : null,
    next_step: 'Send payment_url to the customer to complete payment.',
    created_at: new Date().toISOString(),
  };
}

/** Compact product shape returned by search and pricing. */
function summarize(product: Product, ctx: Ctx) {
  return {
    id: product.id,
    name: product.name,
    description: product.description ? product.description.slice(0, 240) : '',
    ...(product.sku ? { sku: product.sku } : {}),
    ...(product.brand ? { brand: product.brand } : {}),
    ...(product.category ? { category: product.category } : {}),
    price: round(product.price, 2),
    currency: product.currency,
    formatted_price: `${product.currency} ${round(product.price, 2)}`,
    availability: product.availability,
    in_stock: product.availability === 'InStock',
    ...(product.image ? { image: product.image } : {}),
    ...(product.url ? { url: product.url } : {}),
    ...(ctx.siteUrl && !product.url ? { url: `${ctx.siteUrl.replace(/\/$/, '')}/products/${product.id}` } : {}),
  };
}

/** Dispatch a tool call to its handler. Used in tests and the generated worker. */
export function callTool(
  ctx: Ctx,
  name: string,
  args: Record<string, unknown>,
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const run = (): unknown => {
    switch (name) {
      case 'search_products':
        return searchProducts(ctx, args);
      case 'get_product':
        return getProduct(ctx, args);
      case 'check_availability':
        return checkAvailability(ctx, args);
      case 'get_pricing':
        return getPricing(ctx, args);
      case 'place_order':
        return placeOrder(ctx, args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  };

  let result: unknown;
  try {
    result = run();
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      isError: true,
    };
  }

  const isError = Boolean((result as { error?: unknown })?.error);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(isError ? { isError } : {}) };
}

// ---------------------------------------------------------------------------
// Code emission
// ---------------------------------------------------------------------------

/**
 * Emit the standalone worker source.
 *
 * Kept as one template string on purpose: the output must run with zero
 * dependencies and zero build step, because it is deployed to a Worker or
 * pasted into Smithery.
 */
export function emitWorkerCode(opts: {
  name: string;
  description: string;
  version: string;
  publicUrl: string;
  siteUrl?: string;
  products: Product[];
  tools: MCPTool[];
}): string {
  const slug = serverSlug(opts.name);
  const currency = opts.products[0]?.currency ?? 'USD';

  return `/**
 * ${opts.name} — MCP server
 * ${opts.description}
 *
 * Generated by AgentReady. Do not edit by hand; regenerate with:
 *   agentready generate --name ${opts.name} --source csv --file catalogue.csv
 *
 * Runs on Cloudflare Workers (free tier, 100k requests/day) with no
 * dependencies and no build step.
 */

const SERVER_INFO = { name: ${JSON.stringify(slug)}, version: ${JSON.stringify(opts.version)} };
const PROTOCOL_VERSION = ${JSON.stringify(PROTOCOL_VERSION)};
const PUBLIC_URL = ${JSON.stringify(opts.publicUrl)};
const SITE_URL = ${JSON.stringify(opts.siteUrl ?? '')};
const CURRENCY = ${JSON.stringify(currency)};

const PRODUCTS = ${JSON.stringify(opts.products, null, 2)};

const TOOLS = ${JSON.stringify(opts.tools, null, 2)};

/** CORS is required: browser-based agents (ChatGPT, Claude web) call us cross-origin. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version',
  'access-control-expose-headers': 'mcp-session-id',
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...(init.headers || {}) },
  });
}

/** The streamable-http endpoint, without ever doubling the /mcp segment. */
function mcpEndpoint() {
  const base = PUBLIC_URL.replace(/\\/+$/, '');
  return base.endsWith('/mcp') ? base : base + '/mcp';
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function summarize(product) {
  return {
    id: product.id,
    name: product.name,
    description: (product.description || '').slice(0, 240),
    sku: product.sku || undefined,
    brand: product.brand || undefined,
    category: product.category || undefined,
    price: Math.round(Number(product.price) * 100) / 100,
    currency: product.currency,
    formatted_price: product.currency + ' ' + (Math.round(Number(product.price) * 100) / 100),
    availability: product.availability,
    in_stock: product.availability === 'InStock',
    image: product.image || undefined,
    url: product.url || (SITE_URL ? SITE_URL.replace(/\\/$/, '') + '/products/' + product.id : undefined),
  };
}

function scoreProduct(product, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 1;
  const terms = q.split(/\\s+/).filter(Boolean);
  const name = product.name.toLowerCase();
  const description = product.description.toLowerCase();
  const brand = (product.brand || '').toLowerCase();
  const category = (product.category || '').toLowerCase();
  const sku = (product.sku || '').toLowerCase();
  const specs = Object.entries(product.specs || {}).map(([k, v]) => k + ' ' + v).join(' ').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.startsWith(term)) score += 50;
    else if (name.includes(term)) score += 30;
    if (sku === term) score += 40;
    if (brand.includes(term)) score += 20;
    if (category.includes(term)) score += 15;
    if (specs.includes(term)) score += 10;
    if (description.includes(term)) score += 5;
  }
  return score;
}

function findProduct(needle) {
  const n = String(needle || '').trim().toLowerCase();
  if (!n) return undefined;
  return PRODUCTS.find(
    (p) => p.id.toLowerCase() === n || (p.sku || '').toLowerCase() === n || p.name.toLowerCase() === n,
  );
}

const HANDLERS = {
  search_products(args) {
    const limit = Math.min(50, Math.max(1, Number(args.limit || 10)));
    let results = PRODUCTS.map((p) => ({ product: p, score: scoreProduct(p, args.query || '') }));
    if (args.query) results = results.filter((r) => r.score > 0);
    if (args.category) {
      const c = String(args.category).toLowerCase();
      results = results.filter((r) => (r.product.category || '').toLowerCase().includes(c));
    }
    if (args.brand) {
      const b = String(args.brand).toLowerCase();
      results = results.filter((r) => (r.product.brand || '').toLowerCase().includes(b));
    }
    if (args.min_price !== undefined) results = results.filter((r) => r.product.price >= Number(args.min_price));
    if (args.max_price !== undefined) results = results.filter((r) => r.product.price <= Number(args.max_price));
    if (args.in_stock_only === true) results = results.filter((r) => r.product.availability === 'InStock');
    results.sort((a, b) => b.score - a.score || a.product.price - b.product.price);
    const top = results.slice(0, limit);
    return {
      query: args.query || '',
      total_matches: results.length,
      returned: top.length,
      currency: CURRENCY,
      products: top.map((r) => summarize(r.product)),
    };
  },

  get_product(args) {
    const product = findProduct(args.id || args.sku);
    if (!product) {
      return { error: 'No product found. Call search_products first to find a valid id.', available_ids: PRODUCTS.slice(0, 20).map((p) => p.id) };
    }
    return {
      ...summarize(product),
      description: product.description,
      specifications: product.specs || undefined,
      rating: product.rating,
      weight: product.weight,
    };
  },

  check_availability(args) {
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : args.id ? [String(args.id)] : [];
    if (ids.length === 0) return { error: 'Provide id or ids.' };
    const checked = ids.map((needle) => {
      const p = findProduct(needle);
      if (!p) return { id: needle, found: false, available: false, note: 'No such product.' };
      return {
        id: p.id,
        sku: p.sku || null,
        name: p.name,
        found: true,
        availability: p.availability,
        available: p.availability === 'InStock' || p.availability === 'PreOrder' || p.availability === 'BackOrder',
        lead_time:
          p.availability === 'InStock'
            ? 'Ships from stock'
            : p.availability === 'PreOrder'
              ? 'Pre-order'
              : p.availability === 'BackOrder'
                ? 'On backorder'
                : 'Unavailable',
      };
    });
    const found = checked.filter((c) => c.found);
    return {
      checked,
      all_available: found.length > 0 && found.every((c) => c.available),
      checked_at: new Date().toISOString(),
    };
  },

  get_pricing(args) {
    if (args.id) {
      const product = findProduct(args.id);
      if (!product) return { error: 'No product found with id ' + args.id + '.' };
      return {
        id: product.id,
        name: product.name,
        price: Math.round(Number(product.price) * 100) / 100,
        currency: product.currency,
        formatted_price: product.currency + ' ' + (Math.round(Number(product.price) * 100) / 100),
        availability: product.availability,
        url: product.url || null,
      };
    }
    const prices = PRODUCTS.map((p) => Number(p.price)).filter(Number.isFinite).sort((a, b) => a - b);
    if (prices.length === 0) return { currency: CURRENCY, products: 0, price_range: null };
    const byCategory = {};
    for (const p of PRODUCTS) {
      const key = p.category || 'Uncategorised';
      const b = (byCategory[key] = byCategory[key] || { count: 0, min: Infinity, max: -Infinity });
      b.count++;
      b.min = Math.min(b.min, Number(p.price));
      b.max = Math.max(b.max, Number(p.price));
    }
    const total = prices.reduce((a, b) => a + b, 0);
    return {
      currency: args.currency || CURRENCY,
      products: prices.length,
      price_range: {
        min: prices[0],
        max: prices[prices.length - 1],
        median: prices[Math.floor(prices.length / 2)],
        average: Math.round((total / prices.length) * 100) / 100,
      },
      by_category: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, { count: v.count, min: v.min, max: v.max }]),
      ),
    };
  },

  place_order(args) {
    const email = String(args.customer_email || '').trim();
    if (!email || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
      return { error: 'customer_email must be a valid email address.' };
    }
    const items = Array.isArray(args.items) ? args.items : [];
    if (items.length === 0) return { error: 'Provide at least one item in items.' };
    const lines = [];
    let total = 0;
    for (const item of items) {
      const product = findProduct(item.id);
      if (!product) return { error: 'No product found with id ' + item.id + '.', offending_id: item.id };
      if (product.availability === 'OutOfStock' || product.availability === 'Discontinued') {
        return { error: product.name + ' is ' + product.availability + ' and cannot be ordered.', offending_id: item.id };
      }
      const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
      const lineTotal = Math.round(Number(product.price) * quantity * 100) / 100;
      total += lineTotal;
      lines.push({
        id: product.id,
        sku: product.sku || null,
        name: product.name,
        quantity,
        unit_price: Math.round(Number(product.price) * 100) / 100,
        line_total: lineTotal,
        availability: product.availability,
      });
    }
    const orderId = 'ord_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const currency = lines.length ? findProduct(lines[0].id).currency : CURRENCY;
    return {
      order_id: orderId,
      status: 'pending_payment',
      customer_email: email,
      shipping_address: args.shipping_address || null,
      items: lines,
      total: Math.round(total * 100) / 100,
      currency,
      formatted_total: currency + ' ' + (Math.round(total * 100) / 100),
      payment_url: PUBLIC_URL ? PUBLIC_URL + '/checkout?order=' + encodeURIComponent(orderId) : null,
      next_step: 'Send payment_url to the customer to complete payment.',
      created_at: new Date().toISOString(),
    };
  },
};

function handleRpc(message) {
  // Notifications carry no id and expect no response.
  const isNotification = message.id === undefined || message.id === null;
  // Reply with the JSON-RPC *payload*; the request handler serializes it.
  const reply = (payload) => (isNotification ? null : payload);

  switch (message.method) {
    case 'initialize':
      return reply(
        rpcResult(message.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            ${JSON.stringify(
              `${opts.description} Call search_products first to find products, then get_product for detail. Use check_availability before promising anything, and place_order to transact.`,
            )},
        }),
      );

    case 'notifications/initialized':
      return null;

    case 'ping':
      return reply(rpcResult(message.id, {}));

    case 'tools/list':
      return reply(rpcResult(message.id, { tools: TOOLS }));

    case 'tools/call': {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const handler = HANDLERS[name];
      if (!handler) {
        return reply(rpcError(message.id, -32601, 'Unknown tool: ' + name, { available: Object.keys(HANDLERS) }));
      }
      let result;
      try {
        result = handler(args);
      } catch (err) {
        return reply(
          rpcResult(message.id, {
            content: [{ type: 'text', text: JSON.stringify({ error: err && err.message ? err.message : String(err) }) }],
            isError: true,
          }),
        );
      }
      const isError = Boolean(result && result.error);
      return reply(
        rpcResult(message.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          ...(isError ? { isError: true } : {}),
        }),
      );
    }

    case 'resources/list':
      return reply(rpcResult(message.id, { resources: [] }));

    case 'prompts/list':
      return reply(rpcResult(message.id, { prompts: [] }));

    default:
      if (isNotification) return null;
      return reply(rpcError(message.id, -32601, 'Method not found: ' + message.method));
  }
}

/**
 * Discovery manifest served at /.well-known/mcp.json.
 *
 * This is the mcpServers map form a client fetches to auto-connect, NOT the
 * server.json shape the Official Registry expects — conflating the two is how
 * clients end up unable to find a live server.
 */
function manifest() {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json',
    name: ${JSON.stringify(slug + '-mcp')},
    description: ${JSON.stringify(opts.description)},
    version: ${JSON.stringify(opts.version)},
    protocolVersion: PROTOCOL_VERSION,
    ...(SITE_URL ? { websiteUrl: SITE_URL } : {}),
    mcpServers: {
      [${JSON.stringify(slug)}]: {
        type: 'http',
        url: mcpEndpoint(),
        ...(SITE_URL ? { websiteUrl: SITE_URL } : {}),
      },
    },
    remotes: [{ type: 'streamable-http', url: mcpEndpoint() }],
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  };
}

/** Registry-shaped manifest (server.json) for publishing to the Official Registry. */
function registryManifest() {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json',
    name: ${JSON.stringify(slug)},
    description: ${JSON.stringify(opts.description)},
    version: ${JSON.stringify(opts.version)},
    repository: { url: SITE_URL || 'https://github.com/' + ${JSON.stringify(slug)} + '/mcp-server', source: 'website' },
    packages: [
      {
        registryType: 'mcp-publisher',
        registryBaseUrl: 'https://registry.modelcontextprotocol.io',
        identifier: { name: ${JSON.stringify(slug)}, version: ${JSON.stringify(opts.version)} },
        version: ${JSON.stringify(opts.version)},
        transport: { type: 'streamable-http', url: mcpEndpoint() },
      },
    ],
    remotes: [{ type: 'streamable-http', url: mcpEndpoint() }],
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', server: SERVER_INFO, products: PRODUCTS.length, tools: TOOLS.length });
    }

    if (request.method === 'GET' && url.pathname === '/.well-known/mcp.json') {
      return json(manifest());
    }

    if (request.method === 'GET' && url.pathname === '/server.json') {
      return json(registryManifest());
    }

    if (request.method === 'GET' && url.pathname === '/openapi.json') {
      return json(env && env.OPENAPI ? JSON.parse(env.OPENAPI) : { openapi: '3.1.0', info: SERVER_INFO, paths: {} });
    }

    const isMcpPath = url.pathname === '/mcp' || url.pathname === '/' || url.pathname === '/.well-known/mcp';
    if (!isMcpPath) return json({ error: 'Not found' }, { status: 404 });

    if (request.method === 'GET') {
      // Server-sent events stream for SSE transport clients.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: endpoint\\ndata: ' + PUBLIC_URL.replace(/\\/$/, '') + '/mcp\\n\\n',
            ),
          );
          setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(': keepalive\\n\\n'));
            } catch {
              /* client went away */
            }
          }, 15000);
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS_HEADERS },
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const messages = Array.isArray(body) ? body : [body];
    const responses = messages.map(handleRpc).filter(Boolean);
    if (responses.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return json(responses.length === 1 ? responses[0] : responses);
  },
};
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generate a complete MCP server from a catalogue source.
 */
export async function generateMcpServer(options: GenerateOptions): Promise<GenerateResult> {
  const warnings: string[] = [];
  const name = options.name.trim() || 'catalogue';
  const slug = serverSlug(name);
  const version = options.version ?? '1.0.0';
  const description =
    options.description ?? `${name} product catalogue exposed as an MCP server for AI agents. ${options.products?.length ?? '?'} products.`;

  // 1. Load or accept the catalogue.
  let products = options.products;
  if (!products) {
    try {
      products = await loadRecords(options.source, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.maxRecords ? { maxRecords: options.maxRecords } : {}),
      });
    } catch (err) {
      throw new Error(`Failed to load records from ${options.source.kind}:${options.source.location} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (products.length === 0) {
    warnings.push('No records were loaded. The generated server will expose tools but have no data to answer with.');
  }

  // 2. Health warnings that make the difference between "deployed" and "used".
  const noPrice = products.filter((p) => !p.price || p.price === 0).length;
  if (noPrice > 0) {
    warnings.push(`${noPrice} product(s) have no price. get_pricing and place_order will return 0 for them.`);
  }
  const noDescription = products.filter((p) => !p.description?.trim()).length;
  if (noDescription > 0) {
    warnings.push(`${noDescription} product(s) have no description — agents rank them poorly.`);
  }
  const currencies = new Set(products.map((p) => p.currency));
  if (currencies.size > 1) {
    warnings.push(`Mixed currencies (${[...currencies].join(', ')}). Aggregates in get_pricing assume a single currency.`);
  }

  // 3. Tool set.
  const tools = options.includeOrderTool === false
    ? DEFAULT_TOOLS.filter((t) => t.name !== 'place_order')
    : [...DEFAULT_TOOLS];

  // `publicUrl` may be a root or an endpoint; mcpEndpoint normalizes it so the
  // generated worker's own URL and its manifest URL never disagree.
  const publicUrl =
    options.publicUrl ??
    mcpEndpoint(
      `https://${slug}-mcp.${options.siteUrl ? new URL(options.siteUrl).hostname.replace(/^www\./, '') : 'workers.dev'}`,
    );

  const spec: MCPServerSpec = {
    name: slug,
    version,
    description,
    tools,
    dataSource: options.source,
  };

  const code = emitWorkerCode({
    name: slug,
    description,
    version,
    publicUrl,
    ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
    products,
    tools,
  });

  const manifest = buildMcpManifest({ spec, publicUrl, ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}) });
  // The registry wants a different document shape than client discovery, so we
  // build both rather than sending a discovery manifest and getting rejected.
  const registryManifest = buildRegistryManifest({
    spec,
    publicUrl,
    ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
  });
  const openapi = buildOpenApiSpec({ spec, publicUrl, ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}) });

  return {
    spec,
    code,
    manifest,
    registryManifest,
    openapi,
    products,
    toolNames: tools.map((t) => t.name),
    warnings,
  };
}