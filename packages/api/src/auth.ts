/**
 * Authentication and plan enforcement.
 *
 * Auth.js (NextAuth) owns the web session. This module owns the API's own
 * bearer-token path, so the API can also be used from a CLI or a CI job
 * without a browser session.
 *
 * Tokens are signed with AUTH_SECRET (HMAC-SHA256) — no session table, no
 * dependency, and a token is verifiable anywhere the secret is available.
 */

import type { Plan, User } from '@agentready/shared';
import { config, errorMessage, newId } from '@agentready/shared';
import type { Request } from './http.js';
import { HttpError } from './http.js';
import type { Store } from './store.js';
import { QuotaExceededError } from './store.js';

/** A verified API token: the caller plus the plan it resolves to. */
export interface Principal {
  userId: string;
  email?: string;
  plan: Plan;
  /** How we know who this is. */
  via: 'bearer' | 'api-key' | 'dev';
}

/**
 * Sign a payload: base64url(payload).base64url(hmac).
 */
export async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await hmac(body, secret);
  return `${body}.${mac}`;
}

/** Verify and decode a token. Returns undefined when invalid or expired. */
export async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | undefined> {
  const [body, mac] = token.split('.');
  if (!body || !mac) return undefined;

  const expected = await hmac(body, secret);
  // Constant-time compare so a token cannot be guessed byte by byte.
  if (!timingSafeEqual(mac, expected)) return undefined;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as Record<string, unknown>;
    if (typeof payload['exp'] === 'number' && payload['exp'] < Date.now()) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint an API token for a user. Valid for one year by default. */
export async function mintApiToken(
  userId: string,
  options: { ttlDays?: number; secret?: string } = {},
): Promise<string> {
  const cfg = config();
  const ttlDays = options.ttlDays ?? 365;
  return signToken(
    {
      sub: userId,
      iat: Date.now(),
      exp: Date.now() + ttlDays * 86_400_000,
      jti: newId('tok'),
    },
    options.secret ?? cfg.auth.secret,
  );
}

/**
 * Resolve the caller.
 *
 * In development with no credentials configured, requests fall back to a
 * `dev` principal so the API is explorable immediately. In production that
 * fallback is disabled — an unauthenticated production API would be a hole.
 */
export async function authenticate(
  request: Request,
  store: Store,
  options: { secret?: string; allowDev?: boolean } = {},
): Promise<Principal> {
  const cfg = config();
  const secret = options.secret ?? cfg.auth.secret;

  const header = request.headers['authorization'] ?? '';
  const apiKey = request.headers['x-agentready-key'];

  let userId: string | undefined;
  let via: Principal['via'] | undefined;

  if (header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    const payload = await verifyToken(token, secret);
    if (typeof payload?.['sub'] === 'string') {
      userId = payload['sub'];
      via = 'bearer';
    }
  } else if (apiKey) {
    // A raw user id may be used as an API key in local development.
    userId = apiKey;
    via = 'api-key';
  }

  if (!userId) {
    // Dev fallback: an unauthenticated caller gets a free-plan principal so the
    // API is explorable on a laptop.
    //
    // Two guards, because this is the difference between a demo and a
    // wide-open production API:
    //   1. It is off whenever NODE_ENV is production OR test. An unset
    //      NODE_ENV defaults to 'development' in loadConfig, so an operator who
    //      forgets to set it is still protected by the explicit opt-in below.
    //   2. It additionally requires AGENTREADY_DEV_AUTH=true, so it cannot be
    //      turned on by accident.
    const explicitlyEnabled = /^(1|true|yes|on)$/i.test((process.env['AGENTREADY_DEV_AUTH'] ?? '').trim());
    const allowDev = options.allowDev ?? (explicitlyEnabled && cfg.env !== 'production' && cfg.env !== 'test');

    if (!allowDev) {
      throw new HttpError(
        401,
        'unauthorized',
        'Provide a bearer token in the Authorization header.',
        { hint: 'For local development, set AGENTREADY_DEV_AUTH=true.' },
      );
    }

    // Free, not business. A dev principal should exercise the same limits a
    // real free user hits, or local testing silently diverges from production.
    return { userId: 'dev', plan: 'free', via: 'dev' };
  }

  const user = await store.getUser(userId);
  return {
    userId,
    ...(user?.email ? { email: user.email } : {}),
    plan: user?.plan ?? 'free',
    via: via ?? 'dev',
  };
}

/** Ensure a user row exists for a principal, provisioning on first sight. */
export async function ensureUser(store: Store, principal: Principal): Promise<User> {
  const existing = await store.getUser(principal.userId);
  if (existing) return existing;

  return store.upsertUser({
    id: principal.userId,
    email: principal.email ?? `${principal.userId}@agentready.local`,
    plan: principal.plan,
  });
}

/**
 * Enforce the monthly scan quota.
 *
 * Free is 1 scan/month, which is the whole product pitch: you can see your
 * score but not run an unbounded crawler.
 */
export async function enforceScanQuota(store: Store, principal: Principal): Promise<void> {
  const quota = await store.quotaFor(principal.userId);
  if (quota.allowed) return;

  throw new HttpError(
    402,
    'quota_exceeded',
    `${quota.used}/${quota.limit} scans used this month on the ${quota.plan} plan.`,
    {
      plan: quota.plan,
      used: quota.used,
      limit: quota.limit,
      upgrade: 'https://agentready.dev/pricing',
      requiredPlan: principal.plan === 'free' ? 'starter' : 'business',
    },
  );
}

/** Convert a QuotaExceededError into a 402 HttpError. */
export function asHttpError(err: unknown): HttpError | undefined {
  if (err instanceof HttpError) return err;
  if (err instanceof QuotaExceededError) {
    return new HttpError(402, 'quota_exceeded', err.message, err.quota);
  }
  return undefined;
}

/** A stable id for anonymous visitors on the free tier. */
export function anonymousUserId(email: string): string {
  return newId('anon');
}

export function authErrorMessage(err: unknown): string {
  return errorMessage(err);
}