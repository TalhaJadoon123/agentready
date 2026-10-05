/**
 * Free public API integrations.
 *
 * Every integration here is free, requires no API key, and degrades to
 * `undefined` when unavailable. That matters: this product must be fully
 * useful offline, and a network dependency must never be able to fail a scan.
 *
 * Integrations:
 *   - crt.sh          certificate transparency -> subdomain discovery
 *   - Cloudflare DoH  real DNS resolution -> DNS records for the readiness report
 *   - Wayback Machine archive availability -> whether the site is established
 *   - RDAP             registration data -> domain age, registrar, expiry
 *
 * None of them gate a scan. They enrich it.
 */

import { originOf, hasApiKey, config, errorMessage, logger, round } from '@agentready/shared';

/** Standard result shape: `undefined` means "could not determine", not "false". */
export interface IntegrationResult<T> {
  data: T;
  /** Where it came from, for the UI to link to. */
  source: string;
  /** ISO timestamp. */
  fetchedAt: string;
}

export interface IntegrationsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Skip network calls entirely (tests, offline). */
  offline?: boolean;
}

async function getJson<T>(url: string, options: IntegrationsOptions & { accept?: string } = {}): Promise<T | undefined> {
  if (options.offline) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: options.accept ?? 'application/json', 'user-agent': 'AgentReady/1.0 (+https://agentready.dev)' },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    // These endpoints sometimes return text/plain; parsing defensively is
    // cheaper than trusting the content-type header.
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// crt.sh — certificate transparency
// ---------------------------------------------------------------------------

export interface SubdomainFinding {
  subdomains: string[];
  /** Distinct issuers seen in the certificate log. */
  issuers: string[];
  /** Oldest and newest certificate dates. */
  firstSeen?: string;
  lastSeen?: string;
}

/**
 * Discover subdomains from the CT log.
 *
 * Useful because a site that publishes an MCP server on a subdomain is often
 * missing it on the apex — this finds the surfaces a homepage scan would miss.
 */
export async function fetchSubdomains(url: string, options: IntegrationsOptions = {}): Promise<IntegrationResult<SubdomainFinding> | undefined> {
  const host = safeHostname(url);
  if (!host) return undefined;

  const body = await getJson<Array<Record<string, unknown>>>(
    `https://crt.sh/?q=%25.${encodeURIComponent(host)}&output=json`,
    options,
  );
  if (!Array.isArray(body) || body.length === 0) return undefined;

  const found = new Set<string>();
  const issuers = new Set<string>();
  let firstSeen: string | undefined;
  let lastSeen: string | undefined;

  for (const entry of body) {
    const name = String(entry['name_value'] ?? '').split('\n')[0] ?? '';
    const cleaned = name.trim().toLowerCase().replace(/^\*\./, '');
    // Only keep genuine subdomains of the target.
    if (cleaned && cleaned.endsWith(`.${host}`)) found.add(cleaned);

    const issuer = entry['issuer_name'] ? String(entry['issuer_name']).split('\n')[0] : undefined;
    if (issuer) issuers.add(issuer.split(' ').slice(0, 2).join(' '));

    const notBefore = entry['not_before'] ? String(entry['not_before']) : undefined;
    if (notBefore) {
      if (!firstSeen || notBefore < firstSeen) firstSeen = notBefore;
      if (!lastSeen || notBefore > lastSeen) lastSeen = notBefore;
    }
  }

  if (found.size === 0) return undefined;

  return {
    data: {
      subdomains: [...found].sort(),
      issuers: [...issuers].sort(),
      ...(firstSeen ? { firstSeen } : {}),
      ...(lastSeen ? { lastSeen } : {}),
    },
    source: `https://crt.sh/?q=%.${host}`,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cloudflare DNS-over-HTTPS
// ---------------------------------------------------------------------------

export interface DnsFinding {
  records: Array<{ type: string; value: string; ttl?: number }>;
  /** Provider that answered. */
  resolver: string;
  /** True when the apex has no A/AAAA — the domain does not resolve. */
  doesNotResolve: boolean;
}

/** Resolve A, AAAA, MX, TXT and NS via Cloudflare's DNS-over-HTTPS endpoint. */
export async function fetchDnsRecords(url: string, options: IntegrationsOptions = {}): Promise<IntegrationResult<DnsFinding> | undefined> {
  const host = safeHostname(url);
  if (!host) return undefined;

  const types = ['A', 'AAAA', 'MX', 'TXT', 'NS'] as const;
  const records: DnsFinding['records'] = [];

  await Promise.all(
    types.map(async (type) => {
      const body = await getJson<{ Answer?: Array<{ type: number; data: string; TTL: number }> }>(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { ...options, accept: 'application/dns-json' },
      );
      for (const answer of body?.Answer ?? []) {
        // Ignore CNAMEs pointing at the queried name itself.
        if (String(answer.data).endsWith(host) && answer.type === 5) continue;
        records.push({ type, value: String(answer.data), ttl: answer.TTL });
      }
    }),
  );

  if (records.length === 0) {
    // No answers at all is itself a finding worth reporting.
    return {
      data: { records: [], resolver: 'cloudflare-dns.com', doesNotResolve: true },
      source: `https://cloudflare-dns.com/dns-query?name=${host}`,
      fetchedAt: new Date().toISOString(),
    };
  }

  return {
    data: { records, resolver: 'cloudflare-dns.com', doesNotResolve: false },
    source: `https://cloudflare-dns.com/dns-query?name=${host}`,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Wayback Machine
// ---------------------------------------------------------------------------

export interface ArchiveFinding {
  archived: boolean;
  /** Timestamp of the most recent snapshot, if any. */
  lastSnapshot?: string;
  /** Years between the first snapshot and now, when known. */
  yearsArchived?: number;
}

/**
 * Has this site existed long enough to be trusted?
 *
 * An agent-facing site with no archive history is usually brand new. That is
 * worth surfacing — not as a penalty, but as context.
 */
export async function fetchArchivePresence(url: string, options: IntegrationsOptions = {}): Promise<IntegrationResult<ArchiveFinding> | undefined> {
  const target = safeOrigin(url);
  if (!target) return undefined;

  const body = await getJson<{ archived_snapshots?: { closest?: { timestamp?: string }; available?: boolean } }>(
    `https://archive.org/wayback/available?url=${encodeURIComponent(target)}`,
    options,
  );
  if (!body) return undefined;

  const timestamp = body.archived_snapshots?.closest?.timestamp;
  const archived = Boolean(body.archived_snapshots?.available) && Boolean(timestamp);

  return {
    data: {
      archived,
      ...(timestamp ? { lastSnapshot: new Date(Number(timestamp) * 1000).toISOString() } : {}),
      ...(timestamp ? { yearsArchived: round((Date.now() - Number(timestamp) * 1000) / (365.25 * 86_400_000), 1) } : {}),
    },
    source: `https://archive.org/wayback/available?url=${target}`,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// RDAP — registration data
// ---------------------------------------------------------------------------

export interface DomainFinding {
  registered: boolean;
  registrar?: string;
  /** ISO dates from the registry. */
  createdAt?: string;
  expiresAt?: string;
  updatedAt?: string;
  /** Registries with an open RDAP endpoint. */
  status: string[];
}

/** Bootstrap-free RDAP: resolve the TLD's RDAP server via IANA bootstrap. */
const RDAP_BOOTSTRAP: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1/domain/',
  net: 'https://rdap.verisign.com/net/v1/domain/',
  org: 'https://rdap.publicinterestregistry.org/rdap/domain/',
  io: 'https://rdap.identitydigital.services/rdap/domain/',
  dev: 'https://www.registry.google/rdap/domain/',
  app: 'https://www.registry.google/rdap/domain/',
  ai: 'https://www.registry.google/rdap/domain/',
  co: 'https://rdap.nic.co/domain/',
  me: 'https://rdap.nic.me/domain/',
  xyz: 'https://rdap.centralnic.com/xyz/domain/',
  dev2: '',
  cloud: 'https://rdap.nic.cloud/domain/',
  uk: 'https://rdap.nominet.uk/uk/domain/',
  de: 'https://rdap.denic.de/domain/',
  fr: 'https://rdap.nic.fr/domain/',
  nl: 'https://rdap.domain-registry.nl/domain/',
  eu: 'https://rdap.eu/domain/',
  info: 'https://rdap.identitydigital.services/rdap/domain/',
  biz: 'https://rdap.nic.biz/domain/',
  sh: 'https://rdap.nic.sh/domain/',
};

/**
 * Domain registration facts.
 *
 * A recently-created, short-registration domain is a weak signal on its own —
 * reported, never scored. Including expiry matters too: an agent store whose
 * domain lapses in a month is a bad bet for an agent to recommend.
 */
export async function fetchDomainInfo(url: string, options: IntegrationsOptions = {}): Promise<IntegrationResult<DomainFinding> | undefined> {
  const host = safeHostname(url);
  if (!host) return undefined;

  const tld = host.split('.').pop()?.toLowerCase() ?? '';
  const base = RDAP_BOOTSTRAP[tld];
  if (!base) return undefined;

  const body = await getJson<{
    registrar?: Array<{ handle?: string }>;
    events?: Array<{ eventAction?: string; eventDate?: string }>;
    status?: string[];
  }>(`${base}${encodeURIComponent(host)}`, options);

  if (!body) return undefined;

  const event = (action: string) => body.events?.find((e) => e.eventAction === action)?.eventDate;

  return {
    data: {
      registered: true,
      ...(body.registrar?.[0]?.handle ? { registrar: body.registrar[0].handle } : {}),
      ...(event('registration') ? { createdAt: event('registration') } : {}),
      ...(event('expiration') ? { expiresAt: event('expiration') } : {}),
      ...(event('last changed') ? { updatedAt: event('last changed') } : {}),
      status: body.status ?? [],
    },
    source: base,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface EnrichmentReport {
  target: string;
  subdomains?: SubdomainFinding;
  dns?: DnsFinding;
  archive?: ArchiveFinding;
  domain?: DomainFinding;
  /** Integrations that ran but returned nothing. */
  unavailable: string[];
}

/**
 * Run every enrichment in parallel. All of them are best-effort: one failing
 * must never affect another, and none of them can fail a scan.
 */
export async function enrichTarget(url: string, options: IntegrationsOptions = {}): Promise<EnrichmentReport> {
  const tasks: Array<[keyof Omit<EnrichmentReport, 'target' | 'unavailable'>, string, Promise<IntegrationResult<never> | undefined>]> = [
    ['subdomains', 'crt.sh', fetchSubdomains(url, options) as Promise<IntegrationResult<never> | undefined>],
    ['dns', 'cloudflare-dns', fetchDnsRecords(url, options) as Promise<IntegrationResult<never> | undefined>],
    ['archive', 'wayback', fetchArchivePresence(url, options) as Promise<IntegrationResult<never> | undefined>],
    ['domain', 'rdap', fetchDomainInfo(url, options) as Promise<IntegrationResult<never> | undefined>],
  ];

  const settled = await Promise.allSettled(tasks.map(([, , promise]) => promise));

  const report: EnrichmentReport = { target: originOf(url), unavailable: [] };
  settled.forEach((result, index) => {
    const key = tasks[index]![0];
    const name = tasks[index]![1];
    if (result.status === 'fulfilled' && result.value) {
      (report as unknown as Record<string, unknown>)[key] = result.value.data;
    } else {
      report.unavailable.push(name);
      if (result.status === 'rejected') {
        logger.debug(`enrichment ${name} failed`, { error: errorMessage(result.reason) });
      }
    }
  });

  return report;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function safeHostname(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host.includes('.') ? host : undefined;
  } catch {
    return undefined;
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return originOf(url);
  } catch {
    return undefined;
  }
}

/** Human-readable summary lines for the CLI and the dashboard. */
export function describeEnrichment(report: EnrichmentReport): string[] {
  const lines: string[] = [];

  if (report.domain?.createdAt) {
    const years = round((Date.now() - new Date(report.domain.createdAt).getTime()) / (365.25 * 86_400_000), 1);
    lines.push(`Domain registered ${years} year(s) ago${report.domain.registrar ? ` via ${report.domain.registrar}` : ''}`);
    if (report.domain.expiresAt) {
      const months = round((new Date(report.domain.expiresAt).getTime() - Date.now()) / (30.44 * 86_400_000), 0);
      if (months < 12) lines.push(`Domain expires in ${months} month(s)`);
    }
  }

  if (report.archive?.archived && report.archive.yearsArchived !== undefined) {
    lines.push(`In the Wayback Machine for ${report.archive.yearsArchived} year(s)`);
  }

  if (report.subdomains?.subdomains?.length) {
    lines.push(`${report.subdomains.subdomains.length} subdomain(s) in certificate logs`);
    for (const sub of report.subdomains.subdomains.slice(0, 5)) lines.push(`  - ${sub}`);
  }

  if (report.dns?.doesNotResolve) {
    lines.push('WARNING: the apex domain does not resolve — agents cannot reach it');
  }

  // Defensive: this renders whatever enrichment came back, including partial
  // reports from a single integration failing.
  if (report.unavailable?.length) {
    lines.push(`Unavailable: ${report.unavailable.join(', ')}`);
  }

  return lines;
}