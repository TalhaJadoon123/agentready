/**
 * SSRF guard.
 *
 * The scanner fetches a URL the caller supplies. Without a guard, that turns a
 * public endpoint into a proxy for reaching internal infrastructure: cloud
 * metadata services (169.254.169.254), private ranges, or localhost services
 * that assume they are unreachable.
 *
 * The policy is "deny by default, allow explicitly":
 *   - Public DNS names and public IPs are allowed.
 *   - Private, loopback, link-local and CGNAT ranges are denied.
 *   - `ALLOW_PRIVATE_FETCH=true` opts a deployment back in (self-hosted use,
 *     and the bundled demo site, which lives on localhost).
 *
 * DNS is resolved and every returned address is checked, so a hostname that
 * resolves into a private range is rejected too. That closes the DNS-rebinding
 * gap between validation and connection for the common case.
 */

import { isIP } from 'node:net';

/** Cloud metadata endpoints. Always denied, even with private ranges allowed. */
const HARD_BLOCKED = new Set([
  '169.254.169.254', // AWS / GCP / Azure / DigitalOcean metadata
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud metadata
  'fd00:ec2::254', // AWS IPv6 metadata
  'metadata.google.internal',
  'metadata.goog',
]);

/** Ranges that must never be reached through the scanner. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (includes metadata)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (includes 255.255.255.255)
];

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['::ffff:0:0', 96], // IPv4-mapped — checked as IPv4 below
];

function v4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function ipInRange(ip: string, base: string, prefix: number): boolean {
  const ipValue = v4ToInt(ip);
  const baseValue = v4ToInt(base);
  if (ipValue === undefined || baseValue === undefined) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipValue & mask) === (baseValue & mask);
}

/** Is this literal IP address private, loopback, link-local or otherwise unsafe? */
export function isPrivateAddress(address: string): boolean {
  const host = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;

  if (HARD_BLOCKED.has(host)) return true;

  const family = isIP(host);

  if (family === 4) {
    return BLOCKED_V4.some(([base, prefix]) => ipInRange(host, base, prefix));
  }

  if (family === 6) {
    // An IPv4-mapped address is really an IPv4 address; check it as one.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isPrivateAddress(mapped[1]!);
    // 64:ff9b::/96 (NAT64) embeds an IPv4 address too.
    const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (nat64) return isPrivateAddress(nat64[1]!);
    return BLOCKED_V6.some(([base, prefix]) => {
      const a = expandIpv6(host);
      const b = expandIpv6(base);
      if (!a || !b) return false;
      for (let i = 0; i < 16; i++) {
        const bits = Math.max(0, Math.min(8, prefix - i * 8));
        if (bits === 0) continue;
        const mask = (0xff << (8 - bits)) & 0xff;
        if ((a[i]! & mask) !== (b[i]! & mask)) return false;
      }
      return true;
    });
  }

  return false;
}

/** Expand an IPv6 address to 16 bytes. Handles :: compression. */
function expandIpv6(input: string): number[] | undefined {
  if (!input.includes(':')) return undefined;
  const [head, tail] = input.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail !== undefined && tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined && missing !== 0) return undefined;
  if (missing < 0) return undefined;

  const groups = [...headParts, ...Array<string>(missing).fill('0'), ...tailParts];
  if (groups.length !== 8) return undefined;

  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return undefined;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

/** Hostnames that always resolve inward. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  ...HARD_BLOCKED,
]);

export interface GuardOptions {
  /** Allow private/loopback targets. Off by default. */
  allowPrivate?: boolean;
  /** DNS resolver; injected in tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  signal?: AbortSignal;
}

export class SsrfError extends Error {
  constructor(
    readonly reason: string,
    readonly target: string,
  ) {
    super(`Refusing to fetch ${target}: ${reason}`);
    this.name = 'SsrfError';
  }
}

/** True when private targets are permitted by configuration. */
export function privateFetchAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env['AGENTREADY_ALLOW_PRIVATE_FETCH'] ?? '').trim());
}

/**
 * Assert that a URL is safe to fetch.
 *
 * @throws {SsrfError} when the target points at private infrastructure.
 */
export async function assertFetchable(rawUrl: string, options: GuardOptions = {}): Promise<void> {
  const allowPrivate = options.allowPrivate ?? privateFetchAllowed();

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('not a valid URL', rawUrl);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`unsupported protocol "${url.protocol}"`, rawUrl);
  }

  // Metadata endpoints are denied even when private ranges are permitted:
  // they hand out credentials, and nothing legitimate needs them.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (HARD_BLOCKED.has(hostname)) {
    throw new SsrfError('cloud metadata endpoint', rawUrl);
  }

  if (allowPrivate) return;

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new SsrfError('private or reserved address', rawUrl);
    return;
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfError('loopback hostname', rawUrl);
  }

  // Resolve and check every answer. Without this, `evil.com -> 127.0.0.1`
  // walks straight through the literal-IP check above.
  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    // Resolution failure is not our concern here — the fetch will fail on its
    // own, and reporting it as a security failure would be misleading.
    return;
  }

  if (addresses.length === 0) return;

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new SsrfError(`resolves to private address ${address}`, rawUrl);
    }
  }
}

/** Default resolver. Node's dns module, loaded lazily to keep this portable. */
async function defaultResolve(hostname: string): Promise<string[]> {
  const { promises: dns } = await import('node:dns');
  try {
    const result = await dns.lookup(hostname, { all: true, verbatim: true });
    return result.map((r) => r.address);
  } catch {
    return [];
  }
}

/**
 * A `fetch` wrapper that refuses unsafe targets.
 *
 * Redirects are the remaining hole: a public URL can 302 to 169.254.169.254.
 * We follow redirects manually so every hop is validated.
 */
export function createGuardedFetch(
  base: typeof fetch,
  options: GuardOptions & { maxRedirects?: number; timeoutMs?: number } = {},
): typeof fetch {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 12_000;

  // `RequestInfo` is a DOM type that shared does not pull in; the union
  // covers every shape Node's fetch accepts.
  type FetchInput = string | URL | { url: string };

  return async (input: FetchInput, init: RequestInit = {}) => {
    const original = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    let current = new URL(original, 'http://localhost').toString();
    let redirects = 0;

    while (true) {
      await assertFetchable(current, options);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await base(current, { ...init, redirect: 'manual', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get('location');
      if (!isRedirect || !location) return response;

      if (++redirects > maxRedirects) {
        throw new SsrfError(`too many redirects (>${maxRedirects})`, original);
      }

      current = new URL(location, current).toString();
    }
  };
}