'use client';

/** MCP servers: list, status, tools, usage against the free-tier limit, revenue. */

import { useEffect, useState } from 'react';
import Link from 'next/link';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

type Server = {
  id: string;
  name: string;
  url: string;
  status: string;
  version: string;
  toolCount: number;
  rpcCalls: number;
  monthlyLimit: number;
};

export default function McpServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/dashboard`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = (await res.json()) as { mcpServers: Server[] };
        setServers(data.mcpServers ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not reach the API');
      }
    })();
  }, []);

  return (
    <div className="wrap">
      <section style={{ border: 0 }}>
        <h1>MCP servers</h1>
        <p className="lead">
          Generated servers, their tools, usage against the free-tier limit, and whether agents are
          actually calling them.
        </p>

        {error && (
          <div className="card" style={{ borderColor: 'var(--bad)', marginBottom: 20 }}>
            <h3 style={{ color: 'var(--bad)' }}>{error}</h3>
            <p style={{ marginTop: 10 }}>
              Start the API with <code>npm run dev:api</code>, then reload.
            </p>
          </div>
        )}

        {servers.length === 0 && !error && (
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <h3>No servers yet</h3>
            <p style={{ margin: '12px 0 20px', color: 'var(--muted)' }}>
              Generate one from a CSV, JSON file, API or a public catalogue page.
            </p>
            <div className="demo" style={{ textAlign: 'left' }}>
              agentready generate --source csv --file products.csv --name acme-store
              <br />
              agentready publish --target cloudflare
            </div>
          </div>
        )}

        <div className="grid">
          {servers.map((s) => {
            const used = Math.min(100, (s.rpcCalls / Math.max(1, s.monthlyLimit)) * 100);
            return (
              <div className="card" key={s.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px' }}>{s.name}</h3>
                    <div style={{ color: 'var(--muted)', fontSize: 12.5, fontFamily: 'ui-monospace, monospace' }}>{s.url}</div>
                  </div>
                  <span style={{ color: s.status === 'live' ? 'var(--good)' : 'var(--bad)', fontWeight: 700 }}>
                    {s.status.toUpperCase()}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 22, margin: '18px 0' }}>
                  <div>
                    <div style={{ fontSize: 21, fontWeight: 800 }}>{s.toolCount}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>tools</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 21, fontWeight: 800 }}>{s.rpcCalls}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>calls</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 21, fontWeight: 800 }}>{s.version}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>version</div>
                  </div>
                </div>

                <div style={{ height: 7, background: 'var(--bg)', borderRadius: 20, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${used}%`, background: used > 80 ? 'var(--bad)' : 'var(--accent)' }} />
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 7 }}>
                  {s.rpcCalls} of {s.monthlyLimit} monthly RPC calls used
                </div>
              </div>
            );
          })}
        </div>

        <div className="card" style={{ marginTop: 26 }}>
          <h3>Registering a server</h3>
          <p style={{ margin: '8px 0 14px', color: 'var(--muted)' }}>
            Submission makes a server discoverable. Dry-run first — the official registry is reviewed
            by hand.
          </p>
          <div className="demo">
            agentready register acme-store --url https://acme-store-mcp.workers.dev --dry-run
            <br />
            agentready register acme-store --url https://acme-store-mcp.workers.dev
          </div>
        </div>

        <p style={{ marginTop: 24 }}>
          <Link href="/dashboard">← Dashboard</Link> · <Link href="/scanner">Scan history →</Link>
        </p>
      </section>
    </div>
  );
}