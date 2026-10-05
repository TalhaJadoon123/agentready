/**
 * Marketing home page.
 *
 * Next.js App Router source. The same content is served by server.mjs for
 * zero-dependency local development — see packages/web/lib/content.mjs, which
 * both read from.
 */

import Link from 'next/link';
import { PILLARS, PRICING, FAQ, METRICS } from '../../lib/content.mjs';

export const metadata = {
  title: 'AgentReady — SEO for agents. Be found by AI.',
  description:
    'Score your website out of 100 for AI readability, generate an MCP server from your catalogue, and register it so assistants can find, quote and buy from you.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'AgentReady — SEO for agents',
    description: 'Make your website discoverable and consumable by AI agents.',
    type: 'website',
  },
};

const DEMO = `  Agent-Readiness Score: 82/100 (B)

  Pillar                      Score
  --------------------------  ------------------
  MCP server                  20/20  PASS
  Structured data (schema.org) 12/20  WARN
  Pricing transparency        13/14  PASS
  Agent-readable content      12/12  PASS
  Transactability              5/12  PASS
  Availability signals         8/10  PASS
  Machine authentication       7/7   PASS
  Rate limiting & docs         5/5   PASS`;

export default function HomePage() {
  return (
    <>
      <header className="nav">
        <div className="wrap">
          <Link className="logo" href="/">
            AgentReady
          </Link>
          <nav>
            <Link href="/#pillars">How it works</Link>
            <Link href="/#pricing">Pricing</Link>
            <Link href="/docs">Docs</Link>
            <Link className="btn" href="/dashboard">
              Dashboard
            </Link>
          </nav>
        </div>
      </header>

      <div className="wrap">
        <section className="hero">
          <span className="badge">Free tier — no card required</span>
          <h1>
            SEO for agents.
            <br />
            Be found by AI.
          </h1>
          <p className="sub">
            Score your website out of 100 for AI readability, generate an MCP server from your
            catalogue, and register it so assistants can actually find, quote and buy from you.
          </p>
          <div className="cta">
            <Link className="btn lg" href="/dashboard">
              Score my site free
            </Link>
            <Link className="btn lg ghost" href="/docs">
              See how it works
            </Link>
          </div>
        </section>
      </div>

      <section className="alt">
        <div className="wrap">
          <div className="metrics">
            {METRICS.map((m) => (
              <div className="metric" key={m.l}>
                <div className="n">{m.n}</div>
                <div className="l">{m.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pillars">
        <div className="wrap">
          <h2>Eight things AI agents check</h2>
          <p className="lead">
            Your score is the sum of eight weighted pillars. Each one is something a real
            assistant has to be able to do: read your prices, check your stock, authenticate,
            and place an order.
          </p>
          <div className="grid">
            {PILLARS.map((p) => (
              <div className="card" key={p.title}>
                <span className="pts">{p.pts} pts</span>
                <h3>{p.title}</h3>
                <p>{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="alt">
        <div className="wrap">
          <h2>One command, whole pipeline</h2>
          <p className="lead">
            Scan a site, turn a CSV into an MCP server, submit it to every public registry, and
            replay the queries a customer would ask an assistant.
          </p>
          <div className="demo">
            <span className="dim">$</span> agentready scan acme.com
            {'\n\n'}
            <span className="ok">{DEMO}</span>
          </div>
        </div>
      </section>

      <section id="pricing" className="alt">
        <div className="wrap">
          <h2>Pricing</h2>
          <p className="lead">Start free. Upgrade when you are generating servers daily.</p>
          <div className="pricing">
            {PRICING.map((p) => (
              <div className={p.featured ? 'plan featured' : 'plan'} key={p.name}>
                {p.featured && <span className="tag">Most popular</span>}
                <div className="name">{p.name}</div>
                <div className="price">
                  {p.price}
                  <small>{p.per}</small>
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 14 }}>{p.blurb}</div>
                <ul>
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <div style={{ marginTop: 22 }}>
                  <Link className={p.featured ? 'btn' : 'btn ghost'} href={p.ctaHref}>
                    {p.cta}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="faq">
        <div className="wrap">
          <h2>Questions</h2>
          <p className="lead">The things people ask before they trust a score from a stranger.</p>
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta-final">
        <div className="wrap">
          <h2>Find out what an agent sees when it looks at your site</h2>
          <p className="lead">One free scan. No card, no signup, no sales call.</p>
          <Link className="btn lg" href="/dashboard">
            Score my site
          </Link>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <div>
            <strong>AgentReady</strong> — SEO for agents. Be found by AI.
          </div>
          <div>
            <Link href="/docs">Documentation</Link> ·{' '}
            <Link href="/dashboard">Dashboard</Link> ·{' '}
            <a href="https://registry.modelcontextprotocol.io">MCP Registry</a>
          </div>
        </div>
      </footer>
    </>
  );
}