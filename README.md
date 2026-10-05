# AgentReady

**SEO for agents. Be found by AI.**

AgentReady makes a website discoverable and consumable by AI agents. It scans your site and scores
it out of 100 across eight weighted pillars, generates a Model Context Protocol server from your
catalogue, emits schema.org markup and `llms.txt`, submits the server to every public MCP registry,
and replays the queries a customer would ask an assistant to see whether you get cited.

Everything runs on free tiers. The core scanner, schema generator, MCP generator and registry
clients need **no API keys at all**.

---

## Table of contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Packages](#packages)
- [CLI](#cli)
- [API](#api)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Testing](#testing)
- [Manual steps checklist](#manual-steps-checklist)
- [Design notes](#design-notes)
- [Troubleshooting](#troubleshooting)

---

## Quick start

```bash
git clone https://github.com/TalhaJadoon123/agentready.git
cd agentready

# bun is the pinned package manager — bun.lock is the committed lockfile.
bun install --frozen-lockfile     # reproducible; `npm install` also works
npm run build
```

> **Package manager:** `bun.lock` is the committed lockfile. For a reproducible
> or CI install use `bun install --frozen-lockfile`. `npm ci` does **not** work
> — there is no `package-lock.json`, and npm's lockfile generator crashes on this
> workspace layout.

Run the demo — a reference e-commerce store with a live MCP server, plus the whole pipeline:

```bash
node packages/seed/src/seed.mjs
```

That boots the demo store on `:8790`, scans it, generates an MCP server, emits schema.org, dry-runs
every registry, and simulates agent queries. It prints something like:

```
  Agent-Readiness Score: 82/100 (B)
  http://localhost:8790

  Pillar                      Score
  --------------------------  ------------------
  MCP server                  20/20   PASS
  Pricing transparency        13/14   PASS
  Agent-readable content      12/12   PASS
  Machine authentication      7/7    PASS
```

Start the services:

```bash
node packages/api/dist/server.js     # API  on :8787
node packages/web/server.mjs         # Site on :3000
node packages/docs/server.mjs        # Docs on :3100
```

Or all of it at once, including the demo store:

```bash
npm run dev
```

### Desktop app

```bash
node packages/desktop/app.mjs
```

A standalone application window — no browser chrome, no address bar, its own
process. It boots the API and web server in-port and opens straight to the
dashboard.

It uses the browser already on your machine in `--app` mode rather than
bundling Electron, because Electron is a ~200MB download plus a build
toolchain, and this product's premise is that it runs with zero friction. You
still get a native app window — it just installs instantly.

| Flag | Effect |
|---|---|
| `--port 3400` | Use a different interface port (the API takes port+1) |
| `--headless` | Start the services without opening a window (for CI) |

Scan the demo store yourself:

```bash
node packages/cli/bin/agentready.mjs scan http://localhost:8790
```

Scan your own site:

```bash
node packages/cli/bin/agentready.mjs scan yourstore.com
```

### Requirements

- **Node.js 20.10+** (developed on 22)
- **npm** — or any package manager; workspaces are standard

There is no database, no Docker and no account required.

---

## What it does

### 1. Scan — score agent-readiness out of 100

The scanner fetches the homepage, `robots.txt`, the sitemap, and eleven well-known agent paths,
then probes for a live MCP server. Eight checks run against that single snapshot:

| Pillar | Points | Measures |
|---|---:|---|
| **MCP server** | 20 | A live Model Context Protocol server, its liveness, and coverage of the five commerce tools |
| **Structured data** | 20 | schema.org JSON-LD: Organization, Product/Service, Offer, price, currency, availability |
| **Pricing transparency** | 14 | Public prices in structured data *and* visible text, plus a reachable pricing page |
| **Agent-readable content** | 12 | `/llms.txt`, server-rendered prose, question-shaped headings, canonical and meta |
| **Transactability** | 12 | A documented order path — ideally a `place_order` MCP tool |
| **Availability signals** | 10 | schema.org availability, stock language, and a site that actually serves agents |
| **Machine authentication** | 7 | OAuth discovery (RFC 8414) with the `client_credentials` grant |
| **Rate limiting & docs** | 5 | Documented limits, `RateLimit-*` headers, OpenAPI, a 429 contract |

Every check returns its own points, the evidence it used, and copy-pasteable fixes. Gaps are ranked
by points at stake against estimated effort, so the first fix on the list is almost always the
cheapest large improvement.

### 2. Generate — an MCP server from your catalogue

Point it at a CSV, a JSON file, an API you control, or a public page, and it emits a single
self-contained JavaScript file implementing MCP over Streamable HTTP:

```bash
agentready generate --source csv --file products.csv --name acme-store
```

Five tools: `search_products`, `get_product`, `check_availability`, `get_pricing`, `place_order`.
No dependencies, no build step, and the catalogue is embedded — so there is no upstream to
rate-limit you.

### 3. Publish — schema.org and llms.txt

```bash
agentready publish acme.com --platform shopify --products products.json
```

Emits a validated JSON-LD graph and a paste-ready snippet, with per-platform instructions and the
warnings that actually bite (WordPress strips `<?php` from Custom HTML fields; Next.js has retired
`next/head`; Shopify validates Liquid at save time).

### 4. Register — the three public MCP registries

```bash
agentready register acme-store --url https://acme-store-mcp.workers.dev --dry-run
agentready register acme-store --url https://acme-store-mcp.workers.dev
```

**Always dry-run first.** Dry-run validates every manifest locally and shows exactly what would be
submitted without touching the network. The official registry is reviewed by hand, and a rejected
submission costs days.

### 5. Verify — will an agent find you?

```bash
agentready simulate acme.com --competitors rival.com,other.com
agentready verify acme.com --server https://acme-store-mcp.workers.dev
agentready enrich acme.com
```

`simulate` replays the queries a customer would ask an assistant and reports
win rate, average rank and answerability. **This is a simulation and every
report says so** — it is a good proxy for agent visibility, not a measurement of
live ChatGPT traffic.

`enrich` reports what an agent can learn about a domain *before* it fetches it,
using four free public sources that need no API key:

| Source | Reveals |
|---|---|
| [crt.sh](https://crt.sh) | Subdomains from certificate transparency — where your MCP server might live |
| Cloudflare DNS-over-HTTPS | A/AAAA/MX/TXT/NS records, and whether the domain resolves at all |
| [Wayback Machine](https://archive.org) | Whether the site has an established history |
| [RDAP](https://rdap.org) | Registrar, creation date, expiry |

All four degrade to `unavailable` when they cannot be reached. None of them can
fail a scan — they enrich it.

---

## Security

This product fetches URLs the caller supplies, so it takes that seriously.

### SSRF guard

The scanner refuses to fetch private infrastructure. Blocked by default:
loopback, RFC1918, link-local, CGNAT, IPv6 ULA, reserved ranges, and cloud
metadata endpoints (`169.254.169.254` and friends) — **metadata stays blocked
even when private ranges are allowed**, because it hands out credentials.

DNS is resolved and every returned address checked, so a public hostname that
resolves into a private range is rejected too. Redirects are followed manually
so each hop is re-validated — a public URL cannot 302 into the metadata
service.

```bash
AGENTREADY_ALLOW_PRIVATE_FETCH=false   # default
AGENTREADY_ALLOW_PRIVATE_FETCH=true    # self-hosted, or scanning localhost
```

### Authentication

The API refuses unauthenticated calls by default. An API token is
HMAC-SHA256 signed and compared in constant time; expired or tampered tokens are
rejected.

For local development only, `AGENTREADY_DEV_AUTH=true` permits unauthenticated
calls resolved to a **free-plan** user — so local testing hits the same limits
production does.

### Other hardening

- **Slug sanitization** — `serverSlug` is used in file paths and `spawn`
  arguments. It strips separators and shell metacharacters, refuses a leading
  dash (a child process would read it as a flag), and never returns an empty
  string.
- **JSON-LD escaping** — a `</script>` inside generated data is escaped, so a
  product named `</script><script>alert(1)` cannot break out of the block.
- **HTML escaping** — every user-controlled value in the dashboard is escaped.
- **Body limits** — request bodies and probe responses are size-capped.
- **Row-level security** — the Supabase schema includes RLS policies, so a
  leaked anon key cannot read another tenant's scans.
- **Secrets never echoed** — `/config` reports only which integrations are
  configured, never their values.

`packages/shared/test/security.test.ts` covers all of the above: 35 tests.

---

## Architecture

```
packages/
  shared/     types, config, logging, retry, rate limiting, URL and money helpers
  core/       the scanner: fetch, parse, robots, sitemap, MCP probe, 8 checks, scoring
  schema/     schema.org generation, validation, platform injection, llms.txt
  mcp/        server generation, data-source loaders, manifests, OpenAPI, deploy
  registry/   Official MCP Registry, Smithery, mcp.so + listing monitoring
  verify/     Groq simulation, benchmarking, uptime monitoring, alerting
  api/        HTTP layer, auth, quota, persistence (JSON file or Supabase)
  cli/        the command surface
  web/        marketing site, dashboard (Next.js source + zero-dep server)
  docs/       documentation site
  desktop/    standalone application window
  seed/       demo store with a live MCP server + end-to-end pipeline
```

Plus four zero-key public integrations — crt.sh, Cloudflare DNS-over-HTTPS, the
Wayback Machine and RDAP — used by `enrich` to report subdomain discovery, DNS
state, archive history and domain age. All degrade to `unavailable`, and none can
fail a scan.

Dependency direction is strictly one-way: `shared` → `core` → `schema` → `mcp` → `registry` →
`verify` → `api`/`cli`/`web`. Nothing imports upward.

---

## Packages

| Package | Runtime deps | Responsibility |
|---|---:|---|
| `@agentready/shared` | 0 | Types, config, logger, `withRetry`, `RateLimiter`, URL/money helpers |
| `@agentready/core` | 0 | Scanner and the eight pillars |
| `@agentready/schema` | 0 | JSON-LD generation, validation, injection |
| `@agentready/mcp` | 0 | Server generation, loaders, manifests, OpenAPI, Cloudflare/Smithery deploy |
| `@agentready/registry` | 0 | Three registry clients + status monitoring |
| `@agentready/verify` | 0 | Groq simulation, benchmarking, uptime, alerts |
| `@agentready/api` | 0 | Fastify-shaped HTTP layer, auth, quota, store |
| `@agentready/cli` | 0 | `agentready scan\|generate\|publish\|register\|simulate\|verify` |
| `@agentready/web` | 0 | Marketing + dashboard |
| `@agentready/seed` | 0 | Demo store with a live MCP server |

**Every runtime dependency count is zero.** Only `typescript` and `vitest` are needed, and only to
build and test.

---

## CLI

```bash
# Score a site
agentready scan example.com

# Build an MCP server from a CSV and deploy it to Cloudflare Workers
agentready generate --source csv --file products.csv --name acme-store --deploy --target cloudflare

# Emit schema.org for Shopify
agentready publish acme.com --platform shopify --products products.json

# Register everywhere (dry run first!)
agentready register acme-store --url https://acme-store-mcp.workers.dev --dry-run
agentready register acme-store --url https://acme-store-mcp.workers.dev

# Benchmark against two competitors
agentready simulate acme.com --competitors rival.com,other.com

# Uptime + registry health
agentready verify acme.com --server https://acme-store-mcp.workers.dev
```

Install it globally:

```bash
npm link --workspace @agentready/cli
agentready scan example.com
```

Without linking:

```bash
node packages/cli/bin/agentready.mjs scan example.com
```

`scan` and `verify` exit non-zero below threshold, so they work as CI gates:

```bash
agentready scan example.com || echo "not agent-ready"
```

---

## API

```bash
node packages/api/dist/server.js     # :8787
```

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/scan` | Scan a site → score, 8 checks, prioritized fixes |
| `POST` | `/generate/mcp` | Generate an MCP server from csv/json/api/scrape |
| `POST` | `/publish` | schema.org JSON-LD + `llms.txt` snippets |
| `POST` | `/register` | Submit to Official MCP Registry, Smithery, mcp.so |
| `POST` | `/simulate` | Replay agent queries; rank vs competitors |
| `GET` | `/verify?url=` | Public readiness verification |
| `GET` | `/enrich?url=` | Domain intelligence from four free public APIs |
| `GET` | `/monitor?url=&server=` | Uptime + registry health |
| `GET` | `/health` `/config` `/quota` | Meta |

```bash
curl -X POST http://localhost:8787/scan \
  -H 'content-type: application/json' \
  -d '{"url":"example.com"}'
```

Errors carry a stable machine code:

```json
{ "error": { "code": "quota_exceeded", "message": "1/1 scans used this month.", "details": {} } }
```

---

## Configuration

Copy `.env.example` to `.env`. **Everything is optional** — with no keys at all, scanning, schema
generation, MCP generation and registry dry-runs all work.

| Variable | Enables | Free tier |
|---|---|---|
| `GROQ_API_KEY` | Real agent simulation + query generation | [console.groq.com/keys](https://console.groq.com/keys) |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Deploy MCP servers to Workers | 100k requests/day |
| `SMITHERY_API_KEY` | Deploy + register on Smithery | 25k RPC/month |
| `MCP_REGISTRY_GITHUB_TOKEN` | Automatic registry pull requests | Unlimited public repos |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Hosted database instead of the JSON file | 500MB / 50k rows |
| `RESEND_API_KEY` | Alert email | 3,000 emails/month |
| `AUTH_SECRET` | Signs API bearer tokens | Free |

Without `GROQ_API_KEY`, simulation runs in **deterministic mode**: it scores answerability from
your site's own structure and labels the report accordingly. It does not guess rankings.

### Database

Default is `data/agentready.json` — a JSON file, no setup, no account. Set the Supabase variables
to switch. The schema (including row-level security, so a leaked anon key cannot read another
tenant's scans) is in `packages/api/src/store.ts` as `SUPABASE_SCHEMA_SQL`.

---

## Deployment

### Docker

```bash
docker compose -f docker/docker-compose.yml up -d --build
open http://localhost:3000
```

Three services: `api` (:8787), `web` (:3000), and `demo` (:8790, the reference store). Data
persists in a named volume.

### Cloudflare Workers (free)

The API is plain `node:http` with zero dependencies and the web server is plain ESM, so both run on
Workers unchanged.

```bash
npx wrangler deploy --config docker/wrangler.api.toml
```

### Cloudflare Pages (free)

For the Next.js variant in `packages/web/app`, Pages handles the build natively. Set
`NEXT_PUBLIC_API_URL` to your deployed API.

### Domain

- `*.workers.dev` — Cloudflare issues one automatically for Workers
- **EU.org** — free subdomains, DNS-validated; add to Cloudflare or wherever you host

---

## Testing

```bash
npm test                              # 299 tests
npm test -- --coverage
```

The suite covers:

- **12 fixture websites** — bare, WordPress, Shopify, gated-pricing, API-first, robots-blocked,
  JS-only SPA, thin content, local business, erroring, broken markup, and a reference implementation
- **The scanner** against every fixture, asserting each lands in its score band — and that the
  reference site outranks all others
- **Security** — SSRF classification, redirect hops, DNS rebinding, auth bypass, token forgery,
  slug sanitization, JSON-LD breakout, quota evasion
- **Mock MCP registries** covering the Official Registry, Smithery and mcp.so, including
  publisher-API success, 409 conflict, 404 and unreachable paths
- **Free public API integrations**, mocked — including "every source is down" and
  "one source throws while the others succeed"
- **The generated worker**, imported and executed as a real module: `initialize`, `tools/list`,
  `tools/call`, notification handling, unknown tools, health, discovery manifest, CORS
- **The API**, booted on an ephemeral port and driven over HTTP
- **Auth and quota**, including token tampering, expiry and free-tier enforcement

Plus standalone smoke scripts:

```bash
node scripts/smoke.mjs          # engine: scan + schema + generated worker
node scripts/smoke-api.mjs      # API over HTTP
node scripts/smoke-stack.mjs    # demo + api + web together
```

---

## Manual steps checklist

Work top to bottom — each step unlocks the next.

### To score your own site (no keys needed)

- [ ] `npm install && npm run build`
- [ ] `agentready scan yoursite.com`
- [ ] Work the gap list, highest severity first

### To publish an MCP server (Cloudflare — free)

- [ ] Create a Cloudflare account at [dash.cloudflare.com](https://dash.cloudflare.com)
- [ ] **Settings → API Tokens → Create Token → Edit Cloudflare Workers**
- [ ] Copy the account ID from the dashboard sidebar (or run `npx wrangler whoami`)
- [ ] Put both in `.env`:
      ```bash
      CLOUDFLARE_API_TOKEN=your_token
      CLOUDFLARE_ACCOUNT_ID=your_account_id
      CLOUDFLARE_WORKERS_SUBDOMAIN=your-subdomain
      ```
- [ ] `agentready generate --source csv --file products.csv --name yourstore`
- [ ] `agentready publish --target cloudflare`
- [ ] Confirm the health endpoint returns `{"status":"ok"}`
- [ ] Verify discovery: `curl https://<script>.workers.dev/.well-known/mcp.json`

### To submit to the Official MCP Registry (free)

- [ ] **Dry-run first:** `agentready register yourstore --url https://… --dry-run`
- [ ] Confirm all three report `dry-run`, not `rejected`
- [ ] **Optionally** create a GitHub token with `public_repo` scope → `MCP_REGISTRY_GITHUB_TOKEN`
- [ ] Without a token: fork `modelcontextprotocol/registry`, add your file at
      `servers/<name>/<version>/server.json`, open a PR. AgentReady prints the exact path and payload.
- [ ] Expect a human review — typically 24–48h

### To enable real agent simulation (free)

- [ ] Sign up at [console.groq.com](https://console.groq.com/keys)
- [ ] Create an API key → `GROQ_API_KEY`
- [ ] `agentready simulate yoursite.com --competitors rival.com`

### To enable hosted database (free)

- [ ] Create a project at [supabase.com](https://supabase.com)
- [ ] **Project Settings → API** → copy URL and `service_role` key
- [ ] Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Run the SQL in `SUPABASE_SCHEMA_SQL` (`packages/api/src/store.ts`) in the SQL editor
- [ ] Set `AUTO_MIGRATE=false` unless you have created the `exec_sql` helper function
- [ ] Restart the API

### To enable email alerts (free)

- [ ] Verify a domain at [resend.com](https://resend.com) → `RESEND_API_KEY`
- [ ] Set `EMAIL_PROVIDER=resend` and `ALERT_EMAIL=you@example.com`

### To go live

- [ ] Deploy the web app (`docker compose` or Workers)
- [ ] Set `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_API_URL`
- [ ] Serve the site's own `/llms.txt` and `/.well-known/mcp.json` — you are holding others to
      this standard; hold yourself to it too

---

## Design notes

A few decisions worth explaining, because they are the difference between this working and not.

**Zero runtime dependencies.** Everything runs on the built-in `fetch`. This is why the same code
runs on a laptop, in a container, and on a Cloudflare Worker with no bundler — and why `npm install`
takes seconds instead of minutes. Dev dependencies are only `typescript` and `vitest`.

**The API is Fastify-shaped, not Fastify.** It exposes `app.get/post`, `reply.send()`,
`reply.code()`, `addHook`, and a `setNotFoundHandler`, all over `node:http`. Swapping in real Fastify
later is a one-file change, and every route handler stays as it is.

**HTML is parsed with regex, not a DOM.** Adding jsdom would mean the scanner could not run in a
Worker. The extractors are good enough for the signals being scored, and consumers treat the output
as hints rather than a validated DOM.

**Prices are read from nested `offers` blocks.** schema.org puts a Product's price inside
`offers.price`, not at the top level. Reading only the top level misses the common case and
under-reports good sites. `collectOfferNodes` walks into nested offers, aggregate offers and
`priceSpecification`.

**Two manifests, two audiences.** `server.json` is the Official MCP Registry publish format
(`repository`, `packages`, `remotes`). `mcp.json` is the `.well-known/mcp.json` discovery document
(`mcpServers`). They are not interchangeable — sending the discovery document to the registry gets
you rejected. AgentReady emits both.

**MCP health checks probe `/.well-known/mcp.json`, never `/mcp`.** A `GET` on `/mcp` opens an SSE
stream, which every monitor reads as a timeout. The discovery manifest is a small JSON document that
only exists if the server is up.

**`/mcp` endpoints are never double-suffixed.** If you pass `https://x.workers.dev/mcp` as the
public URL, `mcpEndpoint()` returns it unchanged rather than appending a second `/mcp`.

**Simulation is labelled as simulation.** Reports state the model used, and without a Groq key they
say `deterministic (no GROQ_API_KEY)` and estimate answerability from site structure rather than
inventing rankings. A monitoring tool that cries wolf trains people to ignore it.

**Snippets are idempotent.** `injectIntoHtml` will not produce two script blocks if run twice —
most people paste a snippet into a header field *and* a theme file.

---

## Troubleshooting

**`ECONNREFUSED` / `fetch failed`**
The URL is unreachable, or the server is not running. Try `curl <url>` directly. Sites that block
unknown user agents will fail — AgentReady identifies itself honestly in the `User-Agent`.

**`quota_exceeded`**
The free plan allows 1 scan per month. The counters reset on the first of the month.

**Score is low on a site that looks good**
Run with `--verbose` and read the per-check evidence. Common causes: prices only in JavaScript,
content that requires client-side rendering, or an `llms.txt` that does not exist.

**MCP deploy reports `status: pending`**
The upload succeeded but the health check did not answer in time. Check the URL manually with
`curl https://<script>.workers.dev/health`.

**Registry submission is `rejected`**
Read `logs` in the response — the local validator names the exact failing rule. The most common
cause is sending the discovery document instead of `server.json`.

**Tests fail on `fetch`**
Nothing should touch the network. Every test injects a fetch implementation. If one reaches the real
network, it is a bug in that test.

---

## License

MIT.