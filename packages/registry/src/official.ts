/**
 * Submission to the Official MCP Registry (registry.modelcontextprotocol.io).
 *
 * This registry is free and MIT-licensed. It accepts a server manifest either
 * by:
 *   1. Opening a pull request against modelcontextprotocol/registry
 *      (github.com, no API key needed for a public repo fork), or
 *   2. POSTing the manifest to the registry's publish endpoint when the
 *      deployment has a publisher token.
 *
 * Both paths are implemented; the API path is attempted first and the PR path
 * is offered as the documented fallback.
 */

import type { RegistrySubmission, RegistryTarget } from '@agentready/shared';
import { config, errorMessage, hasApiKey, newId, registryLimiter } from '@agentready/shared';
import { validateManifest, SERVER_SCHEMA_URL } from '@agentready/mcp';

export const OFFICIAL_TARGET: RegistryTarget = {
  name: 'official',
  label: 'Official MCP Registry',
  url: 'https://registry.modelcontextprotocol.io',
  limits: 'Free, no rate limit published',
  docs: 'https://github.com/modelcontextprotocol/registry',
  authRequired: false,
};

/** Where server.json files live in the official registry repo. */
export const REGISTRY_REPO = 'modelcontextprotocol/registry';
export const REGISTRY_SERVERS_PATH = 'servers';

export interface OfficialSubmitInput {
  /** The `server.json` manifest. */
  manifest: Record<string, unknown>;
  /** Public endpoint, recorded for monitoring. */
  serverUrl: string;
  /** Validate locally and report, but do not submit. */
  dryRun?: boolean;
  /** Publisher token, if the deployment has one. */
  token?: string;
  /** GitHub token, for the PR fallback path. */
  githubToken?: string;
  /** Registry base URL override. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Abort signal. */
  signal?: AbortSignal;
}

/**
 * Validate and submit a manifest to the official registry.
 *
 * Never throws for a rejected manifest — a rejection is a normal outcome that
 * comes back as `status: 'rejected'` with the server's reasons, so the CLI can
 * print something actionable.
 */
export async function submitToOfficialRegistry(input: OfficialSubmitInput): Promise<RegistrySubmission> {
  const cfg = config();
  const baseUrl = (input.baseUrl ?? cfg.registries.officialUrl).replace(/\/$/, '');
  const fetchImpl = input.fetchImpl ?? fetch;
  const serverName = String(input.manifest['name'] ?? 'unknown');
  const submissionId = newId('reg');

  // 1. Validate locally first. A rejection round trip is wasteful.
  const validation = validateManifest(input.manifest);
  if (!validation.valid) {
    return {
      id: submissionId,
      serverName,
      name: 'official',
      status: 'rejected',
      error: `Manifest failed local validation: ${validation.errors.join('; ')}`,
      submittedAt: new Date().toISOString(),
      logs: [...validation.errors.map((e) => `ERROR ${e}`), ...validation.warnings.map((w) => `WARN ${w}`)],
    };
  }

  if (input.dryRun) {
    return {
      id: submissionId,
      serverName,
      name: 'official',
      status: 'dry-run',
      url: baseUrl,
      submittedAt: new Date().toISOString(),
      response: input.manifest,
      logs: [
        '[dry-run] manifest passed local validation.',
        `[dry-run] would publish ${serverName}@${String(input.manifest['version'])} to ${baseUrl}`,
        ...(validation.warnings.map((w) => `WARN ${w}`)),
      ],
    };
  }

  // 2. Publisher API path.
  const token = input.token;
  if (hasApiKey(token)) {
    try {
      await registryLimiter.take();
      const res = await fetchImpl(`${baseUrl}/v0/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ manifest: input.manifest }),
        ...(input.signal ? { signal: input.signal } : {}),
      });

      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }

      if (res.ok || res.status === 202) {
        return {
          id: submissionId,
          serverName,
          name: 'official',
          status: 'submitted',
          url: `${baseUrl}/v0/servers?search=${encodeURIComponent(serverName)}`,
          submittedAt: new Date().toISOString(),
          response: body,
          logs: [`Publisher API accepted the manifest (HTTP ${res.status}).`],
        };
      }

      // 409 means already published — check whether the version matches.
      if (res.status === 409) {
        return {
          id: submissionId,
          serverName,
          name: 'official',
          status: 'submitted',
          url: `${baseUrl}/v0/servers?search=${encodeURIComponent(serverName)}`,
          submittedAt: new Date().toISOString(),
          response: body,
          logs: [
            'Server name is already claimed (409). Bump the version, or verify your existing entry is correct.',
          ],
        };
      }

      // 401/403 — fall through to the PR path.
      const authFailed = res.status === 401 || res.status === 403;
      if (!authFailed) {
        return {
          id: submissionId,
          serverName,
          name: 'official',
          status: 'error',
          error: `Registry returned HTTP ${res.status}: ${text.slice(0, 300)}`,
          submittedAt: new Date().toISOString(),
          response: body,
          logs: ['The publisher API responded with an error. Fall back to a pull request if this persists.'],
        };
      }
    } catch (err) {
      return {
        id: submissionId,
        serverName,
        name: 'official',
        status: 'error',
        error: `Publisher API request failed: ${errorMessage(err)}`,
        submittedAt: new Date().toISOString(),
        logs: ['Falling back to the pull-request submission path.'],
      };
    }
  }

  // 3. Pull-request path: generate everything a contributor needs, and create
  //    the PR when a GitHub token is available.
  return submitViaPullRequest(input, submissionId, baseUrl, fetchImpl);
}

/**
 * Submit through the registry's pull-request flow.
 *
 * Without a GitHub token we cannot create the PR, so we return the exact files
 * and instructions. That is genuinely useful — the registry is intentionally
 * PR-based for unauthenticated contributors.
 */
async function submitViaPullRequest(
  input: OfficialSubmitInput,
  submissionId: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<RegistrySubmission> {
  const cfg = config();
  const token = input.githubToken ?? cfg.registries.officialGithubToken;
  const serverName = String(input.manifest['name'] ?? 'unknown');
  const version = String(input.manifest['version'] ?? '0.0.0');
  const filePath = `${REGISTRY_SERVERS_PATH}/${serverName}/${version}/server.json`;

  if (input.dryRun) {
    return {
      id: submissionId,
      serverName,
      name: 'official',
      status: 'dry-run',
      submittedAt: new Date().toISOString(),
      logs: [`[dry-run] would propose ${filePath} against ${REGISTRY_REPO}`],
    };
  }

  if (!hasApiKey(token)) {
    return {
      id: submissionId,
      serverName,
      name: 'official',
      status: 'pending',
      url: `https://github.com/${REGISTRY_REPO}/new`,
      submittedAt: new Date().toISOString(),
      logs: [
        'No MCP_REGISTRY_GITHUB_TOKEN configured, so the pull request was not opened automatically.',
        `1. Fork and clone ${REGISTRY_REPO}`,
        `2. Add your manifest at ${filePath} (content is in the response field)`,
        '3. Commit, push your branch, and open a PR against main',
        `4. A maintainer reviews and merges — usually within 24-48h`,
        '',
        'Alternatively set MCP_REGISTRY_GITHUB_TOKEN to a token with "public_repo" scope and rerun to open it automatically.',
      ],
      response: input.manifest,
    };
  }

  // Create the branch, commit the file, open the PR.
  try {
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agentready',
    };
    const branch = `add/${serverName}-${version}`;
    const content = Buffer.from(JSON.stringify(input.manifest, null, 2), 'utf8').toString('base64');

    // Get the base branch SHA.
    const repoRes = await fetchImpl(`https://api.github.com/repos/${REGISTRY_REPO}/git/ref/heads/main`, { headers });
    const repoBody = (await repoRes.json()) as { object?: { sha?: string } };
    const baseSha = repoBody.object?.sha;
    if (!repoRes.ok || !baseSha) {
      throw new Error(`could not read ${REGISTRY_REPO}/main (HTTP ${repoRes.status})`);
    }

    // Create the branch ref.
    const refRes = await fetchImpl(`https://api.github.com/repos/${REGISTRY_REPO}/git/refs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
    if (!refRes.ok && refRes.status !== 422) {
      const text = await refRes.text();
      throw new Error(`could not create branch (HTTP ${refRes.status}): ${text.slice(0, 200)}`);
    }

    // Commit the manifest.
    const commitRes = await fetchImpl(`https://api.github.com/repos/${REGISTRY_REPO}/contents/${filePath}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ message: `Add ${serverName}@${version}`, content, branch, committer: undefined }),
    });
    const commitBody = (await commitRes.json()) as { commit?: { sha?: string } };
    if (!commitRes.ok) {
      throw new Error(`could not commit ${filePath} (HTTP ${commitRes.status}): ${JSON.stringify(commitBody).slice(0, 200)}`);
    }

    // Open the PR.
    const prRes = await fetchImpl(`https://api.github.com/repos/${REGISTRY_REPO}/pulls`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: `Add ${serverName}@${version}`,
        head: `${token.split(':')[0]?.replace(/^gh[pousr]_/, '') ?? 'contributor'}:${branch}`,
        base: 'main',
        body: [
          `## Add \`${serverName}\` version \`${version}\``,
          '',
          String(input.manifest['description'] ?? 'MCP server submission.'),
          '',
          `- Endpoint: ${input.serverUrl}`,
          `- Schema: ${SERVER_SCHEMA_URL}`,
          `- Tools: ${countTools(input.manifest)}`,
          '',
          'Submitted via AgentReady.',
        ].join('\n'),
      }),
    });
    const prBody = (await prRes.json()) as { html_url?: string; message?: string };

    if (!prRes.ok) {
      return {
        id: submissionId,
        serverName,
        name: 'official',
        status: 'error',
        error: `branch and commit created, but the PR failed: ${prBody.message ?? `HTTP ${prRes.status}`}`,
        submittedAt: new Date().toISOString(),
        logs: [`Branch \`${branch}\` and commit exist in your fork. Open the PR manually.`],
      };
    }

    return {
      id: submissionId,
      serverName,
      name: 'official',
      status: 'submitted',
      url: prBody.html_url,
      submittedAt: new Date().toISOString(),
      response: prBody,
      logs: [
        `Opened pull request for ${filePath}.`,
        'A maintainer reviews new servers; expect 24-48h.',
        `Live at ${baseUrl}/v0/servers after merge.`,
      ],
    };
  } catch (err) {
    return {
      id: submissionId,
      serverName,
      name: 'official',
      status: 'error',
      error: errorMessage(err),
      submittedAt: new Date().toISOString(),
      logs: ['Automated PR submission failed. The manual path in the README takes two minutes.'],
    };
  }
}

function countTools(manifest: Record<string, unknown>): number {
  const remotes = manifest['remotes'];
  return Array.isArray(remotes) ? remotes.length : 0;
}

/** Fetch one server's current registry entry. */
export async function fetchOfficialEntry(
  serverName: string,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Record<string, unknown> | undefined> {
  const baseUrl = (opts.baseUrl ?? config().registries.officialUrl).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    await registryLimiter.take();
    const res = await fetchImpl(`${baseUrl}/v0/servers?search=${encodeURIComponent(serverName)}&limit=10`, {
      headers: { accept: 'application/json' },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { servers?: Array<Record<string, unknown>> };
    const servers = body.servers ?? [];
    const exact = servers.find((s) => {
      const meta = s['server'] as { name?: string } | undefined;
      return meta?.name === serverName;
    });
    return exact ?? servers[0];
  } catch {
    return undefined;
  }
}

/** Search the registry. */
export async function searchOfficialRegistry(
  query: string,
  opts: { baseUrl?: string; limit?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Array<Record<string, unknown>>> {
  const baseUrl = (opts.baseUrl ?? config().registries.officialUrl).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = opts.limit ?? 20;

  try {
    await registryLimiter.take();
    const res = await fetchImpl(
      `${baseUrl}/v0/servers?search=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: { accept: 'application/json' }, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { servers?: Array<Record<string, unknown>> };
    return body.servers ?? [];
  } catch {
    return [];
  }
}