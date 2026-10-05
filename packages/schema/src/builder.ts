/**
 * Compose a single deployable JSON-LD document from the pieces a user
 * provides. One @graph beats many separate script tags: agents parse one
 * document and resolve @id references across it.
 */

import type { LocalBusiness, Organization, Product, Service } from '@agentready/shared';
import { graphDocument } from './generate.js';
import { generateProduct, generateBreadcrumbs, generateItemList } from './product.js';
import { generateService } from './service.js';
import { generateOrganization, generateWebSite, generateFaqPage } from './organization.js';
import { generateLocalBusiness } from './local-business.js';

export interface SchemaBuildInput {
  organization?: Organization;
  website?: { name: string; url: string; description?: string; searchUrlTemplate?: string };
  products?: Product[];
  services?: Service[];
  localBusiness?: LocalBusiness;
  faq?: Array<{ question: string; answer: string }>;
  breadcrumbs?: Array<{ name: string; url: string }>;
  itemList?: { name: string; products: Product[] };
  siteUrl?: string;
}

export interface SchemaBuildResult {
  document: Record<string, unknown>;
  /** How many nodes the graph contains. */
  nodeCount: number;
  /** Per-type breakdown, handy for the dashboard. */
  types: Record<string, number>;
  /** Nodes we deliberately dropped because they lacked required fields. */
  skipped: Array<{ type: string; reason: string; id?: string }>;
}

/** Build the full JSON-LD @graph for a site. */
export function buildSchema(input: SchemaBuildInput): SchemaBuildResult {
  const nodes: Record<string, unknown>[] = [];
  const skipped: SchemaBuildResult['skipped'] = [];
  const siteUrl = input.siteUrl ?? input.organization?.url ?? input.website?.url;

  if (input.organization) {
    nodes.push(generateOrganization(input.organization));
  }

  if (input.website) {
    const website = generateWebSite({
      ...input.website,
      ...(input.organization ? { publisherId: `${input.organization.url.replace(/\/$/, '')}/#organization` } : {}),
    });
    nodes.push(website);
  }

  if (input.localBusiness) {
    nodes.push(generateLocalBusiness(input.localBusiness, siteUrl));
  }

  for (const product of input.products ?? []) {
    // A Product with no resolvable price is noise — the Offer would be absent
    // and agents treat the product as unbuyable anyway.
    if (product.price === undefined || Number.isNaN(Number(product.price))) {
      skipped.push({ type: 'Product', reason: 'missing or unparsable price', id: product.id });
      continue;
    }
    if (!product.name?.trim()) {
      skipped.push({ type: 'Product', reason: 'missing name', id: product.id });
      continue;
    }
    nodes.push(generateProduct(product, siteUrl ? { siteUrl } : {}));
  }

  for (const service of input.services ?? []) {
    if (!service.name?.trim() || !service.provider?.trim()) {
      skipped.push({ type: 'Service', reason: 'missing name or provider', id: service.name });
      continue;
    }
    nodes.push(generateService(service, siteUrl ? { siteUrl } : {}));
  }

  if (input.faq?.length) nodes.push(generateFaqPage(input.faq));
  if (input.breadcrumbs?.length) nodes.push(generateBreadcrumbs(input.breadcrumbs));
  if (input.itemList?.products?.length) {
    nodes.push(
      generateItemList(input.itemList.products, {
        name: input.itemList.name,
        ...(siteUrl ? { siteUrl } : {}),
      }),
    );
  }

  const types: Record<string, number> = {};
  for (const node of nodes) {
    const t = String(node['@type'] ?? 'unknown');
    types[t] = (types[t] ?? 0) + 1;
  }

  return { document: graphDocument(nodes), nodeCount: nodes.length, types, skipped };
}

/** Convenience: build and immediately serialize to a `<script>` block. */
export function buildSchemaScript(input: SchemaBuildInput, pretty = true): string {
  const { document } = buildSchema(input);
  const json = pretty ? JSON.stringify(document, null, 2) : JSON.stringify(document);
  return `<script type="application/ld+json">\n${json.replace(/<\//g, '<\\/')}\n</script>`;
}