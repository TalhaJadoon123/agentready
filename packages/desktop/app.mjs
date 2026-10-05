#!/usr/bin/env node
/**
 * AgentReady Desktop
 *
 * A standalone application window, not a browser tab. It boots the API and web
 * server in-process and opens a chromeless window pointed at the dashboard.
 *
 * Why not Electron? It is a ~200MB download that needs a build toolchain, and
 * this product's whole premise is that it runs on free tiers with zero friction.
 * Every OS ships a browser that can host an app-mode window, so we use the one
 * already present. The result installs instantly and behaves like a native app:
 * no address bar, no tabs, its own process, its own icon.
 *
 *   node packages/desktop/app.mjs            launch
 *   node packages/desktop/app.mjs --port 4000
 *   node packages/desktop/app.mjs --headless  start services only (for CI)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const PORT = Number(flag('port', process.env.AGENTREADY_DESKTOP_PORT ?? 3400));
const API_PORT = PORT + 1;
const ORIGIN = `http://localhost:${PORT}`;
const headless = has('headless');

const c = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
};
const paint = (text, code) => `${code}${text}${c.reset}`;

/** Wait for an endpoint to answer. */
async function waitFor(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

/**
 * Launch a chromeless app window using whatever browser the OS provides.
 * Returns false when none is available, so the caller can fall back to printing
 * the URL rather than crashing.
 */
function openAppWindow(url) {
  const platform = process.platform;

  const candidates =
    platform === 'win32'
      ? [
          // Edge is present on every Windows 10/11 install; Chrome if installed.
          { file: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', flag: '--app=%URL%' },
          { file: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', flag: '--app=%URL%' },
          { file: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', flag: '--app=%URL%' },
          { file: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', flag: '--app=%URL%' },
        ]
      : platform === 'darwin'
        ? [
            { file: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', flag: '--app=%URL%' },
            { file: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', flag: '--app=%URL%' },
            { file: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', flag: '--app=%URL%' },
          ]
        : [
            { file: '/usr/bin/google-chrome', flag: '--app=%URL%' },
            { file: '/usr/bin/chromium', flag: '--app=%URL%' },
            { file: '/usr/bin/chromium-browser', flag: '--app=%URL%' },
            { file: '/usr/bin/microsoft-edge', flag: '--app=%URL%' },
            { file: '/snap/bin/chromium', flag: '--app=%URL%' },
          ];

  for (const { file, flag: template } of candidates) {
    if (!existsSync(file)) continue;
    try {
      const child = spawn(file, [template.replace('%URL%', url), '--window-size=1280,900'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return file;
    } catch {
      /* try the next one */
    }
  }

  return false;
}

async function main() {
  console.log(`
${paint('AgentReady Desktop', c.bold)}
${c.dim}SEO for agents. Be found by AI.${c.reset}
`);

  const apiEntry = join(root, 'packages', 'api', 'dist', 'server.js');
  const webEntry = join(root, 'packages', 'web', 'server.mjs');

  if (!existsSync(apiEntry)) {
    console.error(paint('The API is not built.', c.red));
    console.error('Run: npm run build\n');
    process.exit(1);
  }

  const env = {
    ...process.env,
    // The API must bind its own port, not the desktop one — otherwise it
    // collides with the web server and both fail to listen.
    PORT: String(API_PORT),
    API_BASE: `http://localhost:${API_PORT}`,
    SITE_URL: ORIGIN,
    AGENTREADY_DEV_AUTH: 'true',
    // The desktop app scans localhost freely by design.
    AGENTREADY_ALLOW_PRIVATE_FETCH: 'true',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  };

  const children = [];

  /**
   * Spawn a service, capturing output so a failure is explainable instead of
   * a silent timeout. VERBOSE streams it live; otherwise the tail is kept and
   * printed if the service does not come up.
   */
  const spawnService = (label, entry, extraEnv = {}) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tail = [];
    const capture = (stream) => {
      stream.on('data', (chunk) => {
        const text = String(chunk);
        if (process.env.VERBOSE) process.stderr.write(`${paint(`[${label}]`, c.dim)} ${text}`);
        tail = text.split('\n').concat(tail).slice(0, 12);
      });
    };
    capture(child.stdout);
    capture(child.stderr);

    children.push(child);
    return { child, recentOutput: () => tail.join('\n').trim() };
  };

  const api = spawnService('api', apiEntry);

  if (!(await waitFor(`http://localhost:${API_PORT}/health`))) {
    console.error(paint('The API did not start.', c.red));
    if (api.recentOutput()) console.error(c.dim + api.recentOutput() + c.reset);
    for (const child of children) child.kill();
    process.exit(1);
  }
  console.log(`  ${paint('API', c.green)}      http://localhost:${API_PORT}`);
  console.log(`  ${paint('Data', c.green)}     ${env.AGENTREADY_DB_PATH ?? './data/agentready.json'}`);

  const web = spawnService('web', webEntry, { PORT: String(PORT) });

  if (!(await waitFor(`${ORIGIN}/health`))) {
    console.error(paint('The web server did not start.', c.red));
    if (web.recentOutput()) console.error(c.dim + web.recentOutput() + c.reset);
    for (const child of children) child.kill();
    process.exit(1);
  }
  console.log(`  ${paint('Interface', c.green)} ${ORIGIN}`);

  if (headless) {
    console.log(`\n${c.dim}--headless: services running, not opening a window.${c.reset}\n`);
  } else {
    const browser = openAppWindow(`${ORIGIN}/dashboard`);
    console.log(
      browser
        ? `\n  ${paint('Window opened', c.green)} ${c.dim}(${browser.split(/[\\/]/).pop()})${c.reset}\n`
        : `\n  ${paint('No app-capable browser found.', c.yellow)}\n  Open ${ORIGIN}/dashboard in any browser.\n`,
    );
  }

  const shutdown = (code = 0) => {
    for (const child of children) {
      if (!child.killed) child.kill();
    }
    process.exit(code);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  for (const child of children) {
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) shutdown(code);
    });
  }
}

main().catch((err) => {
  console.error(paint('AgentReady Desktop failed to start:', c.red), err instanceof Error ? err.message : err);
  process.exit(1);
});