/**
 * AgentReady web server.
 *
 * Zero dependencies: serves the marketing page, the app pages, the stylesheet,
 * /llms.txt and /.well-known/mcp.json (pointing at this site, because holding
 * ourselves to our own standard is the cheapest marketing there is).
 *
 *   node packages/web/server.mjs
 *   PORT=3000 API_BASE=http://localhost:8787 node packages/web/server.mjs
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderPage, homePage, STYLES } from './lib/pages.mjs';
import { dashboardPage, scannerPage, mcpServersPage } from './lib/app.mjs';
import { PILLARS, PRICING, FAQ, METRICS, SITE } from './lib/content.mjs';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const API_BASE = process.env.API_BASE ?? 'http://localhost:8787';
const ORIGIN = process.env.SITE_URL ?? `http://localhost:${PORT}`;

const here = dirname(fileURLToPath(import.meta.url));

const send = (res, body, status = 200, contentType = 'text/html; charset=utf-8', extra = {}) => {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': contentType, 'x-content-type-options': 'nosniff', ...extra });
  res.end(payload);
};

/** The agent-readable summary of this site. */
const LLMS_TXT = `# ${SITE.name}

> ${SITE.description}

Site: ${ORIGIN}

## What this is
${SITE.name} scores websites for AI-agent readiness and generates Model Context Protocol
servers so assistants can find, quote and buy from a business.

## Readiness pillars (100 points total)
${PILLARS.map((p) => `- ${p.title} (${p.pts} pts): ${p.desc}`).join('\n')}

## Pricing
${PRICING.map((p) => `- ${p.name}: ${p.price}${p.per.replace(' forever', '')}${p.per.includes('/mo') ? '/mo' : ''} — ${p.blurb}`).join('\n')}

## Free machine access
- API base URL: ${API_BASE}
- Health: GET ${API_BASE}/health
- Public verification page: ${ORIGIN}/verify?url=https://your-site.com

## API endpoints
- POST ${API_BASE}/scan — scan a site, returns score + 8 checks + prioritized fixes
- POST ${API_BASE}/generate/mcp — generate an MCP server from csv/json/api/scrape
- POST ${API_BASE}/publish — emit schema.org JSON-LD + llms.txt snippets
- POST ${API_BASE}/register — submit to the Official MCP Registry, Smithery, mcp.so
- POST ${API_BASE}/simulate — replay agent queries; rank against competitors
- GET  ${API_BASE}/verify?url= — public readiness verification
- GET  ${API_BASE}/monitor?url=&server= — uptime and registry health

## Rate limits
Public GET endpoints are unmetered in development. POST /scan is limited by plan:
1/month free, 50/month Starter ($49), 1,000/month Business ($149).

## Contact
${ORIGIN}/docs
`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  const path = url.pathname.replace(/\/$/, '') || '/';

  try {
    switch (path) {
      case '/':
        // homePage returns the body only; renderPage adds the document shell,
        // which is where the JSON-LD block lives.
        return send(res, renderPage({ path: '/', body: homePage(API_BASE) }));

      case '/style.css':
        return send(res, STYLES, 200, 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=3600' });

      case '/dashboard':
        return send(res, await dashboardPage({ apiBase: API_BASE, url: url.searchParams.get('url') ?? undefined }));

      case '/scanner':
        return send(res, await scannerPage({ apiBase: API_BASE, siteId: url.searchParams.get('site') ?? undefined }));

      case '/mcp-servers':
        return send(res, await mcpServersPage({ apiBase: API_BASE }));

      case '/llms.txt':
        return send(res, LLMS_TXT, 200, 'text/plain; charset=utf-8');

      case '/llms-full.txt': {
        const full = [...PILLARS, ...FAQ.map((f) => ({ title: f.q, desc: f.a })), ...PRICING.map((p) => ({ title: `${p.name} — ${p.price}`, desc: p.blurb }))]
          .map((s) => `## ${s.title}\n${s.desc}`).join('\n\n');
        return send(res, `${LLMS_TXT}\n---\n\n# Full reference\n\n${full}\n`, 200, 'text/plain; charset=utf-8');
      }

      case '/robots.txt':
        return send(res, `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, 200, 'text/plain; charset=utf-8');

      case '/sitemap.xml': {
        const paths = ['/', '/dashboard', '/scanner', '/mcp-servers'];
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths
          .map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`)
          .join('\n')}\n</urlset>`;
        return send(res, xml, 200, 'application/xml');
      }

      // We hold ourselves to the same standard we score others against.
      case '/.well-known/mcp.json':
        return send(res, {
          $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json',
          name: 'agentready-mcp',
          description: SITE.description,
          version: '1.0.0',
          mcpServers: { agentready: { type: 'http', url: `${API_BASE}/mcp` } },
          remotes: [{ type: 'streamable-http', url: `${API_BASE}/mcp` }],
        });

      case '/.well-known/agent.json':
        return send(res, { name: 'agentready', description: SITE.description, url: ORIGIN, api: `${API_BASE}/openapi.json` });

      case '/api':
        return send(res, { name: 'AgentReady web', apiBase: API_BASE, metrics: METRICS.length, pillars: PILLARS.length });

      case '/health':
        return send(res, { status: 'ok', service: 'web' }, 200, 'application/json');

      case '/favicon.ico':
        res.writeHead(204);
        return res.end();

      default:
        return send(
          res,
          renderPage({
            path,
            title: 'Not found — AgentReady',
            body: `<div class="wrap"><section style="border:0"><h1>404</h1><p class="lead">No such page. Try the <a href="/">homepage</a>, the <a href="/dashboard">dashboard</a>, or read <a href="/llms.txt">llms.txt</a>.</p></section></div>`,
          }),
          404,
        );
    }
  } catch (err) {
    // A page failure must not take the site down.
    send(res, { error: err instanceof Error ? err.message : String(err) }, 500, 'application/json');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AgentReady web:  ${ORIGIN}`);
  console.log(`API base:        ${API_BASE}`);
  console.log(`Pages:           / /dashboard /scanner /mcp-servers /llms.txt`);
});

export { server };