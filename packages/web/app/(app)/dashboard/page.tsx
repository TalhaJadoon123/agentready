'use client';

/**
 * Dashboard: agent-readiness score, MCP status, agent traffic, revenue.
 *
 * Auth.js owns the session; this page fetches from the AgentReady API with the
 * session's bearer token. It renders an explicit "API not running" state rather
 * than fabricating numbers.
 */

import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

type Check = { id: string; title: string; status: string; points: number; maxPoints: number };
type Gap = { title: string; severity: string; effortMinutes: number; patch?: string };
type Scan = { url: string; score: number; grade: string; checks: Check[]; gaps: Gap[]; recommendations?: string[] };
type Server = { id: string; name: string; url: string; status: string; toolCount: number; rpcCalls: number; monthlyLimit: number };
type Quota = { plan: string; used: number; limit: number; reason?: string };

export default function DashboardPage() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`${API}/dashboard`);
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      const data = (await res.json()) as {
        score: number;
        quota: Quota;
        mcpServers: Server[];
        rpcCalls: number;
        mcpToolCount: number;
      };
      setServers(data.mcpServers ?? []);
      setQuota(data.quota ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the API');
    }
  }

  async function runScan(target: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      setScan(data.scan);
      setUrl(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const ring = scan ? (scan.score >= 85 ? 'var(--good)' : scan.score >= 70 ? 'var(--accent)' : scan.score >= 40 ? 'var(--warn)' : 'var(--bad)') : 'var(--muted)';

  return (
    <div className="wrap">
      <section style={{ border: 0 }}>
        <h1>Dashboard</h1>

        <div style={{ display: 'flex', gap: 10, marginBottom: 24, maxWidth: 520 }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="yourstore.com"
            style={{ flex: 1, padding: '12px 15px', borderRadius: 9, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--fg)' }}
          />
          <button className="btn lg" onClick={() => void runScan(url)} disabled={loading}>
            {loading ? 'Scanning…' : 'Scan'}
          </button>
        </div>

        {error && (
          <div className="card" style={{ borderColor: 'var(--bad)', marginBottom: 20 }}>
            <h3 style={{ color: 'var(--bad)' }}>{error}</h3>
            <p style={{ marginTop: 10 }}>
              Start the API with <code>npm run dev:api</code>. Free tier allows 1 scan per month.
            </p>
          </div>
        )}

        {scan && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
              <div
                style={{
                  width: 118,
                  height: 118,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  background: `conic-gradient(${ring} ${scan.score * 3.6}deg, var(--panel) 0deg)`,
                }}
              >
                <div style={{ width: 92, height: 92, borderRadius: '50%', background: 'var(--bg)', display: 'grid', placeItems: 'center', textAlign: center }}>
                  <div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: ring }}>{scan.score}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>of 100</div>
                  </div>
                </div>
              </div>
              <div>
                <h2 style={{ margin: '0 0 6px' }}>{scan.grade}</h2>
                <p style={{ margin: 0, color: 'var(--muted)' }}>{scan.url}</p>
              </div>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
              <tbody>
                {scan.checks.map((c) => (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ padding: '10px 0' }}>{c.title}</td>
                    <td style={{ padding: '10px 0', fontFamily: 'ui-monospace, monospace' }}>
                      {c.points}/{c.maxPoints}
                    </td>
                    <td style={{ padding: '10px 0' }}>
                      <span style={{ color: c.status === 'pass' ? 'var(--good)' : c.status === 'warn' ? 'var(--warn)' : 'var(--bad)' }}>
                        {c.status.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid" style={{ marginBottom: 20 }}>
          <div className="card">
            <h3>Agent traffic</h3>
            <p style={{ fontSize: 26, fontWeight: 800, color: 'var(--accent)' }}>
              {servers.reduce((sum, s) => sum + s.rpcCalls, 0)}
            </p>
            <p>tool calls since deploy</p>
          </div>
          <div className="card">
            <h3>Tools exposed</h3>
            <p style={{ fontSize: 26, fontWeight: 800, color: 'var(--accent)' }}>
              {servers.reduce((sum, s) => sum + s.toolCount, 0)}
            </p>
            <p>across your MCP servers</p>
          </div>
          <div className="card">
            <h3>MCP servers</h3>
            <p style={{ fontSize: 26, fontWeight: 800, color: 'var(--accent)' }}>{servers.length}</p>
            <p>live deployments</p>
          </div>
        </div>

        {quota && (
          <div className="card" style={{ marginBottom: 20 }}>
            <h3>Quota — {quota.plan} plan</h3>
            <p style={{ margin: '8px 0 12px' }}>
              {quota.used} of {quota.limit} scans used this month{quota.reason ? ` — ${quota.reason}` : ''}
            </p>
            <div style={{ height: 8, background: 'var(--panel)', borderRadius: 20, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min(100, (quota.used / Math.max(1, quota.limit)) * 100)}%`, background: 'var(--accent)' }} />
            </div>
          </div>
        )}

        {scan && scan.gaps.length > 0 && (
          <div className="card">
            <h3>Top fixes</h3>
            {scan.gaps.slice(0, 5).map((g) => (
              <div key={g.title} style={{ padding: '12px 0', borderTop: '1px solid var(--line)' }}>
                <div>{g.severity.toUpperCase()} — {g.title}</div>
                <div style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 5 }}>~{g.effortMinutes} min</div>
                {g.patch && (
                  <pre style={{ background: 'var(--bg)', padding: 10, borderRadius: 8, overflowX: 'auto', fontSize: 12, margin: '9px 0 0' }}>
                    <code>{g.patch}</code>
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}