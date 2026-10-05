/**
 * Registry orchestration and monitoring.
 *
 * `publishToAll` fans out across the three registries, never letting one
 * failure hide the others — a rejected Official manifest should not stop the
 * Smithery submission. `checkRegistryStatus` is the read side, used by the
 * dashboard and the monitor.
 */

import type { RegistryName, RegistryStatus, RegistrySubmission, RegistryTarget } from '@agentready/shared';
import { newId } from '@agentready/shared';
import { submitToOfficialRegistry, fetchOfficialEntry, OFFICIAL_TARGET } from './official.js';
import { submitToSmithery, fetchSmitheryStatus, smitheryServerUrl, SMITHERY_TARGET } from './smithery.js';
import { submitToMcpSo, checkMcpSoListing, MCP_SO_TARGET } from './mcp-so.js';

/** Every registry we support, in the order we recommend submitting. */
export const REGISTRY_TARGETS: RegistryTarget[] = [OFFICIAL_TARGET, SMITHERY_TARGET, MCP_SO_TARGET];

export const REGISTRY_NAMES: RegistryName[] = ['official', 'smithery', 'mcp-so'];

/** Is this a registry name we know about? */
export function isRegistryName(value: string): value is RegistryName {
  return (REGISTRY_NAMES as string[]).includes(value);
}

export interface PublishInput {
  /** The `server.json` manifest (Official / Smithery). */
  manifest: Record<string, unknown>;
  /** Public streamable-http endpoint. */
  serverUrl: string;
  /** Which registries to hit. Defaults to all three. */
  targets?: RegistryName[];
  dryRun?: boolean;
  siteUrl?: string;
  toolNames?: string[];
  /** Per-registry credentials, falling back to config when absent. */
  tokens?: { official?: string; officialGithub?: string; smithery?: string; mcpSo?: string };
  profile?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface PublishResult {
  submissions: RegistrySubmission[];
  /** Registries where the server is live now. */
  live: RegistryName[];
  /** Registries still waiting on a manual step. */
  pending: RegistryName[];
  failed: RegistryName[];
  publishedAt: string;
}

/**
 * Submit a server to every requested registry concurrently.
 *
 * Registries are independent, so this runs in parallel; each result is
 * reported verbatim.
 */
export async function publishToAll(input: PublishInput): Promise<PublishResult> {
  const targets = input.targets ?? REGISTRY_NAMES;
  const serverName = String(input.manifest['name'] ?? 'unknown');
  const description = String(input.manifest['description'] ?? 'MCP server');
  const toolNames = input.toolNames ?? extractToolNames(input.manifest);

  const tasks: Array<Promise<RegistrySubmission>> = [];

  for (const target of targets) {
    if (target === 'official') {
      tasks.push(
        submitToOfficialRegistry({
          manifest: input.manifest,
          serverUrl: input.serverUrl,
          ...(input.dryRun ? { dryRun: true } : {}),
          ...(input.tokens?.official ? { token: input.tokens.official } : {}),
          ...(input.tokens?.officialGithub ? { githubToken: input.tokens.officialGithub } : {}),
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
    } else if (target === 'smithery') {
      tasks.push(
        submitToSmithery({
          serverName,
          description,
          serverUrl: input.serverUrl,
          toolNames,
          ...(input.profile ? { profile: input.profile } : {}),
          ...(input.tokens?.smithery ? { apiKey: input.tokens.smithery } : {}),
          ...(input.dryRun ? { dryRun: true } : {}),
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
    } else if (target === 'mcp-so') {
      tasks.push(
        submitToMcpSo({
          serverName,
          description,
          serverUrl: input.serverUrl,
          toolNames,
          ...(input.siteUrl ? { homepage: input.siteUrl } : {}),
          ...(input.tokens?.mcpSo ? { apiKey: input.tokens.mcpSo } : {}),
          ...(input.dryRun ? { dryRun: true } : {}),
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
    }
  }

  const settled = await Promise.all(tasks);
  const submissions = settled.filter(Boolean);

  return {
    submissions,
    live: submissions.filter((s) => s.status === 'submitted' || s.status === 'live').map((s): RegistryName => s.name),
    pending: submissions.filter((s) => s.status === 'pending' || s.status === 'dry-run').map((s): RegistryName => s.name),
    failed: submissions.filter((s) => s.status === 'error' || s.status === 'rejected').map((s): RegistryName => s.name),
    publishedAt: new Date().toISOString(),
  };
}

function extractToolNames(manifest: Record<string, unknown>): string[] {
  const tools = manifest['tools'];
  if (Array.isArray(tools)) {
    return tools.map((t) => (typeof t === 'string' ? t : String((t as { name?: unknown })?.name ?? ''))).filter(Boolean);
  }
  return [];
}

/**
 * Check whether a server is listed and current in each registry.
 *
 * `drifted` means listed, but at a different version than we expect — the
 * state that quietly breaks agent integrations.
 */
export async function checkRegistryStatus(input: {
  serverName: string;
  /** Version we believe is published. */
  expectedVersion?: string;
  targets?: RegistryName[];
  profile?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<RegistryStatus[]> {
  const targets = input.targets ?? REGISTRY_NAMES;
  const results: RegistryStatus[] = [];

  await Promise.all(
    targets.map(async (name) => {
      const checkedAt = new Date().toISOString();

      if (name === 'official') {
        const entry = await fetchOfficialEntry(input.serverName, {
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!entry) {
          results.push({
            name,
            label: OFFICIAL_TARGET.label,
            state: 'missing',
            listed: false,
            lastChecked: checkedAt,
            detail: 'not found in the official registry',
          });
          return;
        }
        const version = extractVersion(entry);
        const state = version && input.expectedVersion && version !== input.expectedVersion ? 'drifted' : 'synced';
        results.push({
          name,
          label: OFFICIAL_TARGET.label,
          state,
          listed: true,
          ...(version ? { version } : {}),
          lastChecked: checkedAt,
          detail: state === 'drifted' ? `registry has ${version}, expected ${input.expectedVersion}` : 'listed',
        });
        return;
      }

      if (name === 'smithery') {
        const status = await fetchSmitheryStatus(input.profile ?? 'agentready', input.serverName, {
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        results.push({
          name,
          label: SMITHERY_TARGET.label,
          state: status.deployed ? 'synced' : 'missing',
          listed: status.deployed,
          url: smitheryServerUrl(input.profile ?? 'agentready', input.serverName),
          lastChecked: checkedAt,
          detail: status.detail,
        });
        return;
      }

      const listing = await checkMcpSoListing(input.serverName, {
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      results.push({
        name,
        label: MCP_SO_TARGET.label,
        state: listing.listed ? 'synced' : 'missing',
        listed: listing.listed,
        ...(listing.url ? { url: listing.url } : {}),
        lastChecked: checkedAt,
        detail: listing.detail,
      });
    }),
  );

  return results.sort((a, b) => REGISTRY_NAMES.indexOf(a.name) - REGISTRY_NAMES.indexOf(b.name));
}

/**
 * Pull the published version out of an official registry entry.
 * Shape: { server: { name, version, ... }, _meta: { ...official: { isLatest } } }
 */
function extractVersion(entry: Record<string, unknown>): string | undefined {
  const server = entry['server'] as { version?: string; packages?: Array<{ version?: string }> } | undefined;
  if (server?.version) return server.version;
  return server?.packages?.[0]?.version;
}

/** Find a server across all three registries at once. */
export async function discoverServer(serverName: string, opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}) {
  const statuses = await checkRegistryStatus({ serverName, ...opts });
  return {
    serverName,
    registries: statuses,
    listedIn: statuses.filter((s) => s.listed).map((s) => s.name),
  };
}

/** A stable submission id for idempotent retries. */
export function submissionId(): string {
  return newId('sub');
}