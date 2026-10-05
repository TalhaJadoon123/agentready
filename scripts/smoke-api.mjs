/**
 * API integration test: boots the real server on an ephemeral port and drives
 * it with fetch, exactly as a client would.
 */
import { buildServer } from '../packages/api/dist/server.js';

const server = await buildServer({ devMode: true, forceFile: true, dbPath: './data/smoke-api.json' });
const { url, close } = await server.app.listen(0);
console.log('listening on', url);

const get = async (p, init) => {
  const res = await fetch(`${url}${p}`, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const post = (p, data) => get(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

// 1. health
let r = await get('/health');
check('GET /health -> 200', r.status === 200, `store=${r.body.store}`);
check('health reports ok', r.body.status === 'ok');

// 2. index lists endpoints
r = await get('/');
check('GET / lists 7 endpoints', r.body.endpoints?.length === 7, r.body.endpoints?.join(' '));

// 3. config reports integrations
r = await get('/config');
check('GET /config -> integration flags', typeof r.body.integrations?.groq === 'boolean');

// 4. validation: bad URL rejected
r = await post('/scan', { url: 'not a url' });
check('POST /scan rejects bad url', r.status === 400 && r.body.error?.code === 'invalid_url', `got ${r.status}`);

// 5. validation: missing field
r = await post('/scan', {});
check('POST /scan requires url', r.status === 400 && r.body.error?.code === 'invalid_request');

// 6. 404 shape
r = await get('/nope');
check('unknown route -> 404 not_found', r.status === 404 && r.body.error?.code === 'not_found');

// 7. generate/mcp from inline products
r = await post('/generate/mcp', {
  serverName: 'test-store',
  source: { kind: 'json', location: 'inline', mapping: {} },
  products: [
    { id: 'a', name: 'Alpha', price: 10, currency: 'USD', availability: 'InStock', description: 'First item' },
    { id: 'b', name: 'Beta', price: 25.5, currency: 'USD', availability: 'OutOfStock', description: 'Second item' },
  ],
});
check('POST /generate/mcp -> 200', r.status === 200, `status=${r.status} ${r.body?.error?.message ?? ''}`);
check('generate returns 5 tools', r.body?.tools?.length === 5, r.body?.tools?.join(','));
check('generate counted 2 products', r.body?.productCount === 2);
check('generate returns a manifest', typeof r.body?.manifest?.name === 'string', r.body?.manifest?.name);

// 8. generate/mcp bad source kind
r = await post('/generate/mcp', { serverName: 'x', source: { kind: 'ftp', location: 'x' } });
check('rejects unknown source kind', r.status === 400 && r.body.error?.code === 'invalid_source');

// 9. publish produces schema + snippet + llms.txt
r = await post('/publish', {
  url: 'https://shop.example',
  platform: 'next',
  entities: {
    organization: { name: 'Shop', url: 'https://shop.example', description: 'A shop' },
    products: [{ id: 'a', name: 'Alpha', price: 10, currency: 'USD', availability: 'InStock', description: 'x' }],
  },
});
check('POST /publish -> 200', r.status === 200, r.body?.error?.message ?? '');
check('publish schema is valid', r.body?.schema?.validation?.valid === true);
check('publish includes <script> snippet', String(r.body?.snippet).includes('application/ld+json'));
check('publish includes instructions', Array.isArray(r.body?.instructions) && r.body.instructions.length > 0);
check('publish emits llms.txt', String(r.body?.llmsTxt).includes('# Shop'));

// 10. register dry-run
r = await post('/register', {
  serverName: 'test-store',
  serverUrl: 'https://test-store-mcp.workers.dev',
  targets: ['official'],
  dryRun: true,
});
check('POST /register dry-run -> 200', r.status === 200, r.body?.error?.message ?? '');
check('register dry-run reports official', r.body?.submissions?.[0]?.registry === 'official');
check('register dry-run does not claim live', r.body?.summary?.live?.length === 0);

// 11. sites CRUD
r = await post('/sites', { url: 'https://shop.example', name: 'Shop' });
check('POST /sites -> creates', r.status === 200 && Boolean(r.body.id), r.body?.id);
const siteId = r.body.id;
r = await get('/sites');
check('GET /sites lists the site', Array.isArray(r.body) && r.body.some((s) => s.id === siteId));
r = await get(`/sites/${siteId}/scans`);
check('GET /sites/:id/scans -> array', Array.isArray(r.body));

// 12. quota
r = await get('/quota');
check('GET /quota reports a plan limit', typeof r.body.limit === 'number', `plan=${r.body.plan} limit=${r.body.limit}`);

// 13. monitor validation
r = await get('/monitor');
check('GET /monitor requires a target', r.status === 400);

// 14. verify requires url
r = await get('/verify');
check('GET /verify requires ?url', r.status === 400);

// 15. dashboard
r = await get('/dashboard');
check('GET /dashboard aggregates', r.status === 200 && typeof r.body.score === 'number', `score=${r.body.score}`);

// 16. method not allowed surfaces as 404 (no route match)
r = await get('/health', { method: 'DELETE' });
check('wrong method -> 404', r.status === 404);

// 17. malformed JSON body
r = await get('/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
check('malformed JSON -> 400 invalid_json', r.status === 400 && r.body.error?.code === 'invalid_json', `got ${r.status}`);

// 18. CORS preflight
r = await get('/scan', { method: 'OPTIONS' });
check('OPTIONS returns CORS headers', r.status === 204, `status=${r.status} allow-origin=${r.headers.get('access-control-allow-origin')}`);

await close();
console.log(failures === 0 ? '\nALL API CHECKS PASSED' : `\n${failures} API CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);