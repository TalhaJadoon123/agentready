/**
 * OpenAPI 3.1 generation for the generated MCP server.
 *
 * Two audiences: the `transactability` check (which looks for order/checkout
 * paths here) and human developers who would rather read a REST doc than call
 * an MCP tool. Both get served from the same worker.
 */

import type { MCPServerSpec, MCPTool } from '@agentready/shared';
import { serverSlug } from '@agentready/shared';
import { mcpEndpoint } from './manifest.js';

export interface OpenApiOptions {
  spec: MCPServerSpec;
  publicUrl: string;
  siteUrl?: string;
  /** Contact for the API's Info block. */
  contactEmail?: string;
}

/** Convert an MCP tool input schema into OpenAPI-compatible parameter specs. */
export function inputSchemaToParameters(tool: MCPTool): Array<Record<string, unknown>> {
  const schema = tool.inputSchema ?? {};
  const properties = (schema['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    in: name === 'items' || name === 'ids' ? 'query' : 'query',
    required: required.includes(name),
    description: String(prop['description'] ?? ''),
    schema: {
      type: prop['type'] ?? 'string',
      ...(prop['type'] === 'array'
        ? { items: (prop['items'] as Record<string, unknown>) ?? { type: 'string' } }
        : {}),
      ...(prop['type'] === 'boolean' ? { default: false } : {}),
    },
  }));
}

/** Build the full OpenAPI document. */
export function buildOpenApiSpec(options: OpenApiOptions): Record<string, unknown> {
  const { spec } = options;
  const base = options.publicUrl.replace(/\/$/, '');
  const slug = serverSlug(spec.name);

  const paths: Record<string, unknown> = {
    '/health': {
      get: {
        summary: 'Liveness and catalogue size',
        operationId: 'health',
        tags: ['meta'],
        responses: {
          '200': {
            description: 'Server is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    server: { type: 'object' },
                    products: { type: 'integer' },
                    tools: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },

    // The MCP endpoint itself, documented as a JSON-RPC POST so that generic
    // OpenAPI clients can find it.
    '/mcp': {
      post: {
        summary: 'MCP JSON-RPC endpoint',
        description: 'Send MCP JSON-RPC 2.0 requests. See https://modelcontextprotocol.io for the protocol.',
        operationId: 'mcpRpc',
        tags: ['mcp'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  jsonrpc: { type: 'string', enum: ['2.0'] },
                  id: { type: ['integer', 'string', 'null'] },
                  method: { type: 'string', example: 'tools/list' },
                  params: { type: 'object' },
                },
                required: ['jsonrpc', 'method'],
              },
            },
          },
        },
        responses: { '200': { description: 'JSON-RPC response or batch' } },
      },
    },
  };

  // REST mirrors of the read tools, so a plain HTTP client can query the catalogue.
  const restMirrors: Array<{ toolName: string; path: string; opId: string; summary: string }> = [
    { toolName: 'search_products', path: '/products', opId: 'searchProducts', summary: 'Search the product catalogue' },
    { toolName: 'get_product', path: '/products/{id}', opId: 'getProduct', summary: 'Get one product by id or SKU' },
    { toolName: 'check_availability', path: '/availability', opId: 'checkAvailability', summary: 'Check availability for one or more products' },
    { toolName: 'get_pricing', path: '/pricing', opId: 'getPricing', summary: 'Get pricing for a product or the whole catalogue' },
    { toolName: 'place_order', path: '/orders', opId: 'placeOrder', summary: 'Place an order' },
  ];

  for (const mirror of restMirrors) {
    const tool = spec.tools.find((t) => t.name === mirror.toolName);
    if (!tool) continue;

    const isOrder = mirror.toolName === 'place_order';
    const parameters = inputSchemaToParameters(tool);

    paths[mirror.path] = {
      ...(isOrder ? {} : { get: restOperation(tool, mirror, parameters) }),
      ...(isOrder ? { post: restOperation(tool, mirror, [], true) } : {}),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${spec.name} API`,
      version: spec.version,
      description: spec.description,
      ...(options.siteUrl ? { ...({ 'x-website': options.siteUrl } as Record<string, unknown>) } : {}),
      ...(options.contactEmail ? { contact: { email: options.contactEmail } } : {}),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: base, description: slug }],
    tags: [
      { name: 'catalogue', description: 'Product discovery and detail' },
      { name: 'commerce', description: 'Pricing, availability and orders' },
      { name: 'mcp', description: 'Model Context Protocol JSON-RPC' },
      { name: 'meta', description: 'Service metadata' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
      schemas: {
        Product: {
          type: 'object',
          required: ['id', 'name', 'price', 'currency', 'availability'],
          properties: {
            id: { type: 'string' },
            sku: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            brand: { type: 'string' },
            category: { type: 'string' },
            price: { type: 'number', description: 'Price in the `currency` denomination.' },
            currency: { type: 'string', example: 'USD' },
            availability: {
              type: 'string',
              enum: ['InStock', 'OutOfStock', 'PreOrder', 'BackOrder', 'Discontinued'],
            },
            url: { type: 'string', format: 'uri' },
            image: { type: 'string', format: 'uri' },
          },
        },
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, available_ids: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    'x-mcp': {
      protocolVersion: '2025-06-18',
      tools: spec.tools.map((t) => ({ name: t.name, description: t.description })),
    },
  };
}

function restOperation(
  tool: MCPTool,
  mirror: { opId: string; summary: string; toolName: string },
  parameters: Array<Record<string, unknown>>,
  isOrder = false,
): Record<string, unknown> {
  const tags = mirror.toolName.includes('pricing') || mirror.toolName.includes('order') || mirror.toolName.includes('availability')
    ? ['commerce']
    : ['catalogue'];

  const operation: Record<string, unknown> = {
    summary: mirror.summary,
    description: tool.description,
    operationId: mirror.opId,
    tags,
    parameters,
    responses: {
      '200': {
        description: 'Tool result',
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: true },
            example: isOrder
              ? { order_id: 'ord_abc123', status: 'pending_payment', total: 129.0, currency: 'USD', payment_url: null }
              : { products: [], returned: 0, total_matches: 0 },
          },
        },
      },
      '400': {
        description: 'Invalid request',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      '429': {
        description: 'Rate limit exceeded. Poll clients should honour `Retry-After`.',
        headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before retrying.' } },
      },
    },
  };

  if (isOrder) {
    operation['requestBody'] = {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['items', 'customer_email'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'quantity'],
                  properties: { id: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
                },
              },
              customer_email: { type: 'string', format: 'email' },
              shipping_address: { type: 'string' },
              notes: { type: 'string' },
            },
          },
        },
      },
    };
  }

  return operation;
}

/** Convert an MCP server into an OpenAPI path item keyed by tool name. */
export function toolToOpenApiOperation(tool: MCPTool): Record<string, unknown> {
  return {
    summary: tool.description.split('.')[0] ?? tool.name,
    description: tool.description,
    operationId: tool.name,
    tags: ['mcp-tools'],
    parameters: inputSchemaToParameters(tool),
    'x-mcp-tool': tool.name,
    responses: { '200': { description: 'Tool result' } },
  };
}