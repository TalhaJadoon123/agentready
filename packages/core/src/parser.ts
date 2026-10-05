/**
 * HTML parsing without a DOM dependency.
 *
 * We intentionally avoid jsdom/cheerio: a scan must run inside a Cloudflare
 * Worker and a CLI with zero install weight. These regex extractors are good
 * enough for the signals we score, and every consumer treats the output as
 * hints rather than a validated DOM.
 */

import { tryParse } from '@agentready/shared';

export interface JsonLdNode {
  '@context'?: string | string[];
  '@type'?: string | string[];
  '@graph'?: JsonLdNode[];
  [key: string]: unknown;
}

export interface ParsedPage {
  title: string;
  metaDescription: string;
  metaRobots: string;
  lang: string;
  headings: { level: number; text: string }[];
  /** Visible text with scripts/styles/nav noise removed. */
  text: string;
  wordCount: number;
  links: { href: string; text: string; rel?: string }[];
  canonical: string;
  hreflang: { href: string; lang: string }[];
  /** All JSON-LD blocks, @graph flattened. */
  jsonLd: JsonLdNode[];
  /** Meta tags as name/property -> content. */
  meta: Record<string, string>;
  htmlLang?: string;
  /** Elements with explicit itemprop/itemscope/itemtype attributes. */
  microdata: { type: string; properties: Record<string, string> }[];
  hasPricingTable: boolean;
  hasAddToCart: boolean;
  hasLoginForm: boolean;
  hasContactForm: boolean;
  /** Raw counts used by evidence payloads. */
  counts: {
    scripts: number;
    images: number;
    iframes: number;
    forms: number;
    inputs: number;
    tables: number;
    lists: number;
  };
}

/** Strip tags, scripts and styles from an HTML fragment. */
export function stripTags(html: string): string {
  const stripped = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  euro: '€',
  pound: '£',
  yen: '¥',
  rupee: '₨',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Extract every `application/ld+json` script and flatten `@graph`. */
export function extractJsonLd(html: string): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] ?? '').trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    if (!raw) continue;
    const parsed = tryParse<JsonLdNode | JsonLdNode[] | null>(raw, null);
    if (!parsed) continue;
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of candidates) {
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) {
        for (const child of node['@graph']) {
          if (child && typeof child === 'object') out.push(child);
        }
      } else {
        out.push(node);
      }
    }
  }
  return out;
}

/** Every `application/ld+json` type name found, lowercased and deduped. */
export function jsonLdTypes(nodes: JsonLdNode[]): string[] {
  const types = new Set<string>();
  for (const node of nodes) {
    const t = node['@type'];
    if (typeof t === 'string') types.add(t.toLowerCase());
    else if (Array.isArray(t)) for (const v of t) if (typeof v === 'string') types.add(v.toLowerCase());
  }
  return [...types];
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

export function extractMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const key = attr(tag, 'name') ?? attr(tag, 'property') ?? attr(tag, 'itemprop');
    const content = attr(tag, 'content');
    if (key && content) out[key.toLowerCase()] = content;
  }
  return out;
}

export function extractHeadings(html: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[2] ?? '');
    if (text) out.push({ level: Number(m[1]), text });
  }
  return out;
}

export function extractLinks(html: string): { href: string; text: string; rel?: string }[] {
  const out: { href: string; text: string; rel?: string }[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = attr(m[0], 'href');
    if (!href) continue;
    const rel = attr(m[0], 'rel');
    out.push({ href, text: stripTags(m[2] ?? ''), ...(rel ? { rel } : {}) });
  }
  return out;
}

/**
 * Pull out `itemprop` / `itemtype` microdata so we can score both formats.
 *
 * We do a linear pass over every element carrying an `itemprop` attribute and
 * bucket it by the nearest preceding `itemscope` type. Full DOM ancestry is
 * overkill — for scoring we only need "does microdata exist and what types".
 */
export function extractMicrodata(html: string, maxItems = 200): { type: string; properties: Record<string, string> }[] {
  const items: { type: string; properties: Record<string, string> }[] = [];
  let currentType = '';

  const tagRe = /<[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null && items.length < maxItems) {
    const tag = m[0];
    if (/\bitemscope\b/i.test(tag)) {
      currentType = attr(tag, 'itemtype') ?? currentType;
    }
    const prop = attr(tag, 'itemprop');
    if (!prop) continue;
    const content =
      attr(tag, 'content') ?? attr(tag, 'value') ?? (attr(tag, 'href') as string | undefined) ?? stripTags(tag);
    if (!content) continue;
    // Merge into the current scope, starting one if we have not seen itemscope.
    let bucket = items[items.length - 1];
    if (!bucket || (currentType && bucket.type !== currentType)) {
      bucket = { type: currentType, properties: {} };
      items.push(bucket);
    }
    bucket.properties[prop] = content;
  }
  return items;
}

/** Count occurrences of a pattern, cheap and good enough for heuristics. */
export function countMatches(html: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const m = html.match(new RegExp(re.source, flags));
  return m ? m.length : 0;
}

export function parsePage(html: string, url: string): ParsedPage {
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleTag ? stripTags(titleTag[1] ?? '') : '';
  const meta = extractMeta(html);
  const canonicalTag = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(html);
  const canonical = canonicalTag ? (attr(canonicalTag[0], 'href') ?? '') : '';

  const langMatch = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html);

  const hreflang: { href: string; lang: string }[] = [];
  const hlRe = /<link\b[^>]*rel\s*=\s*["']alternate["'][^>]*>/gi;
  let hl: RegExpExecArray | null;
  while ((hl = hlRe.exec(html)) !== null) {
    const href = attr(hl[0], 'href');
    const hrefLang = attr(hl[0], 'hreflang');
    if (href && hrefLang) hreflang.push({ href, lang: hrefLang });
  }

  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const body = bodyMatch ? (bodyMatch[1] ?? '') : html;
  const mainMatch = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  // Prefer <main>/<article> for agent-facing prose — it's the least noisy region.
  const text = stripTags(mainMatch ? (mainMatch[2] ?? '') : body);

  const lower = html.toLowerCase();
  const jsonLd = extractJsonLd(html);

  return {
    title,
    metaDescription: meta['description'] ?? meta['og:description'] ?? '',
    metaRobots: meta['robots'] ?? '',
    lang: langMatch ? (langMatch[1] ?? '') : '',
    htmlLang: langMatch ? (langMatch[1] ?? '') : undefined,
    headings: extractHeadings(html),
    text,
    wordCount: text ? text.split(/\s+/).length : 0,
    links: extractLinks(html),
    canonical,
    hreflang,
    jsonLd,
    meta,
    microdata: extractMicrodata(html),
    hasPricingTable: /class\s*=\s*["'][^"']*(pricing|price-table|plans)[^"']*["']/i.test(html),
    hasAddToCart:
      /add[\s_-]*to[\s_-]*(cart|bag|basket)/i.test(html) ||
      /"addToCart"/i.test(html) ||
      /\/cart\/add|\/basket\/add/i.test(html),
    hasLoginForm: /<input[^>]+type\s*=\s*["']password["']/i.test(html),
    hasContactForm: /<form\b[^>]*>/i.test(html) && /name\s*=\s*["'](email|message)["']/i.test(html),
    counts: {
      scripts: countMatches(html, /<script\b/gi),
      images: countMatches(html, /<img\b/gi),
      iframes: countMatches(html, /<iframe\b/gi),
      forms: countMatches(html, /<form\b/gi),
      inputs: countMatches(html, /<input\b/gi),
      tables: countMatches(html, /<table\b/gi),
      lists: countMatches(html, /<(ul|ol)\b/gi),
    },
  };
}

/** Resolve a possibly-relative href against the page URL. */
export function resolveUrl(href: string, base: string): string | undefined {
  if (!href) return undefined;
  if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
    return undefined;
  }
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}