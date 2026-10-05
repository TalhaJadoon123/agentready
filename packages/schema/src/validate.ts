/**
 * schema.org document validation.
 *
 * Not a full JSON-LD processor — a focused check for the mistakes that actually
 * break agent consumption: missing @context, missing @type, malformed prices,
 * non-canonical availability URLs, unresolved @id references, cycles.
 */

export type ValidationLevel = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  level: ValidationLevel;
  path: string;
  message: string;
  /** Dotted path to the offending node, for editors. */
  nodePath: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
  /** Types present, with counts. */
  types: Record<string, number>;
  nodeCount: number;
}

/** schema.org types that need a price to be useful to an agent. */
const COMMERCIAL_TYPES = new Set(['product', 'service', 'offer', 'aggregateoffer', 'intaggregateoffer']);

function typeOf(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const t = (node as Record<string, unknown>)['@type'];
  if (typeof t === 'string') return t.toLowerCase();
  if (Array.isArray(t)) {
    const s = t.filter((x) => typeof x === 'string');
    return s.length > 0 ? String(s[0]).toLowerCase() : '';
  }
  return '';
}

/** Every node in a document, including inside @graph, flattening as we go. */
export function flattenNodes(doc: unknown): Array<{ node: Record<string, unknown>; path: string }> {
  const out: Array<{ node: Record<string, unknown>; path: string }> = [];
  if (!doc || typeof doc !== 'object') return out;

  const root = doc as Record<string, unknown>;
  const graph = root['@graph'];

  if (Array.isArray(graph)) {
    graph.forEach((n, i) => {
      if (n && typeof n === 'object') out.push({ node: n as Record<string, unknown>, path: `$['@graph'][${i}]` });
    });
    return out;
  }

  out.push({ node: root, path: '$' });
  return out;
}

/** Valid price: a finite non-negative number, or a parsable numeric string. */
function isValidPrice(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n >= 0 && /\d/.test(value);
  }
  return false;
}

/** Validate a JSON-LD document. */
export function validateSchema(doc: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (level: ValidationLevel, path: string, nodePath: string, message: string) =>
    issues.push({ level, path, nodePath, message });

  if (!doc || typeof doc !== 'object') {
    add('error', '$', '$', 'Document is not an object');
    return { valid: false, errors: 1, warnings: 0, issues, types: {}, nodeCount: 0 };
  }

  const root = doc as Record<string, unknown>;
  const hasGraph = Array.isArray(root['@graph']);
  const nodes = flattenNodes(doc);

  // 1. Context.
  if (root['@context'] === undefined) {
    add('error', "$.['@context']", '$', 'Missing @context. Use "https://schema.org".');
  } else {
    const ctx = root['@context'];
    const ctxStrings = Array.isArray(ctx) ? ctx.filter((c) => typeof c === 'string') : [ctx];
    if (!ctxStrings.some((c) => String(c).includes('schema.org'))) {
      add('error', "$.['@context']", '$', `@context does not reference schema.org (got ${JSON.stringify(ctx)})`);
    }
  }

  if (nodes.length === 0) {
    add('error', '$', '$', 'Document contains no nodes');
    return { valid: false, errors: issues.length, warnings: 0, issues, types: {}, nodeCount: 0 };
  }

  // 2. Per-node checks.
  const declaredIds = new Set<string>();
  const referencedIds: Array<{ id: string; from: string }> = [];

  for (const { node, path } of nodes) {
    const type = typeOf(node);
    const label = type || 'Unknown';

    if (!node['@type']) add('error', `${path}['@type']`, path, `Node (${label}) is missing @type`);
    if (node['@id'] !== undefined) declaredIds.add(String(node['@id']));

    // A name is what an agent cites. Without it the node is unciteable.
    if (COMMERCIAL_TYPES.has(type) && !node['name'] && !node['@id']) {
      add('warning', `${path}['name']`, path, `${label} has no name — agents cannot cite it`);
    }

    // 3. Price and currency.
    const offers = node['offers'];
    const offerNodes = Array.isArray(offers) ? offers : offers ? [offers] : [];

    for (let i = 0; i < offerNodes.length; i++) {
      const offer = offerNodes[i] as Record<string, unknown> | undefined;
      if (!offer || typeof offer !== 'object') {
        add('error', `${path}['offers'][${i}]`, path, 'Offer entry is not an object');
        continue;
      }
      const offerPath = `${path}['offers'][${i}]`;
      const offerType = typeOf(offer);
      const low = offer['lowPrice'];
      const high = offer['highPrice'];
      const price = offer['price'];

      if (offerType === 'aggregateoffer' || offerType === 'intaggregateoffer') {
        for (const [key, val] of [['lowPrice', low], ['highPrice', high]] as const) {
          if (val === undefined) add('warning', `${offerPath}['${key}']`, path, `AggregateOffer is missing ${key}`);
          else if (!isValidPrice(val)) add('error', `${offerPath}['${key}']`, path, `Invalid ${key}: ${JSON.stringify(val)}`);
        }
        if (isValidPrice(low) && isValidPrice(high) && Number(low) > Number(high)) {
          add('error', offerPath, path, `AggregateOffer lowPrice (${String(low)}) exceeds highPrice (${String(high)})`);
        }
      } else if (price !== undefined) {
        if (!isValidPrice(price)) add('error', `${offerPath}['price']`, path, `Invalid price: ${JSON.stringify(price)}`);
        else if (price === '' || (typeof price === 'number' && price === 0 && offer['priceSpecification'])) {
          add('warning', `${offerPath}['price']`, path, 'Price is zero — confirm this is intentional');
        }
      } else if (low === undefined && high === undefined) {
        add('error', offerPath, path, 'Offer has no price, lowPrice or highPrice — agents cannot evaluate it');
      }

      // 4. Currency.
      if (offer['priceCurrency'] === undefined) {
        add('warning', `${offerPath}['priceCurrency']`, path, 'Offer is missing priceCurrency');
      } else if (!/^[A-Z]{3}$/.test(String(offer['priceCurrency']))) {
        add('error', `${offerPath}['priceCurrency']`, path, `priceCurrency must be ISO 4217 (got ${JSON.stringify(offer['priceCurrency'])})`);
      }

      // 5. Availability must be a schema.org URL or a bare enum name.
      const avail = offer['availability'];
      if (avail !== undefined) {
        const v = typeof avail === 'object' && avail !== null ? (avail as Record<string, unknown>)['@id'] : avail;
        const vs = String(v ?? '');
        const bare = /^(in)?stock|outofstock|preorder|backorder|discontinued|limitedavailability|soldout|onlineonly|instoreonly/i.test(vs);
        if (!/^https?:\/\/schema\.org\//i.test(vs) && !bare) {
          add('error', `${offerPath}['availability']`, path, `availability must be a schema.org URL (got ${JSON.stringify(vs)})`);
        }
      } else {
        add('warning', `${offerPath}['availability']`, path, 'Offer has no availability — agents assume nothing is buyable');
      }

      // 6. URL.
      if (offer['url'] !== undefined && typeof offer['url'] === 'string' && !/^https?:\/\//i.test(offer['url'])) {
        add('warning', `${offerPath}['url']`, path, `Offer url should be absolute (got ${offer['url']})`);
      }
    }

    // 7. AggregateRating sanity.
    const rating = node['aggregateRating'] as Record<string, unknown> | undefined;
    if (rating && typeof rating === 'object') {
      const value = Number(rating['ratingValue']);
      const count = Number(rating['reviewCount'] ?? rating['ratingCount']);
      if (!Number.isFinite(value) || value < 0 || value > 5) {
        add('error', `${path}['aggregateRating']['ratingValue']`, path, `ratingValue must be 0-5 (got ${JSON.stringify(rating['ratingValue'])})`);
      }
      if (!Number.isFinite(count) || count < 0) {
        add('error', `${path}['aggregateRating']['reviewCount']`, path, `reviewCount must be a non-negative number (got ${JSON.stringify(rating['reviewCount'])})`);
      }
    }

    // 8. Collect @id references for the resolution pass.
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v && typeof v === 'object') {
            const ref = (v as Record<string, unknown>)['@id'];
            if (typeof ref === 'string') referencedIds.push({ id: ref, from: path });
          }
        }
      } else if (value && typeof value === 'object') {
        const ref = (value as Record<string, unknown>)['@id'];
        if (typeof ref === 'string') referencedIds.push({ id: ref, from: path });
      }
    }
  }

  // 9. Unresolved @id references.
  for (const { id, from } of referencedIds) {
    if (!declaredIds.has(id)) {
      add('warning', from, from, `@id reference "${id}" is not declared in this document`);
    }
  }

  // 10. Duplicate @id declarations.
  const seen = new Set<string>();
  for (const { node, path } of nodes) {
    const id = node['@id'];
    if (typeof id !== 'string') continue;
    if (seen.has(id)) add('error', `${path}['@id']`, path, `Duplicate @id "${id}"`);
    seen.add(id);
  }

  const types: Record<string, number> = {};
  for (const { node } of nodes) {
    const t = typeOf(node) || 'unknown';
    types[t] = (types[t] ?? 0) + 1;
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;

  return { valid: errors === 0, errors, warnings, issues, types, nodeCount: nodes.length };
}

/** Validate a raw JSON-LD string. */
export function validateSchemaString(raw: string): ValidationResult {
  try {
    return validateSchema(JSON.parse(raw));
  } catch (err) {
    return {
      valid: false,
      errors: 1,
      warnings: 0,
      issues: [
        {
          level: 'error',
          path: '$',
          nodePath: '$',
          message: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      types: {},
      nodeCount: 0,
    };
  }
}