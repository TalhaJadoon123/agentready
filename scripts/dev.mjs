/**
 * Run the whole stack for local development.
 *
 *   npm run dev
 *
 * Starts the API (:8787), the web server (:3000), the docs (:3100) and the
 * demo store (:8790). Ctrl-C stops everything.
 */

import { spawn } from 'node:child_process';

const SERVICES = [
  { name: 'demo', color: '\u001b[35m', args: ['packages/seed/src/demo-site.mjs'] },
  { name: 'api', color: '\u001b[36m', args: ['packages/api/dist/server.js'] },
  { name: 'web', color: '\u001b[32m', args: ['packages/web/server.mjs'] },
  { name: 'docs', color: '\u001b[33m', args: ['packages/docs/server.mjs'] },
];

const RESET = '\u001b[0m';
const children = [];
let shuttingDown = false;

for (const service of SERVICES) {
  const child = spawn(process.execPath, service.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      // Local development only. The API refuses unauthenticated requests
      // unless this is explicitly set, so a misconfigured deployment is closed.
      AGENTREADY_DEV_AUTH: 'true',
      // The bundled demo store lives on localhost.
      AGENTREADY_ALLOW_PRIVATE_FETCH: 'true',
      ...process.env,
    },
  });

  const prefix = `${service.color}${service.name.padEnd(5)}${RESET} │ `;
  const pipe = (stream) => {
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) process.stdout.write(`${prefix}${line}\n`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });

  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`
  AgentReady is starting.

    Site    http://localhost:3000
    API     http://localhost:8787
    Docs    http://localhost:3100/docs
    Demo    http://localhost:8790   (a reference store, scores 82/100)

  Try:
    node packages/cli/bin/agentready.mjs scan http://localhost:8790
    node packages/cli/bin/agentready.mjs simulate http://localhost:8790 --competitors https://bare.example

  Ctrl-C to stop.
`);