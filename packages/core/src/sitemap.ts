/** sitemap.xml discovery + parsing. */

import type { FetchLike } from './fetcher.js';
import { fetchOnce } from './fetcher.js';
import type { RobotsRules, SitemapInfo } from './context.js';

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeXml(m[1] ?? '').trim()).filter(Boolean);
}

function decodeXml(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Fetch a sitemap and report what it contains.
 * Handles both `<urlset>` (page list) and `<sitemapindex>` (nested list).
 */
export async function fetchSitemap(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs = 12_000,
): Promise<SitemapInfo> {
  const res = await fetchOnce(fetchImpl, url, { timeoutMs });
  if (!res.ok || !res.body) {
    return { found: false, status: res.status, url, urls: [], isIndex: false, declaredInRobots: false };
  }
  const isIndex = /<sitemapindex[\s>]/i.test(res.body);
  return {
    found: true,
    status: res.status,
    url,
    urls: extractLocs(res.body),
    isIndex,
    declaredInRobots: false,
    sitemapUrl: url,
  };
}

/**
 * Resolve the site's sitemap the way a crawler would:
 * robots.txt `Sitemap:` first, then /sitemap.xml, then /sitemap_index.xml.
 */
export async function discoverSitemap(
  fetchImpl: FetchLike,
  origin: string,
  robots: RobotsRules,
  maxSitemapUrls = 50,
  timeoutMs = 12_000,
): Promise<SitemapInfo> {
  const candidates = robots.sitemaps.length > 0 ? robots.sitemaps : [
    `${origin.replace(/\/$/, '')}/sitemap.xml`,
    `${origin.replace(/\/$/, '')}/sitemap_index.xml`,
    `${origin.replace(/\/$/, '')}/sitemap-index.xml`,
  ];

  for (const candidate of candidates.slice(0, 5)) {
    const info = await fetchSitemap(fetchImpl, candidate, timeoutMs);
    if (!info.found) continue;
    info.declaredInRobots = robots.sitemaps.includes(candidate);

    if (!info.isIndex) {
      info.urls = info.urls.slice(0, maxSitemapUrls);
      return info;
    }

    // Follow the first child index to get actual page URLs.
    for (const child of info.urls.slice(0, 5)) {
      const childInfo = await fetchSitemap(fetchImpl, child, timeoutMs);
      if (childInfo.found && !childInfo.isIndex) {
        childInfo.declaredInRobots = info.declaredInRobots;
        childInfo.urls = childInfo.urls.slice(0, maxSitemapUrls);
        return childInfo;
      }
    }
    return info;
  }

  return { found: false, status: 0, urls: [], isIndex: false, declaredInRobots: false };
}