'use client';

/** Scan history: past scans, scores and the fixes each one produced. */

import { useEffect, useState } from 'react';
import Link from 'next/link';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

type Site = { id: string; url: string; name: string; createdAt: string };
type ScanRow = { id: string; url: string; score: number; grade: string; createdAt: string };

export default function ScannerPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/sites`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = (await res.json()) as Site[];
        setSites(data);
        if (data[0]) setActive(data[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not reach the API');
      }
    })();
  }, []);

  useEffect(() => {
    if (!active) return;
    (async () => {
      try {
        const res = await fetch(`${API}/sites/${active}/scans?limit=20`);
        setScans(res.ok ? ((await res.json()) as ScanRow[]) : []);
      } catch {
        setScans([]);
      }
    })();
  }, [active]);

  return (
    <div className="wrap">
      <section style={{ border: 0 }}>
        <h1>Scan history</h1>
        <p className="lead">Every scan we have run for your sites, newest first.</p>

        {error && (
          <div className="card" style={{ borderColor: 'var(--bad)', marginBottom: 20 }}>
            <h3 style={{ color: 'var(--bad)' }}>{error}</h3>
            <p style={{ marginTop: 10 }}>
              Start the API with <code>npm run dev:api</code>, then reload.
            </p>
          </div>
        )}

        {sites.length === 0 && !error && (
          <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <h3>No sites yet</h3>
            <p style={{ margin: '12px 0 20px', color: 'var(--muted)' }}>Run a scan from the dashboard to start tracking history.</p>
            <Link className="btn" href="/dashboard">
              Scan a site
            </Link>
          </div>
        )}

        {sites.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>
                <th style={{ padding: '10px 0' }}>Site</th>
                <th style={{ padding: '10px 0' }}>URL</th>
                <th style={{ padding: '10px 0' }}>Added</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '11px 0' }}>
                    <button onClick={() => setActive(s.id)} style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }}>
                      {s.name}
                    </button>
                  </td>
                  <td style={{ padding: '11px 0', color: 'var(--muted)' }}>{s.url}</td>
                  <td style={{ padding: '11px 0', color: 'var(--muted)' }}>{s.createdAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {active && (
          <>
            <h2 style={{ marginTop: 38 }}>Scans</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>
                  <th style={{ padding: '10px 0' }}>When</th>
                  <th style={{ padding: '10px 0' }}>Score</th>
                  <th style={{ padding: '10px 0' }}>Grade</th>
                </tr>
              </thead>
              <tbody>
                {scans.length === 0 ? (
                  <tr>
                    <td colSpan={3} style={{ padding: '16px 0', color: 'var(--muted)' }}>
                      No scans recorded yet.
                    </td>
                  </tr>
                ) : (
                  scans.map((s) => (
                    <tr key={s.id} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={{ padding: '11px 0', color: 'var(--muted)' }}>{s.createdAt.replace('T', ' ').slice(0, 16)}</td>
                      <td style={{ padding: '11px 0', fontFamily: 'ui-monospace, monospace' }}>{s.score}</td>
                      <td style={{ padding: '11px 0' }}>{s.grade}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </>
        )}

        <p style={{ marginTop: 24 }}>
          <Link href="/dashboard">← Dashboard</Link> · <Link href="/mcp-servers">MCP servers →</Link>
        </p>
      </section>
    </div>
  );
}