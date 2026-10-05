/**
 * Final acceptance test: the desktop app, the CLI and every surface.
 * Self-contained so nothing depends on a process surviving between commands.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const procs = [];
function start(name, args, extraEnv = {}) {
  const p = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { AGENTREADY_DEV_AUTH: 'true', AGENTREADY_ALLOW_PRIVATE_FETCH: 'true', ...process.env, ...extraEnv },
  });
  p.stdout.on('data', (d) => process.env.VERBOSE && console.log(`[${name}] ${d}`));
  p.stderr.on('data', (d) => console.log(`[${name}!] ${String(d).trim()}`));
  procs.push(p);
  return p;
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return true;
    } catch { /* retry */ }
    await sleep(400);
  }
  return false;
}

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

const CHILD_ENV = { AGENTREADY_DEV_AUTH: 'true', AGENTREADY_ALLOW_PRIVATE_FETCH: 'true', ...process.env };

// A CLI child with NO opt-ins: used to prove the SSRF guard is on by default.
const LOCKED_ENV = { ...process.env };
delete LOCKED_ENV.AGENTREADY_ALLOW_PRIVATE_FETCH;

const cliLocked = (...args) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, ['packages/cli/bin/agentready.mjs', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: LOCKED_ENV,
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

const cli = (...args) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, ['packages/cli/bin/agentready.mjs', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The CLI scans localhost (the demo store), which the SSRF guard blocks
      // unless explicitly allowed — same opt-in the desktop app sets.
      env: CHILD_ENV,
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

try {
  // ---- Desktop app -------------------------------------------------------
  console.log('\n--- DESKTOP APP ---');
  start('desktop', ['packages/desktop/app.mjs', '--headless', '--port', '3400']);

  const apiUp = await waitFor('http://localhost:3401/health');
  check('desktop: API starts', apiUp);

  const webUp = await waitFor('http://localhost:3400/health');
  check('desktop: web starts', webUp);

  if (webUp) {
    for (const [label, path] of [
      ['home', '/'],
      ['dashboard', '/dashboard'],
      ['scanner', '/scanner'],
      ['mcp-servers', '/mcp-servers'],
      ['llms.txt', '/llms.txt'],
      ['style.css', '/style.css'],
    ]) {
      const r = await fetch(`http://localhost:3400${path}`, { signal: AbortSignal.timeout(25_000) });
      const body = await r.text();
      check(`desktop GUI: ${label}`, r.ok && body.length > 100, `${r.status} ${body.length}b`);
    }

    // The dashboard must actually read from the API, not render placeholders.
    const dash = await (await fetch('http://localhost:3400/dashboard', { signal: AbortSignal.timeout(25_000) })).text();
    check('desktop GUI: dashboard reads API', dash.includes('Quota') || dash.includes('Agent-readiness'));
  }

  // ---- CLI --------------------------------------------------------------
  console.log('\n--- CLI (7 commands) ---');
  start('demo', ['packages/seed/src/demo-site.mjs']);
  await waitFor('http://localhost:8790/');

  let r = await cli('scan', 'http://localhost:8790');
  check('cli scan', r.out.includes('Agent-Readiness Score'), r.out.match(/Score: (\d+\/100)/)?.[0]);

  r = await cli('generate', '--source', 'csv', '--file', 'fixtures/products.csv', '--name', 'final', '--out-dir', 'out/accept');
  check('cli generate', r.out.includes('5 tool(s)'), r.out.match(/Generated \d+ product/)?.[0]);

  r = await cli('publish', 'https://shop.example', '--platform', 'wordpress', '--out-dir', 'out/accept');
  check('cli publish', r.out.includes('Validation: valid'));

  r = await cli('register', 'final', '--url', 'https://final-mcp.workers.dev', '--dry-run');
  check('cli register (dry-run)', r.out.includes('dry-run') && !r.out.includes('rejected'));

  r = await cli('verify', 'http://localhost:8790', '--server', 'http://localhost:8790/mcp', '--samples', '1');
  check('cli verify', r.out.includes('healthy'), r.out.match(/site\s+\w+/)?.[0]);

  r = await cli('enrich', 'example.com', '--offline');
  check('cli enrich', r.out.includes('example.com'));

  r = await cli('simulate', 'http://localhost:8790', '--queries', 'What do you sell?');
  check('cli simulate', r.out.includes('Agent Visibility'));

  // ---- Security ---------------------------------------------------------
  console.log('\n--- SECURITY ---');
  // These run WITHOUT the opt-in, proving the guard is closed by default.
  r = await cliLocked('scan', 'http://169.254.169.254/');
  check('SSRF: metadata endpoint refused', r.out.includes('Refusing to fetch'));

  r = await cliLocked('scan', 'http://127.0.0.1:8790/');
  check('SSRF: loopback refused', r.out.includes('Refusing to fetch'));

  r = await cliLocked('scan', 'http://10.0.0.1/');
  check('SSRF: private range refused', r.out.includes('Refusing to fetch'));

  r = await cliLocked('scan', 'http://192.168.1.1/');
  check('SSRF: RFC1918 192.168 refused', r.out.includes('Refusing to fetch'));

  r = await cliLocked('scan', 'file:///etc/passwd');
  check('SSRF: file:// refused', r.out.includes('Refusing to fetch'));

  // And the hint must be actionable, not a dead end.
  r = await cliLocked('scan', 'http://127.0.0.1:8790/');
  check('SSRF: refusal explains the opt-in', r.out.includes('AGENTREADY_ALLOW_PRIVATE_FETCH'));

  const forged = await fetch('http://localhost:3401/quota', { headers: { authorization: 'Bearer forged.sig' } });
  check('auth: forged token rejected, not downgraded', forged.status === 401, `HTTP ${forged.status}`);

  const enrichBlocked = await fetch('http://localhost:3401/enrich?url=http://169.254.169.254/');
  check('SSRF: /enrich blocked (400, not 500)', enrichBlocked.status === 400, `HTTP ${enrichBlocked.status}`);

  // The desktop API intentionally allows private targets, so the /scan guard is
  // proved against a separate instance started with no opt-ins at all.
  const locked = spawn(process.execPath, ['packages/api/dist/server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '3455', LOG_LEVEL: 'error', AGENTREADY_DEV_AUTH: 'true' },
  });
  procs.push(locked);
  await waitFor('http://localhost:3455/health');

  const scanBlocked = await fetch('http://localhost:3455/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://10.0.0.1/' }),
  });
  check('SSRF: /scan blocked (400, not 500)', scanBlocked.status === 400, `HTTP ${scanBlocked.status}`);

  const fileBlocked = await fetch('http://localhost:3455/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'file:///etc/passwd' }),
  });
  check('SSRF: file:// blocked (400)', fileBlocked.status === 400, `HTTP ${fileBlocked.status}`);
} finally {
  for (const p of procs) p.kill();
}

console.log(failures === 0 ? '\n=== ALL ACCEPTANCE CHECKS PASSED ===' : `\n=== ${failures} CHECK(S) FAILED ===`);
process.exit(failures === 0 ? 0 : 1);