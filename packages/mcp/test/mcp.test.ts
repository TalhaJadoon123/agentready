import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  parseCsvObjects,
  detectDelimiter,
  normalizeProduct,
  loadRecords,
  generateMcpServer,
  searchProducts,
  getProduct,
  checkAvailability,
  getPricing,
  placeOrder,
  callTool,
  scoreProduct,
  buildMcpManifest,
  buildRegistryManifest,
  validateManifest,
  buildOpenApiSpec,
  mcpEndpoint,
  workerNames,
  deployToCloudflare,
  deployLocal,
} from '../src/index.js';
import type { Product } from '@agentready/shared';

const products: Product[] = [
  { id: 'w1', name: 'Widget', description: 'A blue widget for everyday use.', sku: 'W-1', price: 19.99, currency: 'USD', availability: 'InStock', category: 'Tools', specs: { colour: 'blue' } },
  { id: 'g1', name: 'Gadget', description: 'A serious gadget for serious work.', sku: 'G-2', price: 129, currency: 'USD', availability: 'OutOfStock', category: 'Tools' },
  { id: 'p1', name: 'Power Bank', description: 'Charges a laptop at 100W.', sku: 'P-3', price: 79, currency: 'USD', availability: 'PreOrder', category: 'Power' },
];

describe('CSV parsing', () => {
  it('parses a simple table', () => {
    const rows = parseCsvObjects('id,name,price\n1,Widget,9.99\n2,Gadget,19.99');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: '1', name: 'Widget', price: '9.99' });
  });

  it('handles quoted fields with commas', () => {
    const rows = parseCsvObjects('name,description\nWidget,"A widget, quite good"\n');
    expect(rows[0]?.description).toBe('A widget, quite good');
  });

  it('handles escaped quotes', () => {
    const rows = parseCsvObjects('name\n"The ""Best"" Widget"\n');
    expect(rows[0]?.name).toBe('The "Best" Widget');
  });

  it('handles CRLF line endings', () => {
    const rows = parseCsvObjects('id,name\r\n1,Widget\r\n');
    expect(rows).toHaveLength(1);
  });

  it('handles embedded newlines in quoted fields', () => {
    const rows = parseCsvObjects('name,description\nWidget,"line one\nline two"');
    expect(rows[0]?.description).toContain('line two');
  });

  it('detects a semicolon delimiter', () => {
    expect(detectDelimiter('id;name;price')).toBe(';');
    expect(detectDelimiter('id,name,price')).toBe(',');
  });

  it('ignores fully blank rows', () => {
    const rows = parseCsv('a,b\n1,2\n\n3,4\n');
    expect(rows).toHaveLength(3);
  });
});

describe('product normalization', () => {
  it('maps loose fields onto a Product', () => {
    const p = normalizeProduct({ name: 'Widget', price: '$19.99', availability: 'in stock', sku: 'W-1' });
    expect(p?.price).toBe(19.99);
    expect(p?.availability).toBe('InStock');
    expect(p?.sku).toBe('W-1');
  });

  it('honours a custom column mapping', () => {
    const p = normalizeProduct(
      { title: 'Widget', cost: '9.99' },
      { name: 'title', price: 'cost' },
    );
    expect(p?.name).toBe('Widget');
    expect(p?.price).toBe(9.99);
  });

  it('preserves unmapped columns as specs', () => {
    const p = normalizeProduct({ name: 'Widget', price: '1', colour: 'red' });
    expect(p?.specs?.['colour']).toBe('red');
  });

  it('returns undefined without a name', () => {
    expect(normalizeProduct({ price: '10' })).toBeUndefined();
  });
});

describe('data source loading', () => {
  it('loads CSV from inline content', async () => {
    const loaded = await loadRecords(
      { kind: 'csv', location: 'inline', mapping: {} },
      { content: 'name,price,availability\nWidget,9.99,InStock\n' },
    );
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe('Widget');
  });

  it('loads JSON from inline content', async () => {
    const loaded = await loadRecords(
      { kind: 'json', location: 'inline', mapping: {} },
      { content: JSON.stringify({ products: [{ name: 'Widget', price: 5 }] }) },
    );
    expect(loaded).toHaveLength(1);
  });

  it('rejects an unknown source kind', async () => {
    await expect(loadRecords({ kind: 'ftp' as never, location: 'x', mapping: {} })).rejects.toThrow();
  });

  it('extracts products from an HTML table when scraping', async () => {
    const html = `<table><tr><th>Name</th><th>Price</th></tr><tr><td>Widget</td><td>9.99</td></tr></table>`;
    const loaded = await loadRecords({ kind: 'scrape', location: 'https://s.example', mapping: {} }, { content: html });
    expect(loaded[0]?.name).toBe('Widget');
  });
});

describe('tool handlers', () => {
  const ctx = { products, currency: 'USD' };

  it('ranks exact name matches highest', () => {
    expect(scoreProduct(products[0]!, 'widget')).toBeGreaterThan(scoreProduct(products[0]!, 'blue'));
  });

  it('searches by name and filters', () => {
    const r = searchProducts(ctx, { query: 'widget' });
    expect(r['products']?.[0]?.name).toBe('Widget');
    expect(r['total_matches']).toBe(1);
  });

  it('filters by category and stock', () => {
    const inStock = searchProducts(ctx, { category: 'tools', in_stock_only: true });
    expect((inStock['products'] as unknown[]).length).toBe(1);
  });

  it('honours the limit', () => {
    const r = searchProducts(ctx, { limit: 1 });
    expect((r['products'] as unknown[]).length).toBe(1);
  });

  it('gets a product by sku and reports helpful errors', () => {
    expect(getProduct(ctx, { sku: 'W-1' })['name']).toBe('Widget');
    const missing = getProduct(ctx, { id: 'nope' });
    expect(missing['error']).toContain('No product found');
    expect(missing['available_ids']).toBeDefined();
  });

  it('checks availability across multiple ids', () => {
    const r = checkAvailability(ctx, { ids: ['w1', 'g1'] });
    expect(r['all_available']).toBe(false);
    expect((r['checked'] as unknown[]).length).toBe(2);
  });

  it('returns catalogue-wide price statistics', () => {
    const r = getPricing(ctx, {});
    expect(r['price_range']).toMatchObject({ min: 19.99, max: 129 });
    expect(r['by_category']).toHaveProperty('Tools');
  });

  it('places an order and computes the total', () => {
    const r = placeOrder(ctx, { items: [{ id: 'w1', quantity: 2 }], customer_email: 'a@b.com' });
    expect(r['total']).toBe(39.98);
    expect(r['currency']).toBe('USD');
    expect(String(r['order_id'])).toMatch(/^ord_/);
  });

  it('refuses to order an out-of-stock product', () => {
    const r = placeOrder(ctx, { items: [{ id: 'g1', quantity: 1 }], customer_email: 'a@b.com' });
    expect(r['error']).toContain('OutOfStock');
  });

  it('validates the customer email', () => {
    const r = placeOrder(ctx, { items: [{ id: 'w1', quantity: 1 }], customer_email: 'nope' });
    expect(r['error']).toContain('valid email');
  });

  it('rejects an empty order', () => {
    expect(placeOrder(ctx, { items: [], customer_email: 'a@b.com' })['error']).toContain('at least one item');
  });

  it('wraps results as MCP tool output', () => {
    const result = callTool(ctx, 'search_products', { query: 'widget' });
    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]!.text)).toHaveProperty('products');
  });

  it('flags tool errors with isError', () => {
    const result = callTool(ctx, 'place_order', { items: [], customer_email: 'a@b.com' });
    expect(result.isError).toBe(true);
  });

  it('handles an unknown tool', () => {
    expect(callTool(ctx, 'nope', {}).content[0]?.text).toContain('Unknown tool');
  });
});

describe('server generation', () => {
  const opts = {
    name: 'Acme Store',
    source: { kind: 'json' as const, location: 'inline', mapping: {} },
    products,
  };

  it('generates the five commerce tools', async () => {
    const g = await generateMcpServer(opts);
    expect(g.toolNames).toEqual(['search_products', 'get_product', 'check_availability', 'get_pricing', 'place_order']);
  });

  it('can drop the order tool', async () => {
    const g = await generateMcpServer({ ...opts, includeOrderTool: false });
    expect(g.toolNames).not.toContain('place_order');
  });

  it('names the server with a DNS-safe slug', async () => {
    const g = await generateMcpServer({ ...opts, name: 'Acme Store!' });
    expect(g.spec.name).toBe('acme-store');
  });

  it('emits both a discovery and a registry manifest', async () => {
    const g = await generateMcpServer(opts);
    expect(g.manifest).toHaveProperty('mcpServers');
    expect(g.registryManifest).toHaveProperty('packages');
    expect(g.registryManifest).toHaveProperty('repository');
  });

  it('warns about unusable data', async () => {
    const g = await generateMcpServer({
      ...opts,
      products: [{ ...products[0]!, price: 0, description: '' }, products[1]!],
    });
    expect(g.warnings.some((w) => w.includes('no price'))).toBe(true);
    expect(g.warnings.some((w) => w.includes('no description'))).toBe(true);
  });

  it('normalizes the endpoint without doubling /mcp', () => {
    expect(mcpEndpoint('https://x.workers.dev')).toBe('https://x.workers.dev/mcp');
    expect(mcpEndpoint('https://x.workers.dev/mcp')).toBe('https://x.workers.dev/mcp');
    expect(mcpEndpoint('https://x.workers.dev/')).toBe('https://x.workers.dev/mcp');
  });

  it('produces an OpenAPI document with an orders path', async () => {
    const g = await generateMcpServer(opts);
    const paths = g.openapi['paths'] as Record<string, unknown>;
    expect(Object.keys(paths)).toContain('/orders');
    expect(g.openapi['openapi']).toBe('3.1.0');
  });
});

describe('generated worker', () => {
  async function loadWorker() {
    const g = await generateMcpServer({
      name: 'Acme Store',
      siteUrl: 'https://shop.example',
      source: { kind: 'json', location: 'inline', mapping: {} },
      products,
    });
    const mod = await import(`data:text/javascript,${encodeURIComponent(g.code)}`);
    return mod.default as { fetch: (req: Request, env: unknown) => Promise<Response> };
  }

  const rpc = async (worker: { fetch: (req: Request, env: unknown) => Promise<Response> }, method: string, params?: unknown, id = 1) => {
    const res = await worker.fetch(
      new Request('https://x.workers.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
      {},
    );
    return res.json() as Promise<any>;
  };

  it('answers initialize', async () => {
    const w = await loadWorker();
    const r = await rpc(w, 'initialize');
    expect(r.result.serverInfo.name).toBe('acme-store');
    expect(r.result.protocolVersion).toBeTruthy();
  });

  it('lists tools', async () => {
    const w = await loadWorker();
    const r = await rpc(w, 'tools/list');
    expect(r.result.tools).toHaveLength(5);
  });

  it('calls a tool and returns structured content', async () => {
    const w = await loadWorker();
    const r = await rpc(w, 'tools/call', { name: 'search_products', arguments: { query: 'widget' } }, 2);
    expect(JSON.parse(r.result.content[0].text).products[0].name).toBe('Widget');
  });

  it('marks a failed order as isError', async () => {
    const w = await loadWorker();
    const r = await rpc(w, 'tools/call', { name: 'place_order', arguments: { items: [{ id: 'g1', quantity: 1 }], customer_email: 'a@b.co' } }, 3);
    expect(r.result.isError).toBe(true);
  });

  it('returns a JSON-RPC error for an unknown tool', async () => {
    const w = await loadWorker();
    const r = await rpc(w, 'tools/call', { name: 'nope', arguments: {} }, 4);
    expect(r.error.code).toBe(-32601);
  });

  it('returns nothing for a notification', async () => {
    const w = await loadWorker();
    const res = await w.fetch(
      new Request('https://x.workers.dev/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
      {},
    );
    expect(res.status).toBe(202);
  });

  it('serves health, the discovery manifest and CORS', async () => {
    const w = await loadWorker();

    const health = await (await w.fetch(new Request('https://x.workers.dev/health'), {})).json() as any;
    expect(health.status).toBe('ok');
    expect(health.products).toBe(3);

    const manifest = await (await w.fetch(new Request('https://x.workers.dev/.well-known/mcp.json'), {})).json() as any;
    expect(manifest.mcpServers).toBeDefined();

    const preflight = await w.fetch(new Request('https://x.workers.dev/mcp', { method: 'OPTIONS' }), {});
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('404s an unknown path', async () => {
    const w = await loadWorker();
    const res = await w.fetch(new Request('https://x.workers.dev/nope'), {});
    expect(res.status).toBe(404);
  });
});

describe('manifests and deployment', () => {
  const spec = {
    name: 'acme-store',
    version: '1.0.0',
    description: 'Acme catalogue',
    tools: [{ name: 'search_products', description: 'Search', inputSchema: { type: 'object', properties: {} } }],
    dataSource: { kind: 'json' as const, location: 'inline', mapping: {} },
  };

  it('builds a valid registry manifest', () => {
    const manifest = buildRegistryManifest({ spec, publicUrl: 'https://x.workers.dev', siteUrl: 'https://acme.example' });
    const result = validateManifest(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('flags an invalid registry manifest', () => {
    const result = validateManifest({ name: 'Bad Name', version: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('repository.url'))).toBe(true);
  });

  it('builds a discovery manifest with mcpServers', () => {
    const manifest = buildMcpManifest({ spec, publicUrl: 'https://x.workers.dev' });
    expect(manifest['mcpServers']).toHaveProperty('acme-store');
  });

  it('derives a worker name and URL', () => {
    const { script, url } = workerNames(spec, 'agentready');
    expect(script).toBe('acme-store-mcp');
    expect(url).toContain('workers.dev');
  });

  it('dry-runs a Cloudflare deploy without credentials', async () => {
    const result = await deployToCloudflare({
      spec,
      code: 'export default {}',
      manifest: {},
      openapi: {},
      target: 'cloudflare',
      dryRun: true,
      env: { cloudflareApiToken: 'x', cloudflareAccountId: 'y' },
    });
    expect(result.provider).toBe('cloudflare');
    expect(result.status).toBe('pending');
    expect(result.logs?.length).toBeGreaterThan(0);
  });

  it('fails clearly without a Cloudflare token', async () => {
    await expect(
      deployToCloudflare({ spec, code: '', manifest: {}, openapi: {}, target: 'cloudflare', env: {} }),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  it('writes a local deployment to disk', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ar-'));

    const result = await deployLocal(
      { spec, code: 'export default {}', manifest: { a: 1 }, openapi: { b: 2 }, target: 'local' },
      { dir },
    );
    expect(result.provider).toBe('local');
    expect(JSON.parse(await readFile(join(dir, 'openapi.json'), 'utf8'))).toEqual({ b: 2 });
  });
});