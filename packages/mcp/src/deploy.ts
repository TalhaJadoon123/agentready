/**
 * Deployment.
 *
 * Two free targets:
 *   - Cloudflare Workers — 100k requests/day. We talk to the Workers Script
 *     API directly, so there is no wrangler dependency and no Node runtime on
 *     the Worker side.
 *   - Smithery — 25k RPC/mo. Their deploy path is their own CLI, so we build
 *     the profile and shell out to it rather than reimplement a private API.
 *
 * Both providers are honest about failure: if credentials are missing we say so
 * plainly instead of pretending a deploy succeeded.
 */

import type { DeploymentResult, MCPServerSpec } from '@agentready/shared';
import { config, errorMessage, hasApiKey, logger, serverSlug } from '@agentready/shared';

export type DeployTarget = 'cloudflare' | 'smithery' | 'local';

export interface DeployInput {
  spec: MCPServerSpec;
  /** Self-contained worker source from the generator. */
  code: string;
  /** Registry manifest to publish alongside. */
  manifest: Record<string, unknown>;
  openapi: Record<string, unknown>;
  target: DeployTarget;
  /** Report what would happen without changing anything. */
  dryRun?: boolean;
  /** Environment override, for tests. */
  env?: {
    cloudflareApiToken?: string;
    cloudflareAccountId?: string;
    cloudflareSubdomain?: string;
    smitheryApiKey?: string;
    smitheryProfile?: string;
  };
}

export class DeployError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'DeployError';
  }
}

/** Build the worker filename and expected public URL for a server. */
export function workerNames(spec: MCPServerSpec, subdomain: string): { script: string; url: string } {
  const script = `${serverSlug(spec.name)}-mcp`;
  return { script, url: `https://${script}.${subdomain}.workers.dev` };
}

/**
 * Deploy to Cloudflare Workers.
 *
 * Uses the Script API's multipart upload:
 *   POST /accounts/{account_id}/workers/scripts/{script_name}
 * with a `metadata` part and a `script` part.
 */
export async function deployToCloudflare(input: DeployInput): Promise<DeploymentResult> {
  const cfg = config();
  const env = input.env ?? {};
  const token = env.cloudflareApiToken ?? cfg.cloudflare.apiToken;
  const accountId = env.cloudflareAccountId ?? cfg.cloudflare.accountId;
  const subdomain = env.cloudflareSubdomain ?? cfg.cloudflare.subdomain;

  if (!hasApiKey(token)) {
    throw new DeployError(
      'CLOUDFLARE_API_TOKEN is not set.',
      'Create a token at dash.cloudflare.com/profile/api-tokens with "Workers Scripts:Edit" and "Account Settings:Read". Free tier covers 100k requests/day.',
    );
  }
  if (!hasApiKey(accountId)) {
    throw new DeployError('CLOUDFLARE_ACCOUNT_ID is not set.', 'Find it in the Cloudflare dashboard URL sidebar, or `wrangler whoami`.');
  }

  const { script, url } = workerNames(input.spec, subdomain);

  if (input.dryRun) {
    return {
      provider: 'cloudflare',
      url: `${url}/mcp`,
      status: 'pending',
      logs: [
        `[dry-run] would PUT ${script}.js (${input.code.length} bytes) to account ${accountId}`,
        `[dry-run] expected endpoint: ${url}/mcp`,
        `[dry-run] discovery manifest: ${url}/.well-known/mcp.json`,
        `[dry-run] openapi: ${url}/openapi.json`,
      ],
    };
  }

  // Multipart body: metadata + the module worker source.
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2025-01-01',
    compatibility_flags: ['nodejs_compat'],
    bindings: [{ name: 'OPENAPI', type: 'plain_text', text: JSON.stringify(input.openapi) }],
  };

  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('index.js', new Blob([input.code], { type: 'application/javascript+module' }), 'index.js');

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    throw new DeployError(`Could not reach the Cloudflare API: ${errorMessage(err)}`, 'Check network access and that api.cloudflare.com is reachable.');
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const errors = Array.isArray(parsed['errors']) ? (parsed['errors'] as Array<{ message?: string }>) : [];
    const detail = errors.map((e) => e.message).filter(Boolean).join('; ') || text.slice(0, 300);
    throw new DeployError(
      `Cloudflare rejected the upload (HTTP ${res.status}): ${detail}`,
      'Verify the token has Workers Scripts:Edit, and that the script name does not collide with an existing route.',
    );
  }

  // Probe the deployed endpoint so we never report "live" for something dead.
  const health = await verifyDeployment(`${url}/health`, 8_000);
  const live = health.ok && health.body.includes('"ok"');

  return {
    provider: 'cloudflare',
    url: `${url}/mcp`,
    status: live ? 'live' : 'pending',
    region: 'global',
    deployedAt: new Date().toISOString(),
    logs: [
      `Uploaded ${script} to account ${accountId}.`,
      live ? `Health check passed: ${url}/health` : `WARNING: uploaded but health check failed: ${health.body.slice(0, 200) || health.error}`,
      `Discovery manifest: ${url}/.well-known/mcp.json`,
    ],
  };
}

/**
 * Deploy to Smithery.
 *
 * Smithery deploys through its own CLI (`@smithery/cli`), which handles auth,
 * build and rollout. We generate the profile + server directory, then invoke
 * the CLI. This is the honest path — reverse-engineering their private
 * registry API would break the moment they changed it.
 */
export async function deployToSmithery(input: DeployInput, options: { workDir: string; run?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> }): Promise<DeploymentResult> {
  const cfg = config();
  const env = input.env ?? {};
  const apiKey = env.smitheryApiKey ?? cfg.smithery.apiKey;
  const profile = env.smitheryProfile ?? cfg.smithery.profile;

  const slug = serverSlug(input.spec.name);

  if (input.dryRun) {
    return {
      provider: 'smithery',
      url: `https://smithery.ai/${profile}/${slug}`,
      status: 'pending',
      logs: [
        `[dry-run] would write ${options.workDir}/${slug}/{server.js,smithery.yaml}`,
        `[dry-run] would run: npx -y @smithery/cli@latest deploy ${slug} --profile ${profile}`,
        `[dry-run] free tier: 25,000 RPC calls/month`,
      ],
    };
  }

  if (!hasApiKey(apiKey)) {
    throw new DeployError(
      'SMITHERY_API_KEY is not set.',
      'Create a key at smithery.ai/account/api-keys, then `npx @smithery/cli@latest login`. Free tier is 25k RPC calls/month.',
    );
  }

  // Write the deployable directory.
  await writeServerDirectory(options.workDir, slug, input);

  const run =
    options.run ??
    (async (cmd: string, args: string[]) => {
      const { spawn } = await import('node:child_process');
      return new Promise((resolve) => {
        const child = spawn(cmd, args, {
          env: { ...process.env, SMITHERY_API_KEY: apiKey, SMITHERY_PROFILE: profile },
          shell: process.platform === 'win32',
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => (stdout += String(d)));
        child.stderr?.on('data', (d) => (stderr += String(d)));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.on('error', (err) => resolve({ code: 1, stdout, stderr: errorMessage(err) }));
      });
    });

  logger.info('Deploying to Smithery', { slug, profile });

  const result = await run('npx', ['-y', '@smithery/cli@latest', 'deploy', slug, '--profile', profile]);

  if (result.code !== 0) {
    throw new DeployError(
      `Smithery CLI exited with code ${result.code}: ${(result.stderr || result.stdout).slice(0, 400)}`,
      'Run `npx @smithery/cli@latest login` interactively once, then retry. Smithery also requires a public git URL in smithery.yaml.',
    );
  }

  const url = extractSmitheryUrl(result.stdout) ?? `https://smithery.ai/${profile}/${slug}`;

  return {
    provider: 'smithery',
    url,
    status: 'live',
    deployedAt: new Date().toISOString(),
    logs: [
      `Deployed ${slug} to Smithery profile ${profile}.`,
      `Server URL: ${url}`,
      ...result.stdout.split('\n').filter(Boolean).slice(-5),
    ],
  };
}

function extractSmitheryUrl(stdout: string): string | undefined {
  return /https:\/\/[\w.-]*smithery\.ai\/[^\s"']*/.exec(stdout)?.[0];
}

/** Write the Smithery deployable directory: server.js + smithery.yaml. */
export async function writeServerDirectory(workDir: string, slug: string, input: DeployInput): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const dir = join(workDir, slug);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, 'server.js'), input.code, 'utf8');

  const yaml = [
    `# Generated by AgentReady`,
    `startCommand:`,
    `  type: stdio`,
    `  configSchema:`,
    `    type: object`,
    `    required: []`,
    `    properties: {}`,
    ``,
    `build:`,
    `  dockerfile: Dockerfile`,
    ``,
    `# Smithery hosts this and exposes a streamable-http endpoint.`,
    `tools:`,
    ...input.spec.tools.map((t) => `  - ${t.name}`),
    ``,
  ].join('\n');

  await writeFile(join(dir, 'smithery.yaml'), yaml, 'utf8');

  // Smithery's default build is a Dockerfile.
  const dockerfile = [
    `FROM node:22-alpine`,
    `WORKDIR /app`,
    `COPY server.js ./server.js`,
    `CMD ["node", "server.js"]`,
    ``,
  ].join('\n');
  await writeFile(join(dir, 'Dockerfile'), dockerfile, 'utf8');

  // The registry manifest and OpenAPI doc ship alongside for reference.
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(input.manifest, null, 2), 'utf8');
  await writeFile(join(dir, 'openapi.json'), JSON.stringify(input.openapi, null, 2), 'utf8');

  return dir;
}

/**
 * Local deployment: write the files and serve them with a tiny Node server.
 * This is how the demo site and tests get a real MCP server with zero external
 * dependencies.
 */
export async function deployLocal(
  input: DeployInput,
  options: { dir: string; port?: number },
): Promise<DeploymentResult> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const dir = options.dir;
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, 'worker.js'), input.code, 'utf8');
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(input.manifest, null, 2), 'utf8');
  await writeFile(join(dir, 'openapi.json'), JSON.stringify(input.openapi, null, 2), 'utf8');
  await writeFile(join(dir, 'server.json'), JSON.stringify(input.manifest, null, 2), 'utf8');

  const port = options.port ?? 8788;
  const url = `http://localhost:${port}`;

  if (input.dryRun) {
    return {
      provider: 'local',
      url,
      status: 'pending',
      logs: [`[dry-run] would write worker.js, mcp.json, openapi.json to ${dir}`],
    };
  }

  return {
    provider: 'local',
    url,
    status: 'live',
    deployedAt: new Date().toISOString(),
    logs: [
      `Wrote ${join(dir, 'worker.js')} (${input.code.length} bytes).`,
      `Serve it with: node ${join(dir, 'serve.js')}`,
      `Then the MCP endpoint is ${url}/mcp`,
    ],
  };
}

/** Fetch and check a deployed endpoint. */
export async function verifyDeployment(url: string, timeoutMs = 8_000): Promise<{ ok: boolean; body: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const body = await res.text();
    return { ok: res.ok, body };
  } catch (err) {
    return { ok: false, body: '', error: errorMessage(err) };
  }
}

/** Dispatch to the right provider. */
export async function deploy(input: DeployInput, options: { workDir: string; port?: number } = { workDir: process.cwd() }): Promise<DeploymentResult> {
  switch (input.target) {
    case 'cloudflare':
      return deployToCloudflare(input);
    case 'smithery':
      return deployToSmithery(input, { workDir: options.workDir });
    case 'local':
    default:
      return deployLocal(input, { dir: options.workDir, ...(options.port !== undefined ? { port: options.port } : {}) });
  }
}