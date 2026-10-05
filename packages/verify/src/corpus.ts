/**
 * Corpus construction.
 *
 * For each site we build a compact, labelled extract an LLM can answer from:
 * prose summary, JSON-LD products with prices and availability, MCP tool list,
 * and any published API surface. Roughly 6k characters — enough to answer real
 * questions, small enough to stay cheap on the free Groq tier.
 */

import { normalizeUrl, originOf, truncate, parsePrice } from '@agentready/shared';
import { normalizeCurrency } from '@agentready/schema';
import { parsePage, jsonLdTypes, stripTags } from '@agentready/core';
import { probeMcpServer } from '@agentready/core';

export interface CorpusSite {
  name: string;
  url: string;
  content: string;
  signals: Record<string, unknown>;
}

export interface CorpusOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxChars?: number;
}

/** Build the corpus for one site. Never throws — failures produce an empty corpus. */
export async function buildCorpus(site: { url: string; name: string }, options: CorpusOptions = {}): Promise<CorpusSite> {
  const url = normalizeUrl(site.url);
  const name = site.name ?? originOf(url).replace(/^www\./, '');
  const maxChars = options.maxChars ?? 6_000;

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'AgentReady-Sim/1.0 (+https://agentready.dev/bot)',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        name,
        url,
        content: '',
        signals: { error: `HTTP ${res.status}`, productCount: 0, wordCount: 0 },
      };
    }

    const html = await res.text();
    const page = parsePage(html, url);

    // Extract Product nodes with their nested Offers.
    const products = extractProducts(page.jsonLd);
    const org = extractOrganization(page.jsonLd);

    // Probe for MCP in parallel with the parse work.
    const mcp = await probeMcpServer(fetchImpl, originOf(url), 8_000).catch(() => undefined);

    const signals = {
      productCount: products.length,
      hasPrices: products.some((p) => p.price !== undefined),
      hasAvailability: products.some((p) => p.availability !== undefined),
      hasStructuredData: page.jsonLd.length > 0,
      hasMcp: mcp?.status === 'live',
      mcpToolCount: mcp?.tools.length ?? 0,
      wordCount: page.wordCount,
      jsonLdTypes: jsonLdTypes(page.jsonLd),
    };

    const sections: string[] = [];

    if (org) {
      sections.push(`Organization: ${org}\nHomepage title: ${page.title}\nDescription: ${truncate(page.metaDescription || page.text, 240)}`);
    } else {
      sections.push(`Homepage title: ${page.title}\nDescription: ${truncate(page.metaDescription || page.text, 240)}`);
    }

    if (products.length > 0) {
      const lines = products.slice(0, 15).map((p) => {
        const bits = [`- ${p.name}`];
        if (p.price !== undefined) bits.push(`price ${p.currency} ${p.price}`);
        if (p.availability) bits.push(p.availability);
        if (p.sku) bits.push(`sku ${p.sku}`);
        if (p.brand) bits.push(`brand ${p.brand}`);
        if (p.category) bits.push(`category ${p.category}`);
        if (p.url) bits.push(p.url);
        if (p.description) bits.push(`— ${truncate(p.description, 140)}`);
        return bits.join(' ');
      });
      sections.push(`Products (${products.length} total):\n${lines.join('\n')}`);
    }

    if (mcp?.status === 'live' && mcp.tools.length > 0) {
      sections.push(
        `MCP server available at ${mcp.url} with tools: ${mcp.tools.map((t) => t.name).join(', ')}`,
      );
    }

    // Visible prose, trimmed — this is what answers qualitative questions.
    const prose = truncate(stripTags(page.text), 1_500);
    if (prose) sections.push(`Page text: ${prose}`);

    let content = sections.join('\n\n');
    if (content.length > maxChars) content = `${content.slice(0, maxChars)}\n[truncated]`;

    return { name, url, content, signals };
  } catch (err) {
    return {
      name,
      url,
      content: '',
      signals: { error: err instanceof Error ? err.message : String(err), productCount: 0, wordCount: 0 },
    };
  } finally {
    clearTimeout(timer);
  }
}

interface CorpusProduct {
  name: string;
  price?: number;
  currency?: string;
  availability?: string;
  sku?: string;
  brand?: string;
  category?: string;
  url?: string;
  description?: string;
}

/** Flatten JSON-LD Product nodes and their Offers into a simple shape. */
export function extractProducts(nodes: Array<Record<string, unknown>>): CorpusProduct[] {
  const out: CorpusProduct[] = [];

  for (const node of nodes) {
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    const isProduct = types.some((t) => typeof t === 'string' && /^(product|productgroup|individualproduct|vehicle|book|softwareapplication)$/i.test(t));
    if (!isProduct) continue;

    const offers = node['offers'];
    const offerList = Array.isArray(offers) ? offers : offers ? [offers] : [];
    const primary = (offerList[0] ?? {}) as Record<string, unknown>;

    const price = parsePrice(primary['price'] ?? primary['lowPrice'] as never);
    const currency = primary['priceCurrency'] ? normalizeCurrency(String(primary['priceCurrency'])) : undefined;

    const availRaw = primary['availability'];
    const availability = availRaw
      ? String(typeof availRaw === 'object' ? (availRaw as { '@id'?: string })['@id'] : availRaw).replace(/^https?:\/\/schema\.org\//i, '')
      : undefined;

    const brandRaw = node['brand'];
    const brand = typeof brandRaw === 'string' ? brandRaw : typeof brandRaw === 'object' && brandRaw ? String((brandRaw as { name?: string }).name ?? '') : undefined;

    out.push({
      name: String(node['name'] ?? 'Unnamed product'),
      ...(price !== undefined ? { price } : {}),
      ...(currency ? { currency } : {}),
      ...(availability ? { availability } : {}),
      ...(node['sku'] ? { sku: String(node['sku']) } : {}),
      ...(brand ? { brand } : {}),
      ...(node['category'] ? { category: String(node['category']) } : {}),
      ...(node['url'] ? { url: String(node['url']) } : {}),
      ...(node['description'] ? { description: String(node['description']) } : {}),
    });
  }

  return out;
}

/** Find the Organization / WebSite name. */
export function extractOrganization(nodes: Array<Record<string, unknown>>): string | undefined {
  for (const node of nodes) {
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some((t) => typeof t === 'string' && /^(organization|website|localbusiness|store|corporation|onlinebusiness)$/i.test(t))) {
      if (node['name']) return String(node['name']);
    }
  }
  return undefined;
}