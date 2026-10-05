/**
 * Smoke test: prove the built scanner runs end to end against a fixture site
 * with a mocked fetch, and that the generated MCP worker answers JSON-RPC.
 */
import { scanSite, formatScanReport } from '../packages/core/dist/index.js';
import { buildSchema, validateSchema, injectIntoHtml } from '../packages/schema/dist/index.js';
import { generateMcpServer } from '../packages/mcp/dist/index.js';

const html = `<!doctype html><html lang="en"><head><title>Acme Store</title>
<meta name="description" content="We sell excellent widgets and gadgets for everyone.">
<link rel="canonical" href="https://acme.test/">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","name":"Acme","url":"https://acme.test"},
 {"@type":"Product","name":"Widget","description":"A widget","offers":{"@type":"Offer","price":"19.99","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
]}
</script></head>
<body><main><h1>Acme Store</h1><h2>Widgets</h2><p>We sell excellent widgets, priced at $19.99 and currently in stock, shipped from our warehouse with next day delivery available.</p></main>
<a href="/pricing">Pricing</a></body></html>`;

const routes = new Map([
  ['https://acme.test', { body: html, type: 'text/html' }],
  ['https://acme.test/robots.txt', { body: 'User-agent: *\nAllow: /\nSitemap: https://acme.test/sitemap.xml', type: 'text/plain' }],
  ['https://acme.test/sitemap.xml', { body: '<urlset><loc>https://acme.test/</loc></urlset>', type: 'application/xml' }],
  ['https://acme.test/llms.txt', { body: '# Acme\n\n> Widgets and gadgets. Rate limit: 60 requests/minute.', type: 'text/plain' }],
  ['https://acme.test/.well-known/openapi.json', { body: JSON.stringify({ openapi: '3.1.0', paths: { '/orders': {}, '/checkout': {} } }), type: 'application/json' }],
]);

const mockFetch = async (input) => {
  const u = typeof input === 'string' ? input : input.url;
  const hit = routes.get(u);
  if (!hit) return new Response('', { status: 404 });
  return new Response(hit.body, { status: 200, headers: { 'content-type': hit.type } });
};

// --- 1. scan -------------------------------------------------------------
const scan = await scanSite('acme.test', { fetch: mockFetch });
console.log('=== SCAN ===');
console.log('score:', scan.score, 'grade:', scan.grade);
console.log('checks:', scan.checks.map((c) => `${c.id}=${c.points}/${c.maxPoints}:${c.status}`).join(' '));
console.log('gaps:', scan.gaps.length, '| top fix:', scan.gaps[0]?.title?.slice(0, 70));
if (scan.score <= 0) throw new Error('scan returned 0');

// --- 2. schema -----------------------------------------------------------
const built = buildSchema({
  organization: { name: 'Acme', url: 'https://acme.test' },
  siteUrl: 'https://acme.test',
  products: [{ id: 'w1', name: 'Widget', description: 'A widget', price: 19.99, currency: 'USD', availability: 'InStock' }],
});
const validation = validateSchema(built.document);
console.log('\n=== SCHEMA ===');
console.log('nodes:', built.nodeCount, '| valid:', validation.valid, '| errors:', validation.errors, '| warnings:', validation.warnings);
if (!validation.valid) throw new Error('schema invalid: ' + JSON.stringify(validation.issues.slice(0, 3)));

const injected = injectIntoHtml('<html><head><title>x</title></head><body></body></html>', built.document);
const twice = injectIntoHtml(injected, built.document);
const count = (twice.match(/application\/ld\+json/g) || []).length;
console.log('inject idempotent (expect 1):', count);
if (count !== 1) throw new Error('injection not idempotent');

// --- 3. MCP server -------------------------------------------------------
const mcp = await generateMcpServer({
  name: 'acme-store',
  source: { kind: 'json', location: 'inline', mapping: {} },
  products: [
    { id: 'w1', name: 'Widget', description: 'A widget', price: 19.99, currency: 'USD', availability: 'InStock', sku: 'W-1', specs: { colour: 'red' } },
    { id: 'g1', name: 'Gadget', description: 'A gadget', price: 49.5, currency: 'USD', availability: 'OutOfStock' },
  ],
});
console.log('\n=== MCP ===');
console.log('tools:', mcp.toolNames.join(', '));
console.log('worker bytes:', mcp.code.length, '| manifest name:', mcp.manifest.name);
if (mcp.toolNames.length !== 5) throw new Error('expected 5 tools');

// Execute the generated worker exactly as Cloudflare would.
const mod = await import(`data:text/javascript,${encodeURIComponent(mcp.code)}`);
const worker = mod.default;
const rpc = async (method, params, id = 1) => {
  const res = await worker.fetch(new Request('https://acme-mcp.workers.dev/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }), {});
  return res.json();
};

const init = await rpc('initialize', {});
if (!init?.result) {
  console.log('initialize RAW:', JSON.stringify(init));
  console.log('--- worker source head ---');
  console.log(mcp.code.slice(0, 900));
  throw new Error('initialize did not return a result');
}
const tools = await rpc('tools/list');
console.log('initialize:', init.result.serverInfo.name, init.result.protocolVersion);
console.log('tools/list:', tools.result.tools.length, 'tools');

const search = await rpc('tools/call', { name: 'search_products', arguments: { query: 'widget' } }, 3);
console.log('search_products:', JSON.parse(search.result.content[0].text).products?.[0]?.name);

const price = await rpc('tools/call', { name: 'get_pricing', arguments: {} }, 4);
console.log('get_pricing range:', JSON.stringify(JSON.parse(price.result.content[0].text).price_range));

const avail = await rpc('tools/call', { name: 'check_availability', arguments: { ids: ['w1', 'g1'] } }, 5);
console.log('check_availability all_available:', JSON.parse(avail.result.content[0].text).all_available);

const order = await rpc('tools/call', { name: 'place_order', arguments: { items: [{ id: 'w1', quantity: 2 }], customer_email: 'a@b.com' } }, 6);
const orderData = JSON.parse(order.result.content[0].text);
console.log('place_order total:', orderData.formatted_total, '| status:', orderData.status);

// Error paths must not throw.
const badOrder = await rpc('tools/call', { name: 'place_order', arguments: { items: [{ id: 'g1', quantity: 1 }], customer_email: 'a@b.com' } }, 7);
console.log('out-of-stock order isError:', badOrder.result.isError === true);

const notFound = await rpc('tools/call', { name: 'nope', arguments: {} }, 8);
console.log('unknown tool -> rpc error code:', notFound.error?.code);

const health = await worker.fetch(new Request('https://acme-mcp.workers.dev/health'), {});
console.log('health:', JSON.stringify((await health.json())));

const disc = await worker.fetch(new Request('https://acme-mcp.workers.dev/.well-known/mcp.json'), {});
console.log('discovery manifest keys:', Object.keys(await disc.json()).length);

console.log('\nALL SMOKE CHECKS PASSED');