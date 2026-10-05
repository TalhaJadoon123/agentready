/**
 * Site-name helpers.
 *
 * Shared by the simulator and the benchmarker so a citation written as
 * "acme.com" always matches a target stored as "https://acme.com".
 */

/** The short, human-shaped site name an LLM will actually write. */
export function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

/** Comparison key: lowercase, no www, alphanumeric only. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]/g, '');
}