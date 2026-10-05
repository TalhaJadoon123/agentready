/**
 * MCP server manifest generation.
 *
 * Two formats matter:
 *  - `server.json` — the Official MCP Registry publish format
 *    (schema: static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json)
 *  - `/.well-known/mcp.json` — what a client fetches to auto-discover a server
 */

import type { MCPServerSpec } from '@agentready/shared';
import { serverSlug } from '@agentready/shared';
import { PROTOCOL_VERSION } from './generator.js';

/**
 * Resolve the streamable-http endpoint.
 *
 * The caller may pass a server root (https://x.workers.dev) or an endpoint that
 * already includes the path (https://x.workers.dev/mcp). Normalising here is
 * what stops /mcp/mcp from being generated and silently 404ing.
 */
export function mcpEndpoint(publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  return base.endsWith('/mcp') ? base : `${base}/mcp`;
}

/** The official registry's JSON schema URL for server manifests. */
export const SERVER_SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json';

export const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';

/**
 * Build an `server.json` suitable for publishing to the Official MCP Registry.
 */
export function buildRegistryManifest(input: {
  spec: MCPServerSpec;
  /** Public streamable-http endpoint. */
  publicUrl: string;
  /** Where the source code / catalogue lives. */
  siteUrl?: string;
  /** Namespace for the registry; defaults to the server name. */
  namespace?: string;
  description?: string;
  websiteUrl?: string;
  /** Optional integrity hash of the published artifact. */
  sha256?: string;
}): Record<string, unknown> {
  const { spec } = input;
  const namespace = input.namespace ?? serverSlug(spec.name);
  const mcpUrl = mcpEndpoint(input.publicUrl);

  const manifest: Record<string, unknown> = {
    $schema: SERVER_SCHEMA_URL,
    name: namespace,
    description: input.description ?? spec.description,
    version: spec.version,
    repository: {
      url: input.siteUrl ?? `https://github.com/${namespace}/mcp-server`,
      source: input.siteUrl ? 'website' : 'github',
      ...(input.sha256 ? { id: `sha256:${input.sha256}` } : {}),
    },
    packages: [
      {
        // The official name for a remote-first, publisher-managed server.
        registryType: 'mcp-publisher',
        registryBaseUrl: REGISTRY_BASE_URL,
        identifier: {
          name: namespace,
          version: spec.version,
        },
        version: spec.version,
        transport: {
          type: 'streamable-http',
          url: mcpUrl,
        },
        ...(input.websiteUrl ? { runtimeHint: input.websiteUrl } : {}),
      },
    ],
    remotes: [
      {
        type: 'streamable-http',
        url: mcpUrl,
        ...(input.siteUrl ? { websiteUrl: input.siteUrl } : {}),
      },
    ],
  };

  return manifest;
}

/**
 * Build the `/.well-known/mcp.json` discovery document a client fetches.
 *
 * This is the `mcpServers` map form used by the de-facto client config
 * convention, so pasting this URL into a client config just works.
 */
export function buildMcpManifest(input: { spec: MCPServerSpec; publicUrl: string; siteUrl?: string }): Record<string, unknown> {
  const { spec } = input;
  const slug = serverSlug(spec.name);
  const mcpUrl = mcpEndpoint(input.publicUrl);

  return {
    $schema: SERVER_SCHEMA_URL,
    name: `${slug}-mcp`,
    description: spec.description,
    version: spec.version,
    protocolVersion: PROTOCOL_VERSION,
    ...(input.siteUrl ? { websiteUrl: input.siteUrl } : {}),
    mcpServers: {
      [slug]: {
        type: 'http',
        url: mcpUrl,
        ...(input.siteUrl ? { websiteUrl: input.siteUrl } : {}),
      },
    },
    remotes: [{ type: 'streamable-http', url: mcpUrl }],
    tools: spec.tools.map((t) => ({ name: t.name, description: t.description })),
  };
}

/** The tool list in the shape `tools/list` returns, for registries that index it. */
export function buildToolsList(spec: MCPServerSpec): Record<string, unknown> {
  return {
    tools: spec.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  };
}

/**
 * Validate a registry manifest before we submit it.
 * The registry rejects on most of these, so catching them locally saves a
 * round trip and a confusing rejection email.
 */
export function validateManifest(manifest: Record<string, unknown>): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof manifest['name'] !== 'string' || !manifest['name']) {
    errors.push('name is required and must be a non-empty string');
  } else if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest['name'] as string)) {
    errors.push(`name "${String(manifest['name'])}" must be lowercase alphanumeric with hyphens, max 64 chars`);
  }

  if (typeof manifest['version'] !== 'string' || !manifest['version']) {
    errors.push('version is required');
  } else if (!/^\d+\.\d+\.\d+/.test(manifest['version'] as string)) {
    errors.push(`version "${String(manifest['version'])}" must be semver (x.y.z)`);
  }

  if (manifest['description'] !== undefined) {
    const d = String(manifest['description']);
    if (d.length > 500) errors.push('description exceeds 500 characters');
    if (d.length < 10) warnings.push('description is very short — registries and clients show this to humans');
  }

  const repo = manifest['repository'] as Record<string, unknown> | undefined;
  if (!repo || typeof repo.url !== 'string') {
    errors.push('repository.url is required');
  } else if (!/^https?:\/\//.test(repo.url)) {
    errors.push('repository.url must be an absolute http(s) URL');
  }

  const packages = manifest['packages'];
  if (!Array.isArray(packages) || packages.length === 0) {
    errors.push('packages must be a non-empty array');
  } else {
    const pkg = packages[0] as Record<string, unknown>;
    if (typeof pkg?.['registryBaseUrl'] !== 'string') errors.push('packages[0].registryBaseUrl is required');
    if (!pkg?.['identifier']) errors.push('packages[0].identifier is required');
    const transport = pkg?.['transport'] as Record<string, unknown> | undefined;
    if (!transport || typeof transport.url !== 'string') {
      errors.push('packages[0].transport.url is required for remote servers');
    } else if (!/^https?:\/\//.test(transport.url)) {
      errors.push('packages[0].transport.url must be absolute');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}