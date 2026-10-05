/**
 * Pillar 6 — Transactability.
 *
 * Can an agent actually complete a purchase? We look for a documented order
 * endpoint (JSON API / OpenAPI), cart or checkout affordances, schema.org
 * `potentialAction`/`Order` support, and — critically — an MCP `place_order`
 * tool, which is the only path where an agent closes the loop without a human.
 */

import { buildResult } from './base.js';
import type { ScanContext } from '../context.js';
import { commerceToolCoverage } from '../mcp-probe.js';

export async function checkTransactability(ctx: ScanContext) {
  const { page } = ctx;

  const openApi =
    ctx.wellKnown['/.well-known/openapi.json'] ?? ctx.wellKnown['/openapi.json'] ?? ctx.wellKnown['/api/openapi.json'];
  const hasOpenApi = Boolean(openApi?.ok);

  let orderEndpoints: string[] = [];
  if (hasOpenApi && openApi?.body) {
    try {
      const spec = JSON.parse(openApi.body) as { paths?: Record<string, unknown> };
      orderEndpoints = Object.keys(spec.paths ?? {}).filter((p) => /order|checkout|cart|purchase|payment/i.test(p));
    } catch {
      orderEndpoints = [];
    }
  }

  const hasCart = page.hasAddToCart || page.links.some((l) => /\/cart|\/checkout|\/basket/i.test(l.href));
  const hasCheckoutLink = page.links.some((l) => /\/checkout/i.test(l.href));

  // schema.org purchase affordances.
  const actionNodes = page.jsonLd.filter(
    (n) => n['potentialAction'] !== undefined || /order|cart|checkout|buy/i.test(String(n['@type'] ?? '')),
  );
  const hasOfferLink = page.jsonLd.some((n) => typeof n['url'] === 'string' && /cart|checkout|order/i.test(String(n['url'])));
  const supportsOrder = page.jsonLd.some((n) => /order/i.test(String(n['@type'] ?? '')));

  // The MCP path: a place_order tool is worth more than every other signal here.
  const coverage = commerceToolCoverage(ctx.mcp.tools);
  const hasPlaceOrder = coverage.includes('place_order');
  const mcpTools = ctx.mcp.status === 'live' ? ctx.mcp.tools.map((t) => t.name) : [];

  // Points: 4 place_order via MCP, 2 order API in OpenAPI, 2 schema action/url,
  //         2 cart affordance, 2 checkout link.
  let points = 0;
  points += hasPlaceOrder ? 4 : 0;
  points += orderEndpoints.length > 0 ? 2 : 0;
  points += (supportsOrder || actionNodes.length > 0 ? 1 : 0) + (hasOfferLink ? 1 : 0);
  points += hasCart ? 2 : 0;
  points += hasCheckoutLink ? 2 : 0;

  const status = hasPlaceOrder ? 'pass' : orderEndpoints.length > 0 || hasCart ? 'warn' : 'fail';

  const fixes: string[] = [];
  if (!hasPlaceOrder) {
    fixes.push('Generate an MCP server with a `place_order` tool — this is how an agent completes a purchase without a human in the loop.');
  }
  if (orderEndpoints.length === 0) {
    fixes.push('Publish an OpenAPI document at /.well-known/openapi.json describing your order/checkout endpoints.');
  }
  if (!hasCart) fixes.push('Expose a cart or add-to-order endpoint agents can reach.');
  if (!hasCheckoutLink) fixes.push('Link a machine-reachable /checkout route.');
  if (!supportsOrder && actionNodes.length === 0) {
    fixes.push('Add schema.org potentialAction (OrderAction / BuyAction) to your Product nodes.');
  }

  const summary = hasPlaceOrder
    ? `Agents can transact end to end via MCP (${coverage.join(', ')}).`
    : orderEndpoints.length > 0
      ? `Documented order endpoints (${orderEndpoints.slice(0, 3).join(', ')}) but no MCP place_order tool.`
      : 'No machine path to completing a purchase. Agents can only send humans to your website.';

  return buildResult(
    'transactability',
    status,
    points,
    summary,
    fixes,
    {
      hasOpenApi,
      openApiStatus: openApi?.status ?? null,
      orderEndpoints: orderEndpoints.slice(0, 10),
      hasCart,
      hasCheckoutLink,
      schemaActions: actionNodes.length,
      supportsOrder,
      mcpPlaceOrder: hasPlaceOrder,
      mcpTools,
    },
  );
}