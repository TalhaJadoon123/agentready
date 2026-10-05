/**
 * Persistence.
 *
 * Two implementations behind one interface:
 *  - `SupabaseStore` — talks to Supabase's PostgREST API over `fetch`. No SDK
 *    needed, so it works in a Worker and on a laptop alike. Free tier.
 *  - `JsonFileStore` — a JSON file on disk. The default, so `docker compose up`
 *    and `npm test` work with no credentials at all.
 *
 * Plan limits are enforced here rather than in the routes, so the CLI and the
 * API get identical quota behaviour.
 */

import type { AgentEvent, Grade, MCPRegistryEntry, Plan, ScanRecord, Site, User } from '@agentready/shared';
import { PLAN_LIMITS, config, errorMessage, hasApiKey, newId } from '@agentready/shared';

export interface QuotaStatus {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  plan: Plan;
  reason?: string;
}

export interface Store {
  readonly kind: 'supabase' | 'file';

  init(): Promise<void>;

  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  upsertUser(user: Omit<User, 'createdAt'> & { createdAt?: string }): Promise<User>;
  setUserPlan(userId: string, plan: Plan): Promise<User>;

  // Sites
  createSite(site: Omit<Site, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<Site>;
  getSite(id: string): Promise<Site | undefined>;
  listSites(userId: string): Promise<Site[]>;
  /**
   * Every site across every user, newest first.
   *
   * Used by the public verification page, which must resolve a site by URL
   * rather than by owner. Never call this from a per-user endpoint.
   */
  listAllSites(limit?: number): Promise<Site[]>;
  updateSite(id: string, patch: Partial<Omit<Site, 'id'>>): Promise<Site | undefined>;
  deleteSite(id: string): Promise<boolean>;

  // Scans
  createScan(record: Omit<ScanRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<ScanRecord>;
  listScans(siteId: string, limit?: number): Promise<ScanRecord[]>;
  latestScan(siteId: string): Promise<ScanRecord | undefined>;
  getScan(id: string): Promise<ScanRecord | undefined>;

  // MCP servers
  createMcpServer(entry: Omit<MCPRegistryEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<MCPRegistryEntry>;
  listMcpServers(siteId?: string): Promise<MCPRegistryEntry[]>;
  updateMcpServer(id: string, patch: Partial<Omit<MCPRegistryEntry, 'id'>>): Promise<MCPRegistryEntry | undefined>;
  recordMcpCall(id: string): Promise<MCPRegistryEntry | undefined>;

  // Agent events
  recordAgentEvent(event: Omit<AgentEvent, 'id' | 'ts'> & { id?: string; ts?: string }): Promise<AgentEvent>;
  listAgentEvents(siteId: string, since?: string): Promise<AgentEvent[]>;

  /** Scans used in the current billing month for a user. */
  countScansThisMonth(userId: string): Promise<number>;
  quotaFor(userId: string): Promise<QuotaStatus>;
  /** Assert a scan is allowed, throwing HttpError(402) when it is not. */
  assertScanAllowed(userId: string): Promise<QuotaStatus>;

  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/** Plan for a user id, defaulting to free. */
export async function resolvePlan(store: Store, userId: string): Promise<Plan> {
  const user = await store.getUser(userId);
  return user?.plan ?? 'free';
}

/** Scans used since the first day of the current month. */
export function isThisMonth(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

export async function quotaForPlan(store: Store, userId: string, plan: Plan): Promise<QuotaStatus> {
  const limits = PLAN_LIMITS[plan];
  const sites = await store.listSites(userId);
  let used = 0;
  for (const site of sites) {
    const scans = await store.listScans(site.id, 1000);
    used += scans.filter((s) => isThisMonth(s.createdAt)).length;
  }

  return {
    allowed: used < limits.scansPerMonth,
    used,
    limit: limits.scansPerMonth,
    remaining: Math.max(0, limits.scansPerMonth - used),
    plan,
    ...(used >= limits.scansPerMonth
      ? { reason: `Free plan includes ${limits.scansPerMonth} scan${limits.scansPerMonth === 1 ? '' : 's'} per month.` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Supabase (PostgREST over fetch)
// ---------------------------------------------------------------------------

interface SupabaseConfig {
  url: string;
  key: string;
}

/** Supabase-backed store using PostgREST. */
export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;

  constructor(private readonly cfg: SupabaseConfig) {}

  async init(): Promise<void> {
    // Verify credentials with a cheap query so misconfiguration fails loudly
    // at boot rather than on the first user request.
    const res = await this.rest('/sites?select=id&limit=1');
    if (!res.ok && res.status !== 401 && res.status !== 403) {
      throw new Error(`Supabase connection failed (${res.status}): ${res.error ?? 'unknown error'}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('Supabase rejected the service role key. Check SUPABASE_SERVICE_ROLE_KEY.');
    }
  }

  private async rest(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
    try {
      const res = await fetch(`${this.cfg.url.replace(/\/$/, '')}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: this.cfg.key,
          authorization: `Bearer ${this.cfg.key}`,
          'content-type': 'application/json',
          prefer: 'return=representation',
          ...(init.headers ?? {}),
        },
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const message = Array.isArray(data)
          ? ((data[0] as { message?: string })?.message ?? '')
          : ((data as { message?: string })?.message ?? text);
        return { ok: false, status: res.status, error: message.slice(0, 300) };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, error: errorMessage(err) };
    }
  }

  private async insert<T>(table: string, row: Record<string, unknown>): Promise<T | undefined> {
    const res = await this.rest(table, { method: 'POST', body: JSON.stringify(row) });
    const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    return rows[0] as T | undefined;
  }

  private async select<T>(table: string, query: string): Promise<T[]> {
    const res = await this.rest(`${table}?${query}`);
    return Array.isArray(res.data) ? (res.data as T[]) : [];
  }

  private async patch<T>(table: string, query: string, body: Record<string, unknown>): Promise<T | undefined> {
    const res = await this.rest(`${table}?${query}`, { method: 'PATCH', body: JSON.stringify(body) });
    const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    return rows[0] as T | undefined;
  }

  async getUser(id: string): Promise<User | undefined> {
    const rows = await this.select<User>('users', `id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return rows[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const rows = await this.select<User>('users', `email=eq.${encodeURIComponent(email)}&select=*&limit=1`);
    return rows[0];
  }

  async upsertUser(user: Omit<User, 'createdAt'> & { createdAt?: string }): Promise<User> {
    const createdAt = user.createdAt ?? new Date().toISOString();
    const existing = await this.getUser(user.id);
    if (existing) {
      const updated = await this.patch<User>('users', `id=eq.${encodeURIComponent(user.id)}`, { ...user, createdAt });
      return (updated ?? { ...existing, ...user, createdAt }) as User;
    }
    const inserted = await this.insert<User>('users', { ...user, createdAt });
    return (inserted ?? { ...user, createdAt }) as User;
  }

  async setUserPlan(userId: string, plan: Plan): Promise<User> {
    const updated = await this.patch<User>('users', `id=eq.${encodeURIComponent(userId)}`, { plan });
    const existing = await this.getUser(userId);
    return (updated ?? { ...(existing ?? { id: userId, email: '' }), plan }) as User;
  }

  async createSite(site: Omit<Site, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<Site> {
    const row = { ...site, id: site.id ?? newId('site'), createdAt: site.createdAt ?? new Date().toISOString() };
    return (await this.insert<Site>('sites', row)) ?? (row as Site);
  }

  async getSite(id: string): Promise<Site | undefined> {
    const rows = await this.select<Site>('sites', `id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return rows[0];
  }

  async listSites(userId: string): Promise<Site[]> {
    return this.select<Site>('sites', `user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`);
  }

  async listAllSites(limit = 500): Promise<Site[]> {
    const res = await this.select<Site>('sites', `order=created_at.desc&limit=${limit}`);
    return res;
  }

  async updateSite(id: string, patch: Partial<Omit<Site, 'id'>>): Promise<Site | undefined> {
    // Supabase columns are snake_case; convert the camelCase patch.
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      row[toSnake(key)] = value;
    }
    return this.patch<Site>('sites', `id=eq.${encodeURIComponent(id)}`, row);
  }

  async deleteSite(id: string): Promise<boolean> {
    const res = await this.rest(`sites?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.ok;
  }

  async createScan(record: Omit<ScanRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<ScanRecord> {
    const row = { ...record, id: record.id ?? newId('scan'), createdAt: record.createdAt ?? new Date().toISOString() };
    return (await this.insert<ScanRecord>('scans', row)) ?? (row as ScanRecord);
  }

  async listScans(siteId: string, limit = 20): Promise<ScanRecord[]> {
    return this.select<ScanRecord>(
      'scans',
      `site_id=eq.${encodeURIComponent(siteId)}&order=created_at.desc&limit=${limit}`,
    );
  }

  async latestScan(siteId: string): Promise<ScanRecord | undefined> {
    const scans = await this.listScans(siteId, 1);
    return scans[0];
  }

  async getScan(id: string): Promise<ScanRecord | undefined> {
    const rows = await this.select<ScanRecord>('scans', `id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return rows[0];
  }

  async createMcpServer(entry: Omit<MCPRegistryEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<MCPRegistryEntry> {
    const row = { ...entry, id: entry.id ?? newId('mcp'), createdAt: entry.createdAt ?? new Date().toISOString() };
    return (await this.insert<MCPRegistryEntry>('mcp_servers', row)) ?? (row as MCPRegistryEntry);
  }

  async listMcpServers(siteId?: string): Promise<MCPRegistryEntry[]> {
    const query = siteId
      ? `site_id=eq.${encodeURIComponent(siteId)}&order=created_at.desc`
      : `order=created_at.desc`;
    return this.select<MCPRegistryEntry>('mcp_servers', query);
  }

  async updateMcpServer(id: string, patch: Partial<Omit<MCPRegistryEntry, 'id'>>): Promise<MCPRegistryEntry | undefined> {
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      row[toSnake(key)] = value;
    }
    return this.patch<MCPRegistryEntry>('mcp_servers', `id=eq.${encodeURIComponent(id)}`, row);
  }

  async recordMcpCall(id: string): Promise<MCPRegistryEntry | undefined> {
    const existing = (await this.listMcpServers()).find((m) => m.id === id);
    if (!existing) return undefined;
    return this.updateMcpServer(id, { rpcCalls: existing.rpcCalls + 1 });
  }

  async recordAgentEvent(event: Omit<AgentEvent, 'id' | 'ts'> & { id?: string; ts?: string }): Promise<AgentEvent> {
    const row = { ...event, id: event.id ?? newId('evt'), ts: event.ts ?? new Date().toISOString() };
    return (await this.insert<AgentEvent>('agent_events', row)) ?? (row as AgentEvent);
  }

  async listAgentEvents(siteId: string, since?: string): Promise<AgentEvent[]> {
    const query = since
      ? `site_id=eq.${encodeURIComponent(siteId)}&ts=gte.${encodeURIComponent(since)}&order=ts.desc&limit=1000`
      : `site_id=eq.${encodeURIComponent(siteId)}&order=ts.desc&limit=1000`;
    return this.select<AgentEvent>('agent_events', query);
  }

  async countScansThisMonth(userId: string): Promise<number> {
    const sites = await this.listSites(userId);
    let count = 0;
    for (const site of sites) {
      const scans = await this.listScans(site.id, 1000);
      count += scans.filter((s) => isThisMonth(s.createdAt)).length;
    }
    return count;
  }

  async quotaFor(userId: string): Promise<QuotaStatus> {
    return quotaForPlan(this, userId, await resolvePlan(this, userId));
  }

  async assertScanAllowed(userId: string): Promise<QuotaStatus> {
    const quota = await this.quotaFor(userId);
    if (!quota.allowed) {
      throw new QuotaExceededError(quota);
    }
    return quota;
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}

/** Thrown when a user has exhausted their monthly scans. */
export class QuotaExceededError extends Error {
  constructor(readonly quota: QuotaStatus) {
    super(quota.reason ?? 'Scan quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

function toSnake(input: string): string {
  return input.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// ---------------------------------------------------------------------------
// JSON file store
// ---------------------------------------------------------------------------

interface FileData {
  users: User[];
  sites: Site[];
  scans: ScanRecord[];
  mcpServers: MCPRegistryEntry[];
  agentEvents: AgentEvent[];
}

/** File-backed store. The default so nothing external is required. */
export class JsonFileStore implements Store {
  readonly kind = 'file' as const;
  private data: FileData = { users: [], sites: [], scans: [], mcpServers: [], agentEvents: [] };
  /** Serialises writes so concurrent requests cannot corrupt the file. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    const { readFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<FileData>;
      this.data = {
        users: parsed.users ?? [],
        sites: parsed.sites ?? [],
        scans: parsed.scans ?? [],
        mcpServers: parsed.mcpServers ?? [],
        agentEvents: parsed.agentEvents ?? [],
      };
    } catch {
      await mkdir(dirname(this.path), { recursive: true });
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8');
    });
    // Keep the queue alive even if one write fails.
    this.writeQueue = write.catch(() => undefined);
    return this.writeQueue;
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.data.users.find((u) => u.id === id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return this.data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  }

  async upsertUser(user: Omit<User, 'createdAt'> & { createdAt?: string }): Promise<User> {
    const createdAt = user.createdAt ?? new Date().toISOString();
    const existing = this.data.users.find((u) => u.id === user.id);
    if (existing) {
      Object.assign(existing, user);
      await this.flush();
      return existing;
    }
    const created = { ...user, createdAt } as User;
    this.data.users.push(created);
    await this.flush();
    return created;
  }

  async setUserPlan(userId: string, plan: Plan): Promise<User> {
    const user = this.data.users.find((u) => u.id === userId);
    if (!user) throw new Error(`No such user: ${userId}`);
    user.plan = plan;
    await this.flush();
    return user;
  }

  async createSite(site: Omit<Site, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<Site> {
    const created = { ...site, id: site.id ?? newId('site'), createdAt: site.createdAt ?? new Date().toISOString() } as Site;
    this.data.sites.push(created);
    await this.flush();
    return created;
  }

  async getSite(id: string): Promise<Site | undefined> {
    return this.data.sites.find((s) => s.id === id);
  }

  async listSites(userId: string): Promise<Site[]> {
    return this.data.sites
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listAllSites(limit = 500): Promise<Site[]> {
    return [...this.data.sites]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async updateSite(id: string, patch: Partial<Omit<Site, 'id'>>): Promise<Site | undefined> {
    const site = this.data.sites.find((s) => s.id === id);
    if (!site) return undefined;
    Object.assign(site, patch);
    await this.flush();
    return site;
  }

  async deleteSite(id: string): Promise<boolean> {
    const before = this.data.sites.length;
    this.data.sites = this.data.sites.filter((s) => s.id !== id);
    this.data.scans = this.data.scans.filter((s) => s.siteId !== id);
    this.data.mcpServers = this.data.mcpServers.filter((m) => m.siteId !== id);
    await this.flush();
    return this.data.sites.length < before;
  }

  async createScan(record: Omit<ScanRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<ScanRecord> {
    const created = {
      ...record,
      id: record.id ?? newId('scan'),
      createdAt: record.createdAt ?? new Date().toISOString(),
    } as ScanRecord;
    this.data.scans.push(created);
    await this.flush();
    return created;
  }

  async listScans(siteId: string, limit = 20): Promise<ScanRecord[]> {
    return this.data.scans
      .filter((s) => s.siteId === siteId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async latestScan(siteId: string): Promise<ScanRecord | undefined> {
    const scans = await this.listScans(siteId, 1);
    return scans[0];
  }

  async getScan(id: string): Promise<ScanRecord | undefined> {
    return this.data.scans.find((s) => s.id === id);
  }

  async createMcpServer(entry: Omit<MCPRegistryEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<MCPRegistryEntry> {
    const created = {
      ...entry,
      id: entry.id ?? newId('mcp'),
      createdAt: entry.createdAt ?? new Date().toISOString(),
    } as MCPRegistryEntry;
    this.data.mcpServers.push(created);
    await this.flush();
    return created;
  }

  async listMcpServers(siteId?: string): Promise<MCPRegistryEntry[]> {
    const list = siteId ? this.data.mcpServers.filter((m) => m.siteId === siteId) : this.data.mcpServers;
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateMcpServer(id: string, patch: Partial<Omit<MCPRegistryEntry, 'id'>>): Promise<MCPRegistryEntry | undefined> {
    const entry = this.data.mcpServers.find((m) => m.id === id);
    if (!entry) return undefined;
    Object.assign(entry, patch);
    await this.flush();
    return entry;
  }

  async recordMcpCall(id: string): Promise<MCPRegistryEntry | undefined> {
    const entry = this.data.mcpServers.find((m) => m.id === id);
    if (!entry) return undefined;
    entry.rpcCalls += 1;
    await this.flush();
    return entry;
  }

  async recordAgentEvent(event: Omit<AgentEvent, 'id' | 'ts'> & { id?: string; ts?: string }): Promise<AgentEvent> {
    const created = { ...event, id: event.id ?? newId('evt'), ts: event.ts ?? new Date().toISOString() } as AgentEvent;
    this.data.agentEvents.push(created);
    // Keep the log bounded; this is a metrics stream, not an audit trail.
    if (this.data.agentEvents.length > 10_000) {
      this.data.agentEvents = this.data.agentEvents.slice(-5_000);
    }
    await this.flush();
    return created;
  }

  async listAgentEvents(siteId: string, since?: string): Promise<AgentEvent[]> {
    return this.data.agentEvents
      .filter((e) => e.siteId === siteId)
      .filter((e) => !since || e.ts >= since)
      .sort((a, b) => b.ts.localeCompare(a.ts));
  }

  async countScansThisMonth(userId: string): Promise<number> {
    const sites = await this.listSites(userId);
    let count = 0;
    for (const site of sites) {
      count += (await this.listScans(site.id, 1000)).filter((s) => isThisMonth(s.createdAt)).length;
    }
    return count;
  }

  async quotaFor(userId: string): Promise<QuotaStatus> {
    return quotaForPlan(this, userId, await resolvePlan(this, userId));
  }

  async assertScanAllowed(userId: string): Promise<QuotaStatus> {
    const quota = await this.quotaFor(userId);
    if (!quota.allowed) throw new QuotaExceededError(quota);
    return quota;
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Pick the store implementation from configuration. */
export function createStore(options: { forceFile?: boolean; path?: string } = {}): Store {
  const cfg = config();

  if (!options.forceFile && hasApiKey(cfg.db.supabaseUrl) && hasApiKey(cfg.db.supabaseServiceRoleKey)) {
    return new SupabaseStore({
      url: cfg.db.supabaseUrl as string,
      key: cfg.db.supabaseServiceRoleKey as string,
    });
  }

  return new JsonFileStore(options.path ?? process.env.AGENTREADY_DB_PATH ?? './data/agentready.json');
}

/** The SQL schema for Supabase. Applied by the migrator and documented in the README. */
export const SUPABASE_SCHEMA_SQL = `-- AgentReady schema for Supabase (free tier)
-- Run in the Supabase SQL editor, or via: npm run db:migrate

create table if not exists users (
  id          text primary key,
  email       text not null unique,
  name        text,
  image       text,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

create table if not exists sites (
  id                 text primary key,
  user_id            text not null references users(id) on delete cascade,
  url                text not null,
  name               text not null,
  mcp_server_url     text,
  verification_token text,
  verified_at        timestamptz,
  plan               text,
  created_at         timestamptz not null default now()
);
create index if not exists sites_user_id_idx on sites(user_id);

create table if not exists scans (
  id          text primary key,
  site_id     text not null references sites(id) on delete cascade,
  url         text not null,
  score       integer not null,
  grade       text not null,
  result      jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists scans_site_id_idx on scans(site_id, created_at desc);

create table if not exists mcp_servers (
  id               text primary key,
  site_id          text references sites(id) on delete cascade,
  name             text not null,
  url              text not null,
  version          text not null,
  tool_count       integer not null default 0,
  rpc_calls        integer not null default 0,
  monthly_limit    integer not null default 25000,
  status           text not null default 'live',
  created_at       timestamptz not null default now(),
  last_checked_at  timestamptz
);
create index if not exists mcp_servers_site_id_idx on mcp_servers(site_id);

create table if not exists agent_events (
  id            text primary key,
  site_id       text not null references sites(id) on delete cascade,
  ts            timestamptz not null default now(),
  agent         text not null,
  tool          text not null,
  revenue_cents integer not null default 0,
  duration_ms   integer not null default 0,
  ok            boolean not null default true,
  meta          jsonb
);
create index if not exists agent_events_site_id_idx on agent_events(site_id, ts desc);

-- Row Level Security: every table is private to its owner. The service role key
-- bypasses RLS (which is what the API uses); these policies protect any direct
-- browser access through the Supabase client.
alter table users        enable row level security;
alter table sites        enable row level security;
alter table scans        enable row level security;
alter table mcp_servers  enable row level security;
alter table agent_events enable row level security;

create policy "own users"        on users        for all using (id = (auth.jwt()->>'id'));
create policy "own sites"        on sites        for all using (user_id = (auth.jwt()->>'id'));
create policy "own scans"        on scans        for all using (
  site_id in (select id from sites where user_id = (auth.jwt()->>'id'))
);
create policy "own mcp servers"  on mcp_servers  for all using (
  site_id in (select id from sites where user_id = (auth.jwt()->>'id'))
);
create policy "own agent events" on agent_events for all using (
  site_id in (select id from sites where user_id = (auth.jwt()->>'id'))
);
`;

/** Grade thresholds, re-exported so routes can label results consistently. */
export const GRADES: Grade[] = ['A+', 'A', 'B', 'C', 'D', 'F'];