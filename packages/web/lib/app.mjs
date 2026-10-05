/**
 * The app pages (dashboard, scanner history, MCP servers).
 *
 * These read live data from the AgentReady API and degrade honestly: when the
 * API is not running, each page says so instead of showing fabricated numbers.
 */

import { renderPage, STYLES } from './pages.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Fetch from the API, returning null rather than throwing when it is down. */
async function api(path, base, init) {
  try {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const POST = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const badge = (status) => {
  const color = { live: 'var(--good)', pass: 'var(--good)', ok: 'var(--good)', down: 'var(--bad)', fail: 'var(--bad)', missing: 'var(--bad)', warn: 'var(--warn)' }[status] ?? 'var(--muted)';
  return `<span style="color:${color};font-weight:700">${esc(String(status).toUpperCase())}</span>`;
};

const scoreRing = (score) => {
  const color = score >= 85 ? 'var(--good)' : score >= 70 ? 'var(--accent)' : score >= 40 ? 'var(--warn)' : 'var(--bad)';
  const pct = Math.max(0, Math.min(100, score));
  return `<div style="display:flex;align-items:center;gap:18px">
    <div style="width:118px;height:118px;border-radius:50%;display:grid;place-items:center;
      background:conic-gradient(${color} ${pct * 3.6}deg,var(--panel) 0deg)">
      <div style="width:92px;height:92px;border-radius:50%;background:var(--bg);display:grid;place-items:center">
        <div style="text-align:center"><div style="font-size:26px;font-weight:800;color:${color}">${esc(score)}</div>
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">out of 100</div></div>
      </div>
    </div>
    <div><h2 style="margin:0 0 6px">Agent-readiness</h2>
    <p style="margin:0;color:var(--muted);font-size:14.5px">The weighted sum of eight pillars. Each one is a capability an assistant needs to serve you: read prices, check stock, authenticate, and place an order.</p></div>
  </div>`;
};

const pillars = (checks) => `<table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:14.5px">
  <thead><tr style="text-align:left;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em">
    <th style="padding:8px 0">Pillar</th><th style="padding:8px 0">Score</th><th style="padding:8px 0">Status</th></tr></thead>
  <tbody>${(checks ?? []).map((c) => `<tr style="border-top:1px solid var(--line)">
    <td style="padding:10px 0">${esc(c.title)}</td>
    <td style="padding:10px 0;font-family:ui-monospace,monospace">${esc(c.points)}/${esc(c.maxPoints)}</td>
    <td style="padding:10px 0">${badge(c.status)}</td></tr>`).join('')}</tbody></table>`;

const offline = (base) => `<div class="card" style="text-align:center;padding:44px">
  <h3>The API is not running</h3>
  <p style="margin:12px auto 20px;max-width:460px">This page reads live data from the AgentReady API at <code>${esc(base)}</code>.
  Start it with <code>npm run dev:api</code> (or <code>node packages/api/dist/server.js</code>) and reload.</p>
</div>`;

// ---------------------------------------------------------------------------
// /dashboard
// ---------------------------------------------------------------------------

export async function dashboardPage({ apiBase, url }) {
  const data = url ? await api(`/scan`, apiBase, POST({ url })) : await api('/dashboard', apiBase);

  if (!data) {
    return renderPage({
      path: '/dashboard',
      title: 'Dashboard — AgentReady',
      body: `<div class="wrap"><section style="border:0"><h1>Dashboard</h1>${offline(apiBase)}</section></div>`,
    });
  }

  if (data.error) {
    return renderPage({
      path: '/dashboard',
      title: 'Dashboard — AgentReady',
      body: `<div class="wrap"><section style="border:0"><h1>Dashboard</h1>
        <div class="card" style="border-color:var(--bad)"><h3 style="color:var(--bad)">${esc(data.error.message)}</h3>
        <p style="margin-top:10px">${esc(JSON.stringify(data.error.details ?? {}))}</p></div>
        <p style="margin-top:16px"><a href="/dashboard">← Back</a></p></section></div>`,
    });
  }

  const scan = data.scan ?? data;
  const server = data.mcpServers ?? [];
  const quota = data.quota;

  const body = `<div class="wrap"><section style="border:0">
  <h1>Dashboard</h1>
  <p class="lead">${esc(scan.url ?? 'No site scanned yet')}</p>

  <div class="card" style="margin-bottom:20px">${scoreRing(scan.score ?? 0)}
    <div style="margin-top:18px">${pillars(scan.checks)}</div>
  </div>

  <div class="grid" style="margin-bottom:20px">
    <div class="card"><h3>Agent traffic</h3>
      <p style="font-size:26px;font-weight:800;color:var(--accent)">${esc(data.rpcCalls ?? server.reduce((s, m) => s + (m.rpcCalls ?? 0), 0))}</p>
      <p>tool calls since deploy</p></div>
    <div class="card"><h3>Tools exposed</h3>
      <p style="font-size:26px;font-weight:800;color:var(--accent)">${esc(data.mcpToolCount ?? server.reduce((s, m) => s + (m.toolCount ?? 0), 0))}</p>
      <p>across your MCP servers</p></div>
    <div class="card"><h3>Attributed revenue</h3>
      <p style="font-size:26px;font-weight:800;color:var(--accent)">${esc(data.events?.length ?? 0)}</p>
      <p>agent-originated orders tracked</p></div>
  </div>

  ${quota ? `<div class="card" style="margin-bottom:20px"><h3>Quota — ${esc(quota.plan)} plan</h3>
    <p style="margin:8px 0 12px">${esc(quota.used)} of ${esc(quota.limit)} scans used this month${quota.reason ? ` — ${esc(quota.reason)}` : ''}</p>
    <div style="height:8px;background:var(--panel);border-radius:20px;overflow:hidden">
      <div style="height:100%;width:${Math.min(100, (quota.used / Math.max(1, quota.limit)) * 100)}%;background:var(--accent)"></div></div></div>` : ''}

  <div class="card"><h3>Top fixes</h3>
    ${(scan.gaps ?? []).slice(0, 5).map((g) => `<div style="padding:12px 0;border-top:1px solid var(--line)">
      <div>${badge(g.severity)} ${esc(g.title)}</div>
      <div style="color:var(--muted);font-size:13.5px;margin-top:5px">~${esc(g.effortMinutes)} min</div>
      ${g.patch ? `<pre style="background:var(--bg);padding:10px;border-radius:8px;overflow-x:auto;font-size:12px;margin:9px 0 0"><code>${esc(g.patch)}</code></pre>` : ''}
    </div>`).join('') || '<p style="color:var(--muted);margin-top:12px">No gaps — everything is passing.</p>'}
  </div>

  <p style="margin-top:24px"><a href="/scanner">Scan history →</a> · <a href="/mcp-servers">MCP servers →</a></p>
</section></div>`;

  return renderPage({ path: '/dashboard', title: 'Dashboard — AgentReady', body, apiBase });
}

// ---------------------------------------------------------------------------
// /scanner
// ---------------------------------------------------------------------------

export async function scannerPage({ apiBase, siteId }) {
  const sites = await api('/sites', apiBase);
  if (!sites) {
    return renderPage({ path: '/scanner', title: 'Scan history — AgentReady', body: `<div class="wrap"><section style="border:0"><h1>Scan history</h1>${offline(apiBase)}</section></div>` });
  }

  const id = siteId ?? sites[0]?.id;
  const scans = id ? await api(`/sites/${id}/scans?limit=20`, apiBase) : [];

  const body = `<div class="wrap"><section style="border:0">
  <h1>Scan history</h1>
  <p class="lead">Every scan we have run for your sites, newest first.</p>

  ${(sites ?? []).length === 0
    ? `<div class="card" style="text-align:center;padding:40px"><h3>No sites yet</h3>
       <p style="margin:12px 0 20px;color:var(--muted)">Run a scan from the dashboard to start tracking history.</p>
       <a class="btn" href="/dashboard">Scan a site</a></div>`
    : `<table style="width:100%;border-collapse:collapse;font-size:14.5px">
      <thead><tr style="text-align:left;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em">
        <th style="padding:10px 0">Site</th><th style="padding:10px 0">URL</th><th style="padding:10px 0">Added</th></tr></thead>
      <tbody>${(sites ?? []).map((s) => `<tr style="border-top:1px solid var(--line)">
        <td style="padding:11px 0"><a href="/scanner?site=${esc(s.id)}">${esc(s.name)}</a></td>
        <td style="padding:11px 0;color:var(--muted)">${esc(s.url)}</td>
        <td style="padding:11px 0;color:var(--muted)">${esc(String(s.createdAt).slice(0, 10))}</td></tr>`).join('')}</tbody></table>`}

  ${id ? `<h2 style="margin-top:38px">Scans</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14.5px">
    <thead><tr style="text-align:left;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em">
      <th style="padding:10px 0">When</th><th style="padding:10px 0">Score</th><th style="padding:10px 0">Grade</th></tr></thead>
    <tbody>${(scans ?? []).map((s) => `<tr style="border-top:1px solid var(--line)">
      <td style="padding:11px 0;color:var(--muted)">${esc(String(s.createdAt).replace('T', ' ').slice(0, 16))}</td>
      <td style="padding:11px 0;font-family:ui-monospace,monospace">${esc(s.score)}</td>
      <td style="padding:11px 0">${esc(s.grade)}</td></tr>`).join('') || '<tr><td colspan="3" style="padding:16px 0;color:var(--muted)">No scans recorded yet.</td></tr>'}</tbody></table>` : ''}

  <p style="margin-top:24px"><a href="/dashboard">← Dashboard</a> · <a href="/mcp-servers">MCP servers →</a></p>
</section></div>`;

  return renderPage({ path: '/scanner', title: 'Scan history — AgentReady', body, apiBase });
}

// ---------------------------------------------------------------------------
// /mcp-servers
// ---------------------------------------------------------------------------

export async function mcpServersPage({ apiBase }) {
  const data = await api('/dashboard', apiBase);
  if (!data) {
    return renderPage({ path: '/mcp-servers', title: 'MCP servers — AgentReady', body: `<div class="wrap"><section style="border:0"><h1>MCP servers</h1>${offline(apiBase)}</section></div>` });
  }

  const servers = data.mcpServers ?? [];

  const body = `<div class="wrap"><section style="border:0">
  <h1>MCP servers</h1>
  <p class="lead">Generated servers, their tools, usage against the free-tier limit, and whether agents are actually calling them.</p>

  ${servers.length === 0
    ? `<div class="card" style="text-align:center;padding:40px"><h3>No servers yet</h3>
       <p style="margin:12px 0 20px;color:var(--muted)">Generate one from a CSV, JSON file, API or a public catalogue page.</p>
       <div class="demo" style="text-align:left">agentready generate --source csv --file products.csv --name acme-store<br>
       agentready publish --target cloudflare</div></div>`
    : `<div class="grid">${servers.map((s) => {
        const used = Math.min(100, (s.rpcCalls / Math.max(1, s.monthlyLimit)) * 100);
        return `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:12px">
          <div><h3 style="margin:0 0 4px">${esc(s.name)}</h3>
          <div style="color:var(--muted);font-size:12.5px;font-family:ui-monospace,monospace">${esc(s.url)}</div></div>
          ${badge(s.status)}</div>
        <div style="display:flex;gap:22px;margin:18px 0">
          <div><div style="font-size:21px;font-weight:800">${esc(s.toolCount)}</div><div style="font-size:12px;color:var(--muted)">tools</div></div>
          <div><div style="font-size:21px;font-weight:800">${esc(s.rpcCalls)}</div><div style="font-size:12px;color:var(--muted)">calls</div></div>
          <div><div style="font-size:21px;font-weight:800">${esc(s.version)}</div><div style="font-size:12px;color:var(--muted)">version</div></div>
        </div>
        <div style="height:7px;background:var(--bg);border-radius:20px;overflow:hidden">
          <div style="height:100%;width:${used}%;background:${used > 80 ? 'var(--bad)' : 'var(--accent)'}"></div></div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:7px">${esc(s.rpcCalls)} of ${esc(s.monthlyLimit)} monthly RPC calls used</div>
      </div>`;
      }).join('')}</div>`}

  <div class="card" style="margin-top:26px">
    <h3>Registering a server</h3>
    <p style="margin:8px 0 14px;color:var(--muted)">Submission makes a server discoverable. Dry-run first — the official registry is reviewed by hand.</p>
    <div class="demo">agentready register acme-store --url https://acme-store-mcp.workers.dev --dry-run<br>
agentready register acme-store --url https://acme-store-mcp.workers.dev</div>
  </div>

  <p style="margin-top:24px"><a href="/dashboard">← Dashboard</a> · <a href="/scanner">Scan history →</a></p>
</section></div>`;

  return renderPage({ path: '/mcp-servers', title: 'MCP servers — AgentReady', body, apiBase });
}

export { STYLES };