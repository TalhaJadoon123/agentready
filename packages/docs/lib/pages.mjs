/**
 * Documentation pages.
 *
 * Written as plain data so the same content renders in the docs server and in
 * the Next.js docs route without duplicating prose.
 */

export const PAGES = [
  {
    slug: 'index',
    title: 'Introduction',
    body: `
<p>AgentReady makes a website discoverable and consumable by AI agents. It does four things:</p>
<ol>
  <li><strong>Scan</strong> — fetch a site, robots.txt, sitemap and the well-known agent surface, probe for a live MCP server, and score eight weighted pillars out of 100.</li>
  <li><strong>Generate</strong> — turn a CSV, JSON file, API or scraped page into a Model Context Protocol server with five commerce tools.</li>
  <li><strong>Publish</strong> — emit schema.org JSON-LD and <code>llms.txt</code>, with platform-specific instructions for WordPress, Shopify, Next.js and plain HTML.</li>
  <li><strong>Verify</strong> — replay the queries a customer would ask an assistant, and monitor uptime and registry listings.</li>
</ol>

<h3>Everything runs on free tiers</h3>
<p>The scanner, schema generator, MCP generator and registry clients need no API keys at all.
Optional keys unlock remote deploys, real agent simulation and email alerts — see
<a href="/docs/configuration">Configuration</a>.</p>

<h3>Try it in 30 seconds</h3>
<pre><code>npm install
npm run build
node packages/seed/src/seed.mjs        # demo site + full pipeline
node packages/api/dist/server.js       # API on :8787
node packages/web/server.mjs           # site on :3000</code></pre>
<p>Then scan the demo site, which is a reference implementation of a top-scoring store:</p>
<pre><code>node packages/cli/bin/agentready.mjs scan http://localhost:8790</code></pre>
`,
  },
  {
    slug: 'scoring',
    title: 'The readiness score',
    body: `
<p>The score is the sum of eight weighted pillars. Weights total 100. Each pillar is a capability an
assistant must have to serve you — which is why the score predicts agent traffic rather than
merely describing your markup.</p>

<table>
<thead><tr><th>Pillar</th><th>Points</th><th>What it measures</th></tr></thead>
<tbody>
<tr><td>MCP server</td><td>20</td><td>A live Model Context Protocol server, its liveness, and coverage of the five commerce tools.</td></tr>
<tr><td>Structured data</td><td>20</td><td>schema.org JSON-LD: Organization, Product/Service, Offer, price, currency, availability.</td></tr>
<tr><td>Pricing transparency</td><td>14</td><td>Public prices in structured data <em>and</em> visible text, plus a reachable pricing page.</td></tr>
<tr><td>Agent-readable content</td><td>12</td><td><code>/llms.txt</code>, server-rendered prose, question-shaped headings, canonical and meta.</td></tr>
<tr><td>Transactability</td><td>12</td><td>A documented order path — ideally a <code>place_order</code> MCP tool.</td></tr>
<tr><td>Availability signals</td><td>10</td><td>schema.org availability, stock language, and a site that actually serves agents.</td></tr>
<tr><td>Machine authentication</td><td>7</td><td>OAuth discovery (RFC 8414) with the <code>client_credentials</code> grant.</td></tr>
<tr><td>Rate limiting &amp; docs</td><td>5</td><td>Documented limits, <code>RateLimit-*</code> headers, OpenAPI, and a 429 contract.</td></tr>
</tbody>
</table>

<h3>Grades</h3>
<table>
<thead><tr><th>Score</th><th>Grade</th><th>What it means</th></tr></thead>
<tbody>
<tr><td>95–100</td><td>A+</td><td>Agents can find you, quote you and buy from you without a human.</td></tr>
<tr><td>85–94</td><td>A</td><td>Strong. Fix the last pillar or two and you are done.</td></tr>
<tr><td>70–84</td><td>B</td><td>Competitive. Something specific is still blocking you.</td></tr>
<tr><td>55–69</td><td>C</td><td>Present but not preferred.</td></tr>
<tr><td>40–54</td><td>D</td><td>Weak. Agents mention you rarely.</td></tr>
<tr><td>0–39</td><td>F</td><td>Invisible to agents.</td></tr>
</tbody>
</table>

<h3>Reading the result</h3>
<p>Each check returns its own points, the evidence it used, and copy-pasteable fixes. Gaps are
ranked by points at stake against estimated effort, so the first item on the list is almost always
the cheapest large improvement.</p>

<pre><code>agentready scan example.com --verbose</code></pre>
`,
  },
  {
    slug: 'mcp',
    title: 'MCP servers',
    body: `
<p>An MCP server turns your site from something an agent <em>reads</em> into something an agent
<em>acts on</em>. AgentReady generates one from a catalogue.</p>

<h3>The five tools</h3>
<table>
<thead><tr><th>Tool</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td><code>search_products</code></td><td>Free-text search over the catalogue with filters. Always the first call.</td></tr>
<tr><td><code>get_product</code></td><td>Full record by id or SKU, including specifications.</td></tr>
<tr><td><code>check_availability</code></td><td>Stock state for one or more products, before promising delivery.</td></tr>
<tr><td><code>get_pricing</code></td><td>Price for one product, or range and category bands for the catalogue.</td></tr>
<tr><td><code>place_order</code></td><td>Places an order and returns a payment link. The only path that closes the loop.</td></tr>
</tbody>
</table>

<h3>Data sources</h3>
<pre><code># CSV
agentready generate --source csv --file products.csv --name acme-store

# JSON
agentready generate --source json --file catalogue.json --name acme-store

# A live API
agentready generate --source api --api https://shop.example/api/products --name acme-store

# Scrape a public page (reads its table, or its JSON-LD)
agentready generate --source scrape --file https://shop.example/collections/all --name acme-store</code></pre>

<p>Columns are mapped automatically. Override when your headers differ:</p>
<pre><code>agentready generate --source csv --file p.csv --mapping name=Title,price=Cost,currency=Ccy</code></pre>

<h3>Deploying</h3>
<pre><code># Cloudflare Workers — free, 100k requests/day
agentready publish --target cloudflare

# Smithery — free, 25k RPC calls/month
agentready publish --target smithery

# Just write the files
agentready publish --target local</code></pre>

<p>The generated <code>worker.js</code> is a single self-contained file: no dependencies, no build
step, and an embedded catalogue, so there is no upstream to rate-limit you.</p>

<h3>Two manifests, two audiences</h3>
<p><code>server.json</code> is the Official MCP Registry publish format (<code>repository</code>,
<code>packages</code>, <code>remotes</code>). <code>mcp.json</code> is the
<code>.well-known/mcp.json</code> discovery document a client fetches to auto-connect
(<code>mcpServers</code>). They are not interchangeable — sending the discovery document to the
registry gets you rejected, which is why AgentReady emits both.</p>
`,
  },
  {
    slug: 'registries',
    title: 'Registries',
    body: `
<p>Three free registries, submitted from one command.</p>

<table>
<thead><tr><th>Registry</th><th>Free allowance</th><th>Auth</th></tr></thead>
<tbody>
<tr><td><a href="https://registry.modelcontextprotocol.io">Official MCP Registry</a></td><td>Free, MIT-licensed</td><td>Optional — PR-based without a token</td></tr>
<tr><td><a href="https://smithery.ai">Smithery</a></td><td>25,000 RPC calls/month</td><td>Required</td></tr>
<tr><td><a href="https://mcp.so">mcp.so</a></td><td>Free directory listing</td><td>Optional</td></tr>
</tbody>
</table>

<h3>Always dry-run first</h3>
<pre><code>agentready register acme-store --url https://acme-store-mcp.workers.dev --dry-run
agentready register acme-store --url https://acme-store-mcp.workers.dev</code></pre>

<p>Dry-run validates every manifest locally and shows exactly what would be submitted, without
touching a network. This matters: the official registry is reviewed by hand, and a rejected
submission costs days.</p>

<h3>The official registry is pull-request based</h3>
<p>With <code>MCP_REGISTRY_GITHUB_TOKEN</code> set, AgentReady forks, branches, commits and opens
the PR for you. Without it, you get the exact file path and the payload to paste — the registry is
intentionally accessible to unauthenticated contributors.</p>
`,
  },
  {
    slug: 'api',
    title: 'API reference',
    body: `
<p>Base URL in development: <code>http://localhost:8787</code>.</p>

<h3>POST /scan</h3>
<pre><code>curl -X POST http://localhost:8787/scan \\
  -H 'content-type: application/json' \\
  -d '{"url":"example.com"}'</code></pre>
<p>Returns <code>{ scan, scanId, graded }</code> where <code>scan</code> has <code>score</code>,
<code>grade</code>, all eight <code>checks</code>, prioritized <code>gaps</code> and
<code>recommendations</code>. Limited by plan: 1/month free, 50 Starter, 1,000 Business.
Exceeding it returns <code>402 quota_exceeded</code>.</p>

<h3>POST /generate/mcp</h3>
<pre><code>curl -X POST http://localhost:8787/generate/mcp \\
  -H 'content-type: application/json' \\
  -d '{
    "serverName": "acme-store",
    "source": {"kind":"json","location":"catalogue.json","mapping":{}},
    "products": [{"id":"a","name":"Widget","price":19.99,"currency":"USD","availability":"InStock"}],
    "includeCode": true
  }'</code></pre>
<p>Returns the tool list, a discovery <code>manifest</code>, a registry <code>registryManifest</code>,
an OpenAPI document, and — with <code>includeCode</code> — the worker source. Add
<code>"deploy": true</code> with <code>"target"</code> to deploy.</p>

<h3>POST /publish</h3>
<pre><code>curl -X POST http://localhost:8787/publish \\
  -H 'content-type: application/json' \\
  -d '{"url":"example.com","platform":"shopify","entities":{"products":[...]}}'</code></pre>
<p>Returns a validated JSON-LD graph, a paste-ready snippet, per-platform instructions and an
<code>llms.txt</code>.</p>

<h3>POST /register</h3>
<p>Submits to the registries. Supports <code>targets</code> and <code>dryRun</code>. Returns per
registry <code>submissions</code> with status and the logs needed to act on any rejection.</p>

<h3>POST /simulate</h3>
<p>Without <code>competitors</code>, replays queries against your site. With
<code>competitors</code>, returns a head-to-head ranking with win/loss queries.</p>

<h3>GET /verify</h3>
<pre><code>curl 'http://localhost:8787/verify?url=example.com'</code></pre>
<p>Public verification payload: score, grade, per-pillar status and top fixes.</p>

<h3>GET /monitor</h3>
<p><code>?url=</code> and <code>?server=</code>. Probes the site and the MCP discovery manifest
(not <code>/mcp</code>, which would open an SSE stream and look like a timeout), and reports
registry status.</p>

<h3>Errors</h3>
<pre><code>{"error":{"code":"quota_exceeded","message":"...","details":{...}}}</code></pre>
<p>Every error has a stable machine code: <code>invalid_url</code>, <code>invalid_request</code>,
<code>invalid_json</code>, <code>unauthorized</code>, <code>quota_exceeded</code>,
<code>not_found</code>, <code>deploy_failed</code>.</p>
`,
  },
  {
    slug: 'cli',
    title: 'CLI reference',
    body: `
<pre><code>agentready scan <url>            Score a site, print prioritized fixes
agentready generate            Build an MCP server from CSV/JSON/API/scrape
agentready publish <url>       Emit schema.org JSON-LD + llms.txt snippets
agentready register <name>     Submit to the MCP registries
agentready simulate <url>      Replay agent queries; rank vs competitors
agentready verify <url>        Uptime, registry status, health</code></pre>

<h3>Useful flags</h3>
<table>
<thead><tr><th>Flag</th><th>Meaning</th></tr></thead>
<tbody>
<tr><td><code>-v, --verbose</code></td><td>More detail, plus a progress line for <code>simulate</code>.</td></tr>
<tr><td><code>--json</code></td><td>Machine-readable output.</td></tr>
<tr><td><code>-o, --out &lt;file&gt;</code></td><td>Write the result to a file.</td></tr>
<tr><td><code>-c, --checks</code></td><td>Run a subset of pillars (cheap partial re-scan).</td></tr>
<tr><td><code>--dry-run</code></td><td>Validate and show intent without submitting.</td></tr>
</tbody>
</table>

<h3>Exit codes</h3>
<p><code>scan</code> and <code>verify</code> exit non-zero when the score or health is below
threshold, which makes them usable as CI gates:</p>
<pre><code>agentready scan example.com || echo "not agent-ready"</code></pre>

<h3>Install it globally</h3>
<pre><code>npm link --workspace @agentready/cli   # then: agentready scan example.com</code></pre>
`,
  },
  {
    slug: 'configuration',
    title: 'Configuration',
    body: `
<p>Copy <code>.env.example</code> to <code>.env</code>. Every value is optional: without any keys,
scanning, schema generation, MCP generation and registry dry-runs all work.</p>

<table>
<thead><tr><th>Variable</th><th>What it enables</th><th>Free tier</th></tr></thead>
<tbody>
<tr><td><code>GROQ_API_KEY</code></td><td>Real agent simulation and query generation</td><td>Yes — <a href="https://console.groq.com/keys">console.groq.com</a></td></tr>
<tr><td><code>CLOUDFLARE_API_TOKEN</code></td><td>Deploy MCP servers to Workers</td><td>100k requests/day</td></tr>
<tr><td><code>SMITHERY_API_KEY</code></td><td>Deploy and register on Smithery</td><td>25k RPC/month</td></tr>
<tr><td><code>MCP_REGISTRY_GITHUB_TOKEN</code></td><td>Automatic registry pull requests</td><td>Unlimited public repos</td></tr>
<tr><td><code>SUPABASE_URL</code> + <code>SUPABASE_SERVICE_ROLE_KEY</code></td><td>Hosted database instead of the JSON file</td><td>500MB / 50k rows</td></tr>
<tr><td><code>RESEND_API_KEY</code></td><td>Alert email</td><td>3,000 emails/month</td></tr>
<tr><td><code>AUTH_SECRET</code></td><td>Signs API bearer tokens</td><td>Free</td></tr>
</tbody>
</table>

<h3>Database</h3>
<p>By default AgentReady writes to <code>data/agentready.json</code> — no setup, no account. Set
<code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> to switch to Supabase. The
schema is in <code>packages/api/src/store.ts</code> (<code>SUPABASE_SCHEMA_SQL</code>) and includes
row-level security so a leaked anon key cannot read another tenant's scans.</p>
`,
  },
  {
    slug: 'deploy',
    title: 'Deployment',
    body: `
<h3>Cloudflare Workers (free)</h3>
<p>The API and the web server both run on Workers — the API is plain <code>node:http</code> with
zero dependencies, and the web server is plain ESM.</p>
<pre><code>npx wrangler deploy --config docker/wrangler.api.toml</code></pre>

<h3>Cloudflare Pages (free)</h3>
<p>Point a Pages project at the repository, build command <code>node packages/web/server.mjs</code>
is not a Pages build — use Workers instead, or serve <code>packages/web</code> as static output.
For the Next.js variant (<code>packages/web/app</code>) Pages handles the build natively.</p>

<h3>Docker</h3>
<pre><code>docker compose -f docker/docker-compose.yml up -d --build
open http://localhost:3000</code></pre>
<p>Three services: <code>api</code> (8787), <code>web</code> (3000) and <code>demo</code> (8790,
the reference store). Data persists in a named volume.</p>

<h3>Domain</h3>
<p>A free subdomain from EU.org, or <code>*.workers.dev</code> which Cloudflare issues
automatically for Workers. Point it at the Worker; the MCP endpoint and the public verify page then
live on a stable hostname.</p>
`,
  },
  {
    slug: 'architecture',
    title: 'Architecture',
    body: `
<table>
<thead><tr><th>Package</th><th>Responsibility</th></tr></thead>
<tbody>
<tr><td><code>shared</code></td><td>Types, config, logging, retry/rate-limit, URL and money helpers.</td></tr>
<tr><td><code>core</code></td><td>The scanner: fetch, parse, robots, sitemap, MCP probe, eight checks, scoring.</td></tr>
<tr><td><code>schema</code></td><td>schema.org generation, validation, and platform-specific injection.</td></tr>
<tr><td><code>mcp</code></td><td>Server generation, loaders, manifests, OpenAPI, Cloudflare/Smithery deploy.</td></tr>
<tr><td><code>registry</code></td><td>Submissions to the three registries, plus listing monitoring.</td></tr>
<tr><td><code>verify</code></td><td>Groq simulation, benchmarking, uptime monitoring, alerting.</td></tr>
<tr><td><code>api</code></td><td>HTTP layer, auth, quota, persistence (file or Supabase).</td></tr>
<tr><td><code>cli</code></td><td>Command surface over all of the above.</td></tr>
<tr><td><code>web</code></td><td>Marketing site, dashboard, docs.</td></tr>
<tr><td><code>seed</code></td><td>Demo store with a live MCP server, plus the end-to-end pipeline.</td></tr>
</tbody>
</table>

<h3>Design constraints</h3>
<ul>
<li><strong>Zero runtime dependencies</strong> in core, schema, mcp, registry, verify, api, cli and
web. Every integration runs on the built-in <code>fetch</code>, which is why the same code runs on
a laptop, in a container and on a Worker with no bundler.</li>
<li><strong>HTML is parsed with regex, not a DOM.</strong> A scan has to work inside a Worker, and
the output is treated as hints rather than a validated DOM.</li>
<li><strong>Degrade, never crash.</strong> A missing key, an unreachable registry or a failed
migration produces a clear message, not an exception.</li>
<li><strong>Simulation is labelled as simulation.</strong> No report claims to have measured live
ChatGPT traffic.</li>
</ul>
`,
  },
];

export const NAV = PAGES.map((p) => ({ slug: p.slug, title: p.title }));