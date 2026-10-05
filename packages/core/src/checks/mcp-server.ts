/**
 * Pillar 2 — MCP server.
 *
 * This is the differentiator: an MCP server turns your site from something an
 * agent *reads* into something an agent *acts on*. We score liveness first,
 * then the commerce tool surface, then discoverability of the endpoint.
 */

import { buildResult, partial } from './base.js';
import type { ScanContext } from '../context.js';
import { commerceToolCoverage, COMMERCE_TOOLS } from '../mcp-probe.js';

export async function checkMcpServer(ctx: ScanContext) {
  const mcp = ctx.mcp;
  const live = mcp.status === 'live';
  const toolNames = mcp.tools.map((t) => t.name);
  const coverage = commerceToolCoverage(mcp.tools);

  // Points: 10 live, 4 documented in .well-known, 6 commerce tool coverage.
  let points = 0;
  if (live) points += 10;
  else if (mcp.url) points += 2; // declared but unreachable still shows intent

  const declaredInWellKnown = Boolean(ctx.wellKnown['/.well-known/mcp.json']?.ok);
  if (declaredInWellKnown) points += 4;

  points += 6 * partial(coverage.length, COMMERCE_TOOLS.length);

  // Every tool must declare an input schema or agents cannot call it reliably.
  const wellFormed = mcp.tools.filter((t) => t.inputSchema && typeof t.inputSchema === 'object').length;
  const schemaRatio = mcp.tools.length > 0 ? wellFormed / mcp.tools.length : 0;

  const status = live && coverage.length >= 3 ? 'pass' : live || mcp.url ? 'warn' : 'fail';

  const fixes: string[] = [];
  if (!live) {
    fixes.push(
      'Generate an MCP server from your catalogue: `agentready generate --source csv --file products.csv`.',
    );
    fixes.push(
      'Deploy it free to Cloudflare Workers or Smithery: `agentready publish --target cloudflare`.',
    );
    fixes.push('Advertise it at https://yourdomain.com/.well-known/mcp.json so agents can auto-discover it.');
  } else {
    if (!declaredInWellKnown) {
      fixes.push('Publish a /.well-known/mcp.json manifest so agents discover your server without configuration.');
    }
    if (coverage.length < COMMERCE_TOOLS.length) {
      const missing = COMMERCE_TOOLS.filter((t) => !coverage.includes(t));
      fixes.push(`Add the missing tool(s): ${missing.join(', ')}.`);
    }
    if (schemaRatio < 1) {
      fixes.push('Every tool needs a JSON Schema for `inputSchema`, otherwise agents guess and fail.');
    }
  }

  const summary = live
    ? `MCP server live at ${mcp.url} with ${mcp.tools.length} tool(s); ${coverage.length}/${COMMERCE_TOOLS.length} commerce tools.`
    : mcp.url
      ? `MCP endpoint declared at ${mcp.url} but it did not respond.`
      : 'No MCP server detected. Agents cannot query your catalogue programmatically.';

  return buildResult(
    'mcp-server',
    status,
    points,
    summary,
    fixes,
    {
      live,
      url: mcp.url,
      toolCount: mcp.tools.length,
      tools: toolNames,
      commerceCoverage: coverage,
      missingCommerceTools: COMMERCE_TOOLS.filter((t) => !coverage.includes(t)).map(String),
      declaredInWellKnown,
      schemaCoverage: Math.round(schemaRatio * 100) / 100,
      latencyMs: mcp.latencyMs,
      transport: mcp.transport,
      error: mcp.error,
    },
  );
}