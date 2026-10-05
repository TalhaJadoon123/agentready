/** robots.txt parsing (RFC 9309 subset) plus the agent-access decision. */

import type { FetchLike, FetchResult } from './fetcher.js';
import { fetchOnce } from './fetcher.js';
import type { RobotsRules } from './context.js';
import { AGENT_USER_AGENT } from './fetcher.js';

export interface RobotsRule {
  path: string;
  allow: boolean;
  /** Crawl-delay seconds, when declared inside the group. */
  crawlDelay?: number;
}

export interface RobotsGroup {
  agent: string;
  rules: RobotsRule[];
  /** Crawl-delay seconds declared in this group. */
  crawlDelay?: number;
}

/** Match a robots.txt path pattern (supports `*` and `$` anchors). */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const anchoredEnd = escaped.endsWith('$');
  const body = anchoredEnd ? escaped.slice(0, -1) : escaped;
  try {
    return new RegExp(`^${body}`).test(path);
  } catch {
    return false;
  }
}

/**
 * Split robots.txt into per-user-agent groups.
 * Directives before any `User-agent` line belong to the `*` group.
 */
export function parseRobots(content: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (key === 'user-agent') {
      // Consecutive User-agent lines share one rule block.
      if (current && current.agent === value.toLowerCase()) continue;
      current = { agent: value.toLowerCase(), rules: [] };
      groups.push(current);
      continue;
    }

    current ??= { agent: '*', rules: [] };
    if (!groups.includes(current)) groups.push(current);

    if (key === 'disallow' || key === 'allow') {
      current.rules.push({ path: value, allow: key === 'allow' });
    } else if (key === 'crawl-delay') {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  return groups;
}

/** The groups that apply to a user-agent token, most specific first. */
export function selectGroups(groups: RobotsGroup[], userAgent: string): RobotsGroup[] {
  const token = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.agent !== '*' && (g.agent.includes(token) || token.includes(g.agent)));
  const wildcard = groups.filter((g) => g.agent === '*');
  return [...specific, ...wildcard];
}

/**
 * Is `path` crawlable for this user-agent?
 * Longest matching rule wins; ties break in favour of Allow (per spec).
 */
export function isPathAllowed(rules: RobotsRules, path: string, userAgent = '*'): boolean {
  const groups = selectGroups(parseRobots(rules.content), userAgent);
  let best: { len: number; allow: boolean } | undefined;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!matchesPattern(path, rule.path)) continue;
      if (!best || rule.path.length > best.len || (rule.path.length === best.len && rule.allow)) {
        best = { len: rule.path.length, allow: rule.allow };
      }
    }
  }
  if (best) return best.allow;
  // No rule matched: allowed unless the site blanket-disallows everything.
  return !rules.wildcardBlocked;
}

/** Fetch and parse robots.txt for a site origin. */
export async function fetchRobots(fetchImpl: FetchLike, origin: string, timeoutMs = 10_000): Promise<RobotsRules> {
  const url = `${origin.replace(/\/$/, '')}/robots.txt`;
  const res: FetchResult = await fetchOnce(fetchImpl, url, { timeoutMs, headers: { accept: 'text/plain' } });

  if (!res.ok || !res.body) {
    return {
      url,
      found: false,
      status: res.status,
      content: '',
      disallowed: [],
      allowed: [],
      wildcardBlocked: false,
      sitemapDeclared: false,
      sitemaps: [],
      ...(res.error ? { error: res.error } : {}),
    };
  }

  const content = res.body;
  const groups = parseRobots(content);
  const wildcard = groups.filter((g) => g.agent === '*');
  const flat = wildcard.flatMap((g) => g.rules);

  const disallowed = flat.filter((r) => !r.allow).map((r) => r.path);
  const allowed = flat.filter((r) => r.allow).map((r) => r.path);
  const sitemaps = [...content.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1] ?? '').filter(Boolean);
  const crawlDelay = groups.map((g) => g.crawlDelay).find((n) => typeof n === 'number');

  return {
    url,
    found: true,
    status: res.status,
    content,
    disallowed,
    allowed,
    wildcardBlocked: disallowed.some((p) => p === '/' || p === '/*'),
    sitemapDeclared: sitemaps.length > 0,
    sitemaps,
    ...(crawlDelay !== undefined ? { crawlDelay } : {}),
  };
}

/** Are we, as an agent, allowed to crawl this path? */
export function agentAllowed(rules: RobotsRules, path: string): boolean {
  return isPathAllowed(rules, path, AGENT_USER_AGENT);
}