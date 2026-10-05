/**
 * Environment configuration.
 *
 * Every integration has a free tier, so nothing here is required to boot.
 * Missing keys degrade gracefully (features report "not configured" instead
 * of throwing) — this keeps `docker compose up` working on a fresh clone.
 */

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  webOrigin: string;
  publicApiUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  db: {
    url?: string;
    supabaseUrl?: string;
    supabaseServiceRoleKey?: string;
    supabaseAnonKey?: string;
    autoMigrate: boolean;
  };
  auth: {
    secret: string;
    githubId?: string;
    githubSecret?: string;
    googleClientId?: string;
    googleClientSecret?: string;
    resendApiKey?: string;
  };
  groq: {
    apiKey?: string;
    model: string;
    fallbackModel: string;
  };
  email: {
    provider: 'resend' | 'console';
    from: string;
    alertEmail?: string;
  };
  cloudflare: {
    apiToken?: string;
    accountId?: string;
    subdomain: string;
  };
  smithery: {
    apiKey?: string;
    profile: string;
  };
  registries: {
    officialUrl: string;
    officialGithubToken?: string;
    smitheryUrl: string;
    mcpSoUrl: string;
  };
  billing: {
    provider: 'polar' | 'lemonsqueezy' | 'none';
    polarApiKey?: string;
    polarWebhookSecret?: string;
    lemonSqueezyApiKey?: string;
    lemonSqueezyStoreId?: string;
    lemonSqueezyWebhookSecret?: string;
    starterPriceId?: string;
    businessPriceId?: string;
  };
  uptimeflare: {
    apiKey?: string;
    siteId?: string;
  };
  site: {
    url: string;
    name: string;
    supportEmail: string;
  };
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback = ''): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function optional(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function num(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const v = env[key]?.trim().toLowerCase();
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Parse a value that may be JSON (arrays/objects) or comma-separated list. */
export function list(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) return fallback;
  const t = value.trim();
  if (!t) return fallback;
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* fall through to CSV parsing */
    }
  }
  return t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read config from a plain env record. Supports an optional `.env` file so the
 * CLI works without the user exporting variables first.
 */
export function loadConfig(env: Env = process.env as Env): Config {
  const nodeEnv = oneOf(env, 'NODE_ENV', ['development', 'test', 'production'] as const, 'development');
  const port = num(env, 'PORT', 8787);

  return {
    env: nodeEnv,
    port,
    webOrigin: str(env, 'WEB_ORIGIN', 'http://localhost:3000'),
    publicApiUrl: str(env, 'PUBLIC_API_URL', `http://localhost:${port}`),
    logLevel: oneOf(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, nodeEnv === 'test' ? 'error' : 'info'),
    db: {
      url: optional(env, 'DATABASE_URL'),
      supabaseUrl: optional(env, 'SUPABASE_URL'),
      supabaseServiceRoleKey: optional(env, 'SUPABASE_SERVICE_ROLE_KEY'),
      supabaseAnonKey: optional(env, 'SUPABASE_ANON_KEY'),
      autoMigrate: bool(env, 'AUTO_MIGRATE', true),
    },
    auth: {
      secret: str(env, 'AUTH_SECRET', 'agentready-dev-secret-change-me'),
      githubId: optional(env, 'GITHUB_ID'),
      githubSecret: optional(env, 'GITHUB_SECRET'),
      googleClientId: optional(env, 'GOOGLE_CLIENT_ID'),
      googleClientSecret: optional(env, 'GOOGLE_CLIENT_SECRET'),
      resendApiKey: optional(env, 'RESEND_API_KEY'),
    },
    groq: {
      apiKey: optional(env, 'GROQ_API_KEY'),
      model: str(env, 'GROQ_MODEL', 'llama-3.3-70b-versatile'),
      fallbackModel: str(env, 'GROQ_FALLBACK_MODEL', 'llama-3.1-8b-instant'),
    },
    email: {
      provider: oneOf(env, 'EMAIL_PROVIDER', ['resend', 'console'] as const, optional(env, 'RESEND_API_KEY') ? 'resend' : 'console'),
      from: str(env, 'EMAIL_FROM', 'AgentReady <reports@agentready.dev>'),
      alertEmail: optional(env, 'ALERT_EMAIL'),
    },
    cloudflare: {
      apiToken: optional(env, 'CLOUDFLARE_API_TOKEN'),
      accountId: optional(env, 'CLOUDFLARE_ACCOUNT_ID'),
      subdomain: str(env, 'CLOUDFLARE_WORKERS_SUBDOMAIN', 'agentready'),
    },
    smithery: {
      apiKey: optional(env, 'SMITHERY_API_KEY'),
      profile: str(env, 'SMITHERY_PROFILE', 'agentready'),
    },
    registries: {
      officialUrl: str(env, 'MCP_REGISTRY_URL', 'https://registry.modelcontextprotocol.io'),
      officialGithubToken: optional(env, 'MCP_REGISTRY_GITHUB_TOKEN'),
      smitheryUrl: str(env, 'SMITHERY_REGISTRY_URL', 'https://smithery.ai'),
      mcpSoUrl: str(env, 'MCP_SO_URL', 'https://mcp.so'),
    },
    billing: {
      provider: oneOf(env, 'BILLING_PROVIDER', ['polar', 'lemonsqueezy', 'none'] as const, optional(env, 'POLAR_API_KEY') ? 'polar' : 'none'),
      polarApiKey: optional(env, 'POLAR_API_KEY'),
      polarWebhookSecret: optional(env, 'POLAR_WEBHOOK_SECRET'),
      lemonSqueezyApiKey: optional(env, 'LEMONSQUEEZY_API_KEY'),
      lemonSqueezyStoreId: optional(env, 'LEMONSQUEEZY_STORE_ID'),
      lemonSqueezyWebhookSecret: optional(env, 'LEMONSQUEEZY_WEBHOOK_SECRET'),
      starterPriceId: optional(env, 'STARTER_PRICE_ID'),
      businessPriceId: optional(env, 'BUSINESS_PRICE_ID'),
    },
    uptimeflare: {
      apiKey: optional(env, 'UPTIMEFLARE_API_KEY'),
      siteId: optional(env, 'UPTIMEFLARE_SITE_ID'),
    },
    site: {
      url: str(env, 'NEXT_PUBLIC_SITE_URL', 'http://localhost:3000'),
      name: str(env, 'NEXT_PUBLIC_APP_NAME', 'AgentReady'),
      supportEmail: str(env, 'NEXT_PUBLIC_SUPPORT_EMAIL', 'hello@agentready.dev'),
    },
  };
}

/** True when the integration has credentials we can actually use. */
export function hasApiKey(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

let cached: Config | undefined;

/** Process-wide cached config. */
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Replace the cached config (tests, CLI flags). */
export function setConfig(next: Config): Config {
  cached = next;
  return cached;
}

/** Drop the cache so the next `config()` re-reads the env. */
export function resetConfig(): void {
  cached = undefined;
}