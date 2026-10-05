/**
 * Marketing site — "SEO for agents. Be found by AI."
 *
 * Server-rendered by the zero-dependency Node server in server.mjs, which
 * reads from lib/content.mjs. The Next.js App Router source under app/ renders
 * the same content when you have Node available for a full build.
 */

import { PRICING, PILLARS, FAQ, METRICS } from './content.mjs';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const STYLES = `
:root{
  --bg:#0b0e14; --panel:#12161f; --panel2:#171c27; --fg:#e8ecf4; --muted:#9aa4b8;
  --line:#232a38; --accent:#5b9dff; --accent2:#3b7ddd; --good:#3fb950; --warn:#d29922; --bad:#f85149;
  --radius:12px; --max:1120px;
}
@media (prefers-color-scheme: light){
  :root{--bg:#ffffff;--panel:#f7f9fc;--panel2:#eef2f8;--fg:#0d1117;--muted:#5b6472;--line:#e2e6ee;--accent:#1c7ed6;--accent2:#1868b0;}
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:var(--panel2);padding:.15em .4em;border-radius:5px}
.wrap{max-width:var(--max);margin:0 auto;padding:0 20px}
header.nav{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:62px}
.logo{font-weight:700;letter-spacing:-.02em;font-size:18px;color:var(--fg)}
.nav nav{display:flex;gap:22px;align-items:center}
.nav nav a{color:var(--muted);font-size:14px}
.btn{display:inline-block;padding:9px 16px;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;font-size:14px;border:1px solid transparent}
.btn:hover{background:var(--accent2);text-decoration:none;color:#fff}
.btn.ghost{background:transparent;color:var(--fg);border-color:var(--line)}
.btn.lg{padding:13px 24px;font-size:16px}
.hero{padding:88px 0 64px;text-align:center;background:radial-gradient(1100px 400px at 50% -80px,color-mix(in srgb,var(--accent) 16%,transparent),transparent)}
.hero h1{font-size:clamp(34px,6vw,58px);line-height:1.08;margin:0 0 18px;letter-spacing:-.03em;font-weight:800}
.hero .sub{font-size:clamp(17px,2.2vw,21px);color:var(--muted);max-width:660px;margin:0 auto 30px}
.hero .cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.hero form{display:flex;gap:8px;justify-content:center;max-width:520px;margin:24px auto 0}
.hero input{flex:1;padding:12px 15px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font-size:15px}
section{padding:64px 0;border-top:1px solid var(--line)}
section.alt{background:var(--panel)}
h2{font-size:clamp(26px,3.4vw,36px);margin:0 0 12px;letter-spacing:-.02em;font-weight:750}
.lead{color:var(--muted);font-size:18px;margin:0 0 34px;max-width:640px}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(272px,1fr))}
.card{background:var(--panel2);border:1px solid var(--line);border-radius:var(--radius);padding:22px}
.card h3{margin:0 0 8px;font-size:17px;font-weight:650}
.card p{margin:0;color:var(--muted);font-size:14.5px}
.card .pts{display:inline-block;font-size:12px;font-weight:700;color:var(--accent);background:color-mix(in srgb,var(--accent) 15%,transparent);padding:3px 9px;border-radius:20px;margin-bottom:11px}
.metrics{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));text-align:center}
.metric{background:var(--panel2);border:1px solid var(--line);border-radius:var(--radius);padding:26px 16px}
.metric .n{font-size:32px;font-weight:800;letter-spacing:-.02em;color:var(--accent)}
.metric .l{color:var(--muted);font-size:13.5px;margin-top:4px}
.demo{background:var(--panel2);border:1px solid var(--line);border-radius:var(--radius);padding:22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;overflow-x:auto;line-height:1.7}
.demo .ok{color:var(--good)}.demo .warn{color:var(--warn)}.demo .bad{color:var(--bad)}.demo .dim{color:var(--muted)}
.pricing{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));align-items:start}
.plan{background:var(--panel2);border:1px solid var(--line);border-radius:var(--radius);padding:26px;position:relative}
.plan.featured{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.plan .tag{position:absolute;top:-11px;right:18px;background:var(--accent);color:#fff;font-size:11px;font-weight:700;padding:3px 11px;border-radius:20px;text-transform:uppercase;letter-spacing:.05em}
.plan .name{font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.plan .price{font-size:40px;font-weight:800;margin:8px 0 2px;letter-spacing:-.03em}
.plan .price small{font-size:15px;font-weight:500;color:var(--muted)}
.plan ul{list-style:none;padding:0;margin:20px 0 0;font-size:14.5px;color:var(--muted)}
.plan li{padding:7px 0;border-top:1px solid var(--line);display:flex;gap:9px}
.plan li::before{content:'✓';color:var(--good);font-weight:700;flex:none}
.faq details{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:16px 20px;margin-bottom:10px}
.faq summary{cursor:pointer;font-weight:620;font-size:15.5px;list-style:none}
.faq summary::-webkit-details-marker{display:none}
.faq summary::before{content:'+ ';color:var(--accent);font-weight:700}
.faq details[open] summary::before{content:'− '}
.faq p{margin:11px 0 0;color:var(--muted);font-size:14.5px}
.cta-final{text-align:center;padding:76px 0}
footer{border-top:1px solid var(--line);padding:34px 0;color:var(--muted);font-size:14px}
footer .wrap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--good);background:color-mix(in srgb,var(--good) 14%,transparent);padding:5px 11px;border-radius:20px;margin-bottom:18px}
.steps{counter-reset:s;display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.step{background:var(--panel2);border:1px solid var(--line);border-radius:var(--radius);padding:20px;counter-increment:s;position:relative}
.step::before{content:counter(s);display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:14px;margin-bottom:11px}
.step h3{margin:0 0 7px;font-size:16px}
.step p{margin:0;color:var(--muted);font-size:14px}
`;

function nav() {
  return `<header class="nav"><div class="wrap">
    <a class="logo" href="/">AgentReady</a>
    <nav>
      <a href="#pillars">How it works</a>
      <a href="#pricing">Pricing</a>
      <a href="/docs">Docs</a>
      <a class="btn" href="/dashboard">Dashboard</a>
    </nav>
  </div></header>`;
}

function footer() {
  return `<footer><div class="wrap">
    <div><strong>AgentReady</strong> — SEO for agents. Be found by AI.</div>
    <div>
      <a href="/docs">Documentation</a> ·
      <a href="/dashboard">Dashboard</a> ·
      <a href="https://registry.modelcontextprotocol.io">MCP Registry</a>
    </div>
  </div></footer>`;
}

export function renderPage({ path = '/', title, description, body, apiBase = '' } = {}) {
  const pageTitle = title ?? 'AgentReady — SEO for agents. Be found by AI.';
  const pageDescription = description ?? 'Make your website discoverable and consumable by AI agents. Score your site out of 100, generate an MCP server, and register it.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDescription)}">
<link rel="canonical" href="/">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDescription)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="text/plain" href="/llms.txt" title="Agent summary">
<link rel="stylesheet" href="/style.css">
<script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': '/#organization', name: 'AgentReady', url: '/' },
      { '@type': 'WebSite', '@id': '/#website', name: 'AgentReady', url: '/' },
      {
        '@type': 'SoftwareApplication',
        name: 'AgentReady',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web',
        description: pageDescription,
        offers: { '@type': 'AggregateOffer', lowPrice: '0.00', priceCurrency: 'USD', highPrice: '149.00', offerCount: 3 },
      },
      {
        '@type': 'FAQPage',
        mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
    ],
  }).replace(/<\//g, '<\\/')}
</script>
</head>
<body data-path="${esc(path)}" data-api="${esc(apiBase)}">
${nav()}
${body}
${footer()}
</body>
</html>`;
}

export function homePage(apiBase = '') {
  const demo = `<div class="demo"><span class="dim">$</span> agentready scan acme.com

  <span class="ok">Agent-Readiness Score: 82/100 (B)</span>

  Pillar                      Score
  --------------------------  ------------------
  MCP server                  <span class="ok">20/20  PASS</span>
  Structured data (schema.org) <span class="warn">12/20  WARN</span>
  Pricing transparency        <span class="ok">13/14  PASS</span>
  Agent-readable content      <span class="ok">12/12  PASS</span>
  Transactability             <span class="warn">5/12   PASS</span>
  Availability signals        <span class="ok">8/10   PASS</span>
  Machine authentication      <span class="ok">7/7    PASS</span>
  Rate limiting &amp; docs        <span class="ok">5/5    PASS</span>

  Top 2 fixes
  --------------------------
  <span class="warn">[MEDIUM]</span> Add JSON-LD Offer nodes for every product
  <span class="dim">      ~25 min</span>
  <span class="warn">[LOW]</span>   Publish /.well-known/mcp.json for auto-discovery
  <span class="dim">      ~10 min</span></div>`;

  return `<div class="wrap">
  <section class="hero">
    <span class="badge">Free tier — no card required</span>
    <h1>SEO for agents.<br>Be found by AI.</h1>
    <p class="sub">Score your website out of 100 for AI readability, generate an MCP server from your catalogue, and register it so assistants can actually find, quote and buy from you.</p>
    <div class="cta">
      <a class="btn lg" href="/dashboard">Score my site free</a>
      <a class="btn lg ghost" href="/docs">See how it works</a>
    </div>
    <form onsubmit="event.preventDefault();location.href='/dashboard?url='+encodeURIComponent(this.url.value)">
      <input name="url" type="text" placeholder="yourstore.com" aria-label="Your website URL" required>
      <button class="btn lg" type="submit">Check readiness</button>
    </form>
  </section>
</div>

<section alt="alt">
  <div class="wrap">
    <div class="metrics">
      ${METRICS.map((m) => `<div class="metric"><div class="n">${esc(m.n)}</div><div class="l">${esc(m.l)}</div></div>`).join('\n      ')}
    </div>
  </div>
</section>

<section id="pillars">
  <div class="wrap">
    <h2>Eight things AI agents check</h2>
    <p class="lead">Your score is the sum of eight weighted pillars. Each one is something a real assistant has to be able to do: read your prices, check your stock, authenticate, and place an order.</p>
    <div class="grid">
      ${PILLARS.map((p) => `<div class="card"><span class="pts">${esc(p.pts)} pts</span><h3>${esc(p.title)}</h3><p>${esc(p.desc)}</p></div>`).join('\n      ')}
    </div>
  </div>
</section>

<section class="alt">
  <div class="wrap">
    <h2>One command, whole pipeline</h2>
    <p class="lead">Scan a site, turn a CSV into an MCP server, submit it to every public registry, and replay the queries a customer would ask an assistant.</p>
    ${demo}
  </div>
</section>

<section id="how">
  <div class="wrap">
    <h2>How it works</h2>
    <p class="lead">Four steps. The free tier runs the first one once a month — enough to see your score and your highest-impact fix.</p>
    <div class="steps">
      <div class="step"><h3>Scan</h3><p>Fetch your homepage, robots.txt, sitemap, well-known paths and probe for a live MCP server. Score all eight pillars.</p></div>
      <div class="step"><h3>Generate</h3><p>Turn a CSV, JSON, API or scraped page into an MCP server with five commerce tools. Deploys to Cloudflare Workers free.</p></div>
      <div class="step"><h3>Register</h3><p>Submit to the Official MCP Registry, Smithery and mcp.so so assistants can discover your catalogue.</p></div>
      <div class="step"><h3>Simulate</h3><p>Replay the queries a customer would ask an assistant and see whether you get cited, and how you rank.</p></div>
    </div>
  </div>
</section>

<section id="pricing" class="alt">
  <div class="wrap">
    <h2>Pricing</h2>
    <p class="lead">Start free. Upgrade when you are generating servers and monitoring agents every day.</p>
    <div class="pricing">
      ${PRICING.map((p) => `<div class="plan${p.featured ? ' featured' : ''}">
        ${p.featured ? '<span class="tag">Most popular</span>' : ''}
        <div class="name">${esc(p.name)}</div>
        <div class="price">${esc(p.price)}<small>${esc(p.per)}</small></div>
        <div style="color:var(--muted);font-size:14px">${esc(p.blurb)}</div>
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div style="margin-top:22px"><a class="btn${p.featured ? '' : ' ghost'}" href="${p.ctaHref}">${esc(p.cta)}</a></div>
      </div>`).join('\n      ')}
    </div>
  </div>
</section>

<section class="faq">
  <div class="wrap">
    <h2>Questions</h2>
    <p class="lead">The things people ask before they trust a score from a stranger.</p>
    ${FAQ.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('\n    ')}
  </div>
</section>

<section class="cta-final">
  <div class="wrap">
    <h2>Find out what an agent sees when it looks at your site</h2>
    <p class="lead">One free scan. No card, no signup, no sales call.</p>
    <a class="btn lg" href="/dashboard">Score my site</a>
  </div>
</section>`;
}

export { STYLES };