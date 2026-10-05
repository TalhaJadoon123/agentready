/**
 * Full-stack smoke test: demo site + API + web, exactly as a user would run it.
 * Verifies the marketing page, the scan flow, and every dashboard page.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const procs = [];
function start(name, args, cwd = process.cwd()) {
  // The API refuses unauthenticated calls unless explicitly opted in, and the
  // scanner refuses private targets unless opted in. Both are required here:
  // the demo store runs on localhost.
  const p = spawn(process.execPath, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENTREADY_DEV_AUTH: 'true', AGENTREADY_ALLOW_PRIVATE_FETCH: 'true' },
  });
  p.stdout.on('data', (d) => process.env.VERBOSE && console.log(`[${name}] ${d}`));
  p.stderr.on('data', (d) => console.log(`[${name}!] ${d}`.trim()));
  procs.push(p);
  return p;
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

try {
  start('demo', ['packages/seed/src/demo-site.mjs']);
  start('api', ['packages/api/dist/server.js']);
  start('web', ['packages/web/server.mjs']);

  check('demo site up', await waitFor('http://localhost:8790/health') || await waitFor('http://localhost:8790/'), '8790');
  check('api up', await waitFor('http://localhost:8787/health'), '8787');
  check('web up', await waitFor('http://localhost:3000/'), '3000');

  // Marketing
  let r = await fetch('http://localhost:3000/');
  const home = await r.text();
  check('home renders hero', r.status === 200 && home.includes('SEO for agents'));
  check('home lists 8 pillars', (home.match(/class="pts"/g) ?? []).length === 8);
  check('home has 3 pricing tiers', home.includes('Free') && home.includes('$49') && home.includes('$149'));
  check('home ships JSON-LD', home.includes('application/ld+json'));

  r = await fetch('http://localhost:3000/llms.txt');
  check('llms.txt served', r.status === 200 && (await r.text()).includes('# AgentReady'));

  r = await fetch('http://localhost:3000/.well-known/mcp.json');
  check('web publishes its own mcp manifest', r.status === 200 && (await r.json()).mcpServers !== undefined);

  // API scan against the demo site
  r = await fetch('http://localhost:8787/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://localhost:8790' }),
    signal: AbortSignal.timeout(90_000),
  });
  const scanBody = await r.json();
  check('API scans localhost', r.status === 200, `got ${r.status} ${scanBody?.error?.message ?? ''}`);
  check('API returns a score', typeof scanBody?.scan?.score === 'number', `score=${scanBody?.scan?.score} grade=${scanBody?.scan?.grade}`);
  check('API returns 8 checks', scanBody?.scan?.checks?.length === 8);
  check('demo site scores well', (scanBody?.scan?.score ?? 0) >= 70, `score=${scanBody?.scan?.score}`);

  // Dashboard reads the API
  r = await fetch('http://localhost:3000/dashboard?url=http://localhost:8790', { signal: AbortSignal.timeout(90_000) });
  const dash = await r.text();
  check('dashboard renders live scan', r.status === 200 && dash.includes('Agent-readiness'), `${dash.length} bytes`);
  const scoreMatch = />(\d+)<\/div>\s*<div style="font-size:10px/.exec(dash);
  check('dashboard shows the score', Boolean(scoreMatch), scoreMatch ? `score=${scoreMatch[1]}` : 'not found');

  for (const page of ['/scanner', '/mcp-servers']) {
    r = await fetch(`http://localhost:3000${page}`);
    const body = await r.text();
    check(`${page} renders`, r.status === 200 && body.length > 1000, `${body.length} bytes`);
  }

  // CLI
  r = await fetch('http://localhost:8790/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = await r.json();
  check('demo MCP exposes 5 tools', tools?.result?.tools?.length === 5);
} finally {
  for (const p of procs) p.kill();
}

console.log(failures === 0 ? '\nALL STACK CHECKS PASSED' : `\n${failures} STACK CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);