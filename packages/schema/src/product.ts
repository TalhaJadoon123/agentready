/** Product JSON-LD generation. */

import type { Product } from '@agentready/shared';
import { productNode, type NodeOptions } from './generate.js';

export { productNode as buildProduct };

/** Product node with its Offer nested. */
export function generateProduct(product: Product, opts: NodeOptions = {}): Record<string, unknown> {
  return productNode(product, opts);
}

/**
 * A ProductList for category/collection pages.
 * `itemListElement` order is the ranking order — agents respect it.
 */
export function generateItemList(products: Product[], opts: NodeOptions & { name?: string } = {}): Record<string, unknown> {
  return {
    '@type': 'ItemList',
    ...(opts.name ? { name: opts.name } : {}),
    numberOfItems: products.length,
    itemListElement: products.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: productNode(p, opts),
    })),
  };
}

/** BreadcrumbList, so an agent can reconstruct site structure. */
export function generateBreadcrumbs(trail: Array<{ name: string; url: string }>): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };
}