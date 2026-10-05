/**
 * AgentReady docs server.
 *
 * Serves /docs on the main web server too; this is a standalone instance for
 * running docs on their own port (useful in Docker, or when web is deployed
 * separately).
 */

import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { PAGES, NAV } from './lib/pages.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Resolve the web package's styles relative to this file, not the cwd, so the
// docs server works from any directory and in Docker. pathToFileURL is
// required on Windows — a bare absolute path is not a valid ESM specifier.
const { STYLES } = await import(pathToFileURL(join(here, '..', 'web', 'lib', 'pages.mjs')).href);

const PORT = Number(process.env.DOCS_PORT ?? 3100);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function shell(current, content) {
  const items = NAV.map((p) => {
    const active = p.slug === current ? ' style="color:var(--accent);font-weight:600"' : '';
    return `<a href="/docs/${p.slug === 'index' ? '' : p.slug}"${active}>${esc(p.title)}</a>`;
  }).join('\n      ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(content.title)} — AgentReady docs</title>
<meta name="description" content="AgentReady documentation: agent-readiness scoring, MCP server generation, registry submission, API and CLI reference.">
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="text/plain" href="/llms.txt" title="Agent summary">
</head>
<body>
<header class="nav"><div class="wrap">
  <a class="logo" href="/">AgentReady</a>
  <nav><a href="/">Home</a><a href="/dashboard">Dashboard</a><a class="btn" href="/docs">Docs</a></nav>
</div></header>
<div class="wrap" style="display:grid;grid-template-columns:230px 1fr;gap:38px;padding:34px 20px 60px;align-items:start">
  <aside style="position:sticky;top:80px;font-size:14.5px;display:flex;flex-direction:column;gap:9px">
      ${items}
  </aside>
  <main style="max-width:820px">
    <h1>${esc(content.title)}</h1>
    ${content.body}
    <hr style="border:none;border-top:1px solid var(--line);margin:44px 0 22px">
    <p style="color:var(--muted);font-size:14px">Something missing or wrong? Open an issue — the docs live in <code>packages/docs/lib/pages.mjs</code>.</p>
  </main>
</div>
<footer><div class="wrap"><div><strong>AgentReady</strong> documentation</div><div><a href="/llms.txt">llms.txt</a> · <a href="/">Home</a></div></div></footer>
</body></html>`;
}

const LLMS = `# AgentReady documentation

> SEO for agents. Make your website discoverable and consumable by AI agents.

Site: ${process.env.SITE_URL ?? `http://localhost:${PORT}`}

## Pages
${NAV.map((p) => `- ${p.title}: /docs/${p.slug === 'index' ? '' : p.slug}`).join('\n')}

${PAGES.map((p) => `## ${p.title}\n${p.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`).join('\n\n')}
`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/$/, '') || '/';

  const send = (body, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  if (path === '/style.css') return send(STYLES, 200, 'text/css; charset=utf-8');
  if (path === '/llms.txt') return send(LLMS, 200, 'text/plain; charset=utf-8');
  if (path === '/health') return send(JSON.stringify({ status: 'ok', pages: PAGES.length }), 200, 'application/json');

  if (path === '/docs' || path === '/docs/' || path === '/docs/index') {
    return send(shell('index', PAGES[0]));
  }

  if (path.startsWith('/docs/')) {
    const slug = path.slice('/docs/'.length);
    const page = PAGES.find((p) => p.slug === slug);
    if (page) return send(shell(slug, page));
  }

  // The docs site is a single page per slug; everything else redirects home.
  return send(shell('index', PAGES[0]));
});

server.listen(PORT, () => {
  console.log(`AgentReady docs: http://localhost:${PORT}/docs`);
});