/**
 * Everything a check needs, gathered once so eight checks run against a single
 * set of network calls (we are usually on a free tier — be cheap).
 */

import type { MCPServerInfo, CheckIdCounted } from '@agentready/shared';
import type { FetchLike, FetchResult } from './fetcher.js';
import type { ParsedPage } from './parser.js';

export interface RobotsRules {
  /** Absolute URL we tried, or undefined when we never got one. */
  url?: string;
  found: boolean;
  status: number;
  content: string;
  /** Paths this agent UA is forbidden from. */
  disallowed: string[];
  allowed: string[];
  /** True when `*` is disallowed for our user-agent. */
  wildcardBlocked: boolean;
  /** True when a sitemap URL is declared. */
  sitemapDeclared: boolean;
  sitemaps: string[];
  /** Crawl-delay in seconds, if declared. */
  crawlDelay?: number;
  /** Transport error, when robots.txt could not be fetched at all. */
  error?: string;
}

export interface SitemapInfo {
  found: boolean;
  status: number;
  url?: string;
  /** Loc values parsed out of <sitemapindex> or <urlset>. */
  urls: string[];
  isIndex: boolean;
  /** True when a sitemap was declared in robots.txt even if the fetch failed. */
  declaredInRobots: boolean;
  /** Sampled page URLs (only when isIndex is false). */
  sitemapUrl?: string;
}

export interface WellKnownProbe {
  status: number;
  ok: boolean;
  body?: string;
  url: string;
  contentType?: string;
  error?: string;
}

/** Paths an agent expects to find, probed on every scan. */
export const WELL_KNOWN_PATHS = [
  '/llms.txt',
  '/llms-full.txt',
  '/.well-known/ai-plugin.json',
  '/.well-known/mcp.json',
  '/.well-known/openapi.json',
  '/.well-known/agent.json',
  '/api/openapi.json',
  '/openapi.json',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/humans.txt',
] as const;

export type WellKnownKey = (typeof WELL_KNOWN_PATHS)[number];

export type WellKnownMap = Partial<Record<WellKnownKey, WellKnownProbe>>;

export interface ScanOptions {
  /** Injectable fetch (tests, custom agents). */
  fetch?: FetchLike;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Maximum sitemap URLs to follow. */
  maxSitemapUrls?: number;
  /** Probe /.well-known paths. On by default. */
  probeWellKnown?: boolean;
  /** Probe for a live MCP server. On by default. */
  probeMcp?: boolean;
  /** Look for OpenAPI for the auth/rate-limit checks. */
  probeOpenApi?: boolean;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Deep mode also hits third-party registries (slower). */
  deep?: boolean;
  /** Skip checks entirely (cache warm path). */
  skipChecks?: boolean;
  /** Restrict which checks run. Useful for cheap partial re-scans. */
  onlyChecks?: CheckIdCounted[];
  /**
   * Allow scanning private/loopback addresses.
   *
   * Off by default: the scanner fetches caller-supplied URLs, so allowing
   * private ranges would turn it into a proxy for internal infrastructure.
   * Defaults to AGENTREADY_ALLOW_PRIVATE_FETCH.
   */
  allowPrivateFetch?: boolean;
  /** DNS resolver override, for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
}

export interface ScanContext {
  url: string;
  origin: string;
  finalUrl: string;
  status: number;
  responseMs: number;
  html: string;
  headers: Record<string, string>;
  page: ParsedPage;
  robots: RobotsRules;
  sitemap: SitemapInfo;
  wellKnown: WellKnownMap;
  mcp: MCPServerInfo;
  /** Agents may need HEAD/OPTIONS semantics; expose the raw fetcher for sub-probes. */
  fetch: FetchLike;
  options: Required<Pick<ScanOptions, 'timeoutMs' | 'maxSitemapUrls'>> & ScanOptions;
  checkedAt: string;
}

export function emptyContext(partial: Partial<ScanContext> & { url: string; origin: string }): ScanContext {
  return {
    finalUrl: partial.url,
    status: 200,
    responseMs: 0,
    html: '',
    headers: {},
    page: {
      title: '',
      metaDescription: '',
      metaRobots: '',
      lang: '',
      headings: [],
      text: '',
      wordCount: 0,
      links: [],
      canonical: '',
      hreflang: [],
      jsonLd: [],
      meta: {},
      microdata: [],
      hasPricingTable: false,
      hasAddToCart: false,
      hasLoginForm: false,
      hasContactForm: false,
      counts: { scripts: 0, images: 0, iframes: 0, forms: 0, inputs: 0, tables: 0, lists: 0 },
    },
    robots: { found: false, status: 0, content: '', disallowed: [], allowed: [], wildcardBlocked: false, sitemapDeclared: false, sitemaps: [] },
    sitemap: { found: false, status: 0, urls: [], isIndex: false, declaredInRobots: false },
    wellKnown: {},
    mcp: { url: '', tools: [], status: 'down' },
    fetch: async () => new Response('', { status: 500 }),
    options: { timeoutMs: 12_000, maxSitemapUrls: 50 },
    checkedAt: new Date().toISOString(),
    ...partial,
  } as ScanContext;
}