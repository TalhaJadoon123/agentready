/**
 * Load records into a canonical Product[] from any of four source kinds.
 *
 * The mapping step is the important part: real catalogues have `Price`,
 * `stock_status`, `Availability` and a dozen other ways of saying the same
 * thing. We normalize aggressively so the generated tools never have to.
 */

import type { DataSource, Product } from '@agentready/shared';
import { normalizeCurrency, normalizeAvailability } from '@agentready/schema';
import { parsePrice } from '@agentready/shared';
import { readFile, fetchText } from './io.js';

/** Default column -> field mapping, applied when the user gives none. */
export const DEFAULT_MAPPING: Record<string, string> = {
  id: 'id',
  name: 'name',
  description: 'description',
  sku: 'sku',
  brand: 'brand',
  category: 'category',
  price: 'price',
  currency: 'currency',
  availability: 'availability',
  image: 'image',
  url: 'url',
  rating: 'rating',
  rating_count: 'rating_count',
  weight: 'weight',
  weight_unit: 'weight_unit',
};

/**
 * RFC 4180 CSV parser. Handles quoted fields, escaped quotes, embedded
 * newlines and commas, plus CRLF. This is the bulk of most user catalogues,
 * so it needs to be right.
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // Ignore; the \n branch handles the row break.
      continue;
    } else {
      field += ch;
    }
  }

  // Trailing row without a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Parse CSV with a header row into objects. */
export function parseCsvObjects(input: string, delimiter = ','): Array<Record<string, string>> {
  const rows = parseCsv(input, delimiter);
  const header = rows[0];
  if (!header) return [];
  const normalizedHeader = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    normalizedHeader.forEach((key, i) => {
      obj[key] = (row[i] ?? '').trim();
    });
    return obj;
  });
}

/** Detect the delimiter from the header line. */
export function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = headerLine.split(c).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

/**
 * Turn a raw record into a Product using a field mapping.
 * Returns undefined when the record cannot produce a buyable product.
 */
export function normalizeProduct(raw: Record<string, unknown>, mapping: Record<string, string> = DEFAULT_MAPPING): Product | undefined {
  // Resolve each canonical field through the mapping, trying several casings.
  const pick = (field: string): unknown => {
    const key = mapping[field] ?? field;
    if (key in raw) return raw[key];
    const lower = key.toLowerCase();
    for (const k of Object.keys(raw)) {
      if (k.toLowerCase().replace(/\s+/g, '_') === lower) return raw[k];
    }
    return undefined;
  };

  const name = String(pick('name') ?? '').trim();
  if (!name) return undefined;

  const price = parsePrice(pick('price') as never);
  const currency = normalizeCurrency(String(pick('currency') ?? 'USD'));

  const rawAvailability = pick('availability');
  const availability = normalizeAvailability(rawAvailability === undefined ? undefined : String(rawAvailability));

  const ratingValue = parsePrice(pick('rating') as never);
  const ratingCountRaw = pick('rating_count');
  const ratingCount = ratingCountRaw === undefined ? undefined : Number(ratingCountRaw);
  const rating =
    ratingValue !== undefined && ratingCount !== undefined && ratingCount > 0
      ? { value: Math.min(5, ratingValue), count: ratingCount }
      : undefined;

  const weight = parsePrice(pick('weight') as never);
  const weightUnit = pick('weight_unit');

  // Everything not consumed by a canonical field is a spec. This is how the
  // generated get_product tool answers "does it have 16GB".
  const consumed = new Set(
    Object.values(mapping).map((v) => String(v).toLowerCase().replace(/\s+/g, '_')),
  );
  const specs: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normKey = key.toLowerCase().replace(/\s+/g, '_');
    if (consumed.has(normKey)) continue;
    if (value === undefined || value === null || value === '') continue;
    specs[key] = typeof value === 'object' ? JSON.stringify(value) : (value as string | number | boolean);
  }

  const image = pick('image');

  return {
    id: String(pick('id') ?? pick('sku') ?? name),
    name,
    description: String(pick('description') ?? '').trim(),
    ...(pick('sku') ? { sku: String(pick('sku')) } : {}),
    ...(pick('brand') ? { brand: String(pick('brand')) } : {}),
    ...(pick('category') ? { category: String(pick('category')) } : {}),
    price: price ?? 0,
    currency,
    availability,
    ...(image ? { image: String(image) } : {}),
    ...(pick('url') ? { url: String(pick('url')) } : {}),
    ...(rating ? { rating } : {}),
    ...(weight !== undefined ? { weight: { value: weight, unit: String(weightUnit ?? 'g') } } : {}),
    ...(Object.keys(specs).length > 0 ? { specs } : {}),
  };
}

/** Flatten arbitrary JSON (array, or object with an array under a key). */
export function flattenJson(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) return input.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // Look for the first array-valued property.
    for (const key of ['products', 'items', 'data', 'results', 'records', 'entries']) {
      if (Array.isArray(obj[key])) {
        return (obj[key] as unknown[]).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
      }
    }
    return [obj];
  }
  return [];
}

/** Pull products out of an HTML fragment using a naive but usable table read. */
export function parseHtmlTable(html: string): Array<Record<string, unknown>> {
  const tableMatch = /<table\b[\s\S]*?<\/table>/i.exec(html);
  const scope = tableMatch ? (tableMatch[0] as string) : html;

  const rows = [...scope.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((m) => {
    const cells = [...(m[0] as string).matchAll(/<(td|th)\b[\s\S]*?<\/\1>/gi)].map((c) =>
      stripTags(c[0] as string),
    );
    return cells;
  });
  if (rows.length === 0) return [];

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows
    .slice(1)
    .filter((r) => r.length > 0)
    .map((row) => {
      const obj: Record<string, unknown> = {};
      header.forEach((key, i) => {
        if (key) obj[key] = row[i] ?? '';
      });
      return obj;
    });
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Load records from any source kind.
 *
 * @param source Where and how the records live.
 * @param options Fetch/read overrides for tests and offline generation.
 */
export async function loadRecords(
  source: DataSource,
  options: {
    fetchImpl?: typeof fetch;
    /** Pre-supplied content, skipping IO entirely. */
    content?: string;
    maxRecords?: number;
  } = {},
): Promise<Product[]> {
  const mapping = { ...DEFAULT_MAPPING, ...source.mapping };
  const maxRecords = options.maxRecords ?? 5000;
  let raw: Array<Record<string, unknown>> = [];

  switch (source.kind) {
    case 'csv': {
      const text = options.content ?? (await readFileOrFetch(source.location, options.fetchImpl));
      if (!text) throw new Error(`Could not read CSV from ${source.location}`);
      const delimiter = String(source.options?.['delimiter'] ?? detectDelimiter(text.split('\n')[0] ?? ','));
      raw = parseCsvObjects(text, delimiter);
      break;
    }

    case 'json': {
      const text = options.content ?? (await readFileOrFetch(source.location, options.fetchImpl));
      if (!text) throw new Error(`Could not read JSON from ${source.location}`);
      raw = flattenJson(JSON.parse(text));
      break;
    }

    case 'api': {
      const url = buildApiUrl(source);
      const text = options.content ?? (await fetchText(url, options.fetchImpl));
      if (!text) throw new Error(`Could not fetch API at ${url}`);
      raw = flattenJson(JSON.parse(text));
      break;
    }

    case 'scrape': {
      const url = String(source.location);
      const text = options.content ?? (await fetchText(url, options.fetchImpl));
      if (!text) throw new Error(`Could not scrape ${url}`);
      raw = parseHtmlTable(text);
      if (raw.length === 0) {
        // No table — fall back to JSON-LD Products, which is the agent-readable
        // case and what we recommend sites publish.
        const jsonLd = extractJsonLdProducts(text);
        if (jsonLd.length > 0) return normalizeAll(jsonLd, mapping, maxRecords);
      }
      break;
    }

    default:
      throw new Error(`Unknown data source kind: ${String((source as { kind: string }).kind)}`);
  }

  return normalizeAll(raw, mapping, maxRecords);
}

function normalizeAll(raw: Array<Record<string, unknown>>, mapping: Record<string, string>, maxRecords: number): Product[] {
  const out: Product[] = [];
  for (const record of raw.slice(0, maxRecords)) {
    const product = normalizeProduct(record, mapping);
    if (product) out.push(product);
  }
  return out;
}

/** Pull Product nodes out of embedded JSON-LD during a scrape. */
function extractJsonLdProducts(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse((m[1] ?? '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, ''));
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { '@graph'?: unknown[] })?.['@graph'])
          ? ((parsed as { '@graph': unknown[] })['@graph'])
          : [parsed];

      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const n = node as Record<string, unknown>;
        const types = Array.isArray(n['@type']) ? n['@type'] : [n['@type']];
        if (types.some((t) => String(t).toLowerCase() === 'product')) {
          // Flatten the nested Offer into top-level columns our mapper expects.
          const offer = (n['offers'] ?? {}) as Record<string, unknown>;
          out.push({ ...n, price: offer['price'], currency: offer['priceCurrency'], availability: offer['availability'], url: offer['url'] ?? n['url'] });
        }
      }
    } catch {
      /* malformed block — skip it */
    }
  }
  return out;
}

/** Build the request URL for an API source, applying query params. */
export function buildApiUrl(source: DataSource): string {
  const url = new URL(source.location);
  const params = (source.options?.['params'] ?? {}) as Record<string, string | number>;
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readFileOrFetch(location: string, fetchImpl?: typeof fetch): Promise<string | undefined> {
  if (/^https?:\/\//i.test(location)) return fetchText(location, fetchImpl);
  try {
    return await readFile(location);
  } catch {
    return undefined;
  }
}