import type { Grade } from './types.js';
import { GRADE_THRESHOLDS } from './types.js';

/** Clamp a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Round to a fixed number of decimals, avoiding float dust. */
export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Map a 0-100 score to a letter grade. */
export function scoreToGrade(score: number): Grade {
  const s = clamp(score, 0, 100);
  for (const [min, grade] of GRADE_THRESHOLDS) {
    if (s >= min) return grade;
  }
  return 'F';
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run `fn`, resolving to `fallback` if it throws or rejects. */
export async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** Deterministic JSON: keys sorted recursively. Great for cache keys and hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortValue((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Small non-cryptographic hash (FNV-1a), used for fingerprints. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Stable id derived from arbitrary parts — same input, same id. */
export function stableId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${fnv1a(stableStringify(parts))}`;
}

/** Tiny crypto-random hex id that works without node:crypto import cost. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return `${prefix}_${out}`;
}

/** Normalise a URL to an origin + optional path, with a trailing-slash policy. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  u.hash = '';
  // Default ports are noise for cache keys.
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }
  let out = u.toString();
  if (out.endsWith('/') && u.pathname === '/') out = out.slice(0, -1);
  return out;
}

/** Origin only, e.g. https://example.com */
export function originOf(url: string): string {
  return new URL(normalizeUrl(url)).origin;
}

/** Join a base URL and a path safely. */
export function joinUrl(base: string, path: string): string {
  return new URL(path.replace(/^\//, ''), ensureTrailingSlash(normalizeUrl(base))).toString();
}

export function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** Truncate with an ellipsis, on a word boundary when possible. */
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

/** Percentile from an unsorted numeric array (p in 0..1). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.ceil(p * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx] ?? 0;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Percentage helper that avoids NaN on empty input. */
export function pct(part: number, total: number): number {
  if (total === 0) return 0;
  return round((part / total) * 100, 1);
}

/** Parse a money-ish string out of free text: "$1,299.00" -> 1299 */
export function parsePrice(input: unknown, currency = 'USD'): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return round(input, 2);
  if (typeof input !== 'string') return undefined;
  const cleaned = input.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return undefined;
  // Handle European "1.299,00" and US "1,299.00"
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;
  if (lastComma > -1 && lastDot > -1) {
    normalized = lastComma > lastDot ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
  } else if (lastComma > -1) {
    // Comma as decimal only when followed by 1-2 digits at the end.
    normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned;
  }
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? round(n, 2) : undefined;
  void currency;
}

/** Currency symbol for a currency code. Small table beats an Intl lookup. */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  PKR: '₨',
  INR: '₹',
  CAD: 'C$',
  AUD: 'A$',
};

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code.toUpperCase()] ?? code.toUpperCase();
}

/** Group digits for display: 1234567 -> "1,234,567" */
export function formatNumber(n: number, fractionDigits = 0): string {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(n);
}

/** Format cents as currency: 4900 -> "$49.00" */
export function formatCents(cents: number, currency = 'USD'): string {
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  return `${symbol}${formatNumber(cents / 100, 2)}`;
}

/** Titles Case a slug or kebab string. */
export function titleCase(input: string): string {
  return input
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join('');
}

/** Convert snake_case to camelCase. */
export function camelCase(input: string): string {
  return input.replace(/[_-](\w)/g, (_, c: string) => c.toUpperCase());
}

/** Convert camelCase to snake_case. */
export function snakeCase(input: string): string {
  return input.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Convert any identifier to kebab-case (valid for tool names and slugs). */
export function kebabCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .toLowerCase();
}

/**
 * DNS-safe name for MCP servers: lowercase alnum + hyphens only.
 *
 * This doubles as a security boundary — the result is used in file paths and
 * as a `spawn` argument — so it strips separators, shell metacharacters and
 * leading dashes (which a child process would read as a flag), and falls back
 * to a stable placeholder rather than returning an empty string.
 */
export function serverSlug(input: string): string {
  const slug = kebabCase(input)
    // A leading dash would be parsed as a flag by npx / child_process.
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');

  // "..", "..." and "!!!" all sanitize away to nothing. Returning "" would
  // produce paths like "/worker.js" or an argument that silently vanishes.
  return slug || 'mcp-server';
}

/** Redact secrets before logging or echoing config. */
export function redact(value: string | undefined | null): string {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

/** Create a bounded concurrency runner. Keeps us polite to target servers. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      results[i] = await fn(item, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Zip two arrays. */
export function zip<A, B>(a: readonly A[], b: readonly B[]): Array<[A, B]> {
  return a.map((v, i) => [v, b[i] as B]);
}

/** Remove duplicates preserving order. */
export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** JSON parse that never throws. */
export function tryParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Deep merge for plain objects. Arrays are replaced, not concatenated. */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}