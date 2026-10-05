/**
 * AgentReady shared type contract.
 *
 * Every package (core, schema, mcp, registry, verify, api, cli, web) imports
 * from here. Keep this file dependency-free and JSON-serialisable.
 */

// ---------------------------------------------------------------------------
// Core scanning
// ---------------------------------------------------------------------------

/** Severity of a single readiness check. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** The eight pillars an agent-readiness score is built from. */
export type CheckId =
  | 'structured-data'
  | 'mcp-server'
  | 'agent-content'
  | 'pricing'
  | 'availability'
  | 'transactability'
  | 'auth'
  | 'rate-limit';

/** Maximum points each check contributes to the 0-100 score. */
export type CheckIdCounted =
  | 'structured-data'
  | 'mcp-server'
  | 'agent-content'
  | 'pricing'
  | 'availability'
  | 'transactability'
  | 'auth'
  | 'rate-limit';

/** Result of one readiness check. */
export interface CheckResult {
  /** Stable identifier, matches the source module. */
  id: CheckId;
  /** Human label shown in reports. */
  title: string;
  status: CheckStatus;
  /** Points awarded out of `maxPoints`. */
  points: number;
  maxPoints: number;
  /** One-sentence explanation written for a site owner. */
  summary: string;
  /** Concrete, copy-pasteable remediation steps. */
  fixes: string[];
  /** Supporting machine-readable evidence. */
  evidence: Record<string, unknown>;
  /** ISO timestamp. */
  checkedAt: string;
}

/** A concrete, prioritized problem the site owner should fix. */
export interface Gap {
  id: string;
  checkId: CheckId;
  title: string;
  description: string;
  /** Higher = fix this first. Derived from points lost x effort. */
  impact: number;
  /** Estimated minutes to fix. */
  effortMinutes: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Copy-pasteable remediation (JSON-LD, HTML snippet, CLI command...). */
  patch?: string;
}

/** The headline result of a site scan. */
export interface ScanResult {
  url: string;
  score: number;
  checks: CheckResult[];
  gaps: Gap[];
  mcpServer?: MCPServerInfo;
  /** Present on enriched scans. */
  grade?: Grade;
  recommendations?: string[];
  scannedAt?: string;
  durationMs?: number;
  userAgent?: string;
  version?: string;
}

export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface MCPTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for structured output, when the tool defines one. */
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface MCPServerInfo {
  url: string;
  tools: MCPTool[];
  status: 'live' | 'down';
  /** Extra transport/protocol detail. */
  transport?: 'http' | 'sse' | 'stdio' | 'unknown';
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  latencyMs?: number;
  error?: string;
  checkedAt?: string;
}

/** Source dataset the MCP server is generated from. */
export type DataSourceKind = 'csv' | 'json' | 'api' | 'scrape';

export interface DataSource {
  kind: DataSourceKind;
  /** file path, remote URL, or CSS/URL selector target. */
  location: string;
  /** How records map to MCP entities. */
  mapping: Record<string, string>;
  options?: Record<string, unknown>;
}

export interface MCPServerSpec {
  name: string;
  version: string;
  description: string;
  tools: MCPTool[];
  dataSource: DataSource;
  /** Where this was deployed, if deployed. */
  deployment?: DeploymentResult;
}

export interface DeploymentResult {
  provider: 'cloudflare' | 'smithery' | 'local';
  url: string;
  status: 'live' | 'pending' | 'failed';
  region?: string;
  logs?: string[];
  deployedAt?: string;
}

// ---------------------------------------------------------------------------
// Agent simulation / verification
// ---------------------------------------------------------------------------

/** One agent-style query replayed against a site. */
export interface Simulation {
  query: string;
  results: any[];
  source: string;
  rank: number;
  /** Was the target site returned at all? */
  found: boolean;
  /** 0-100 confidence the answer is usable by an agent. */
  answerability: number;
  latencyMs?: number;
  tokensUsed?: number;
  model?: string;
  error?: string;
}

export interface SimulationReport {
  target: string;
  competitors: string[];
  queries: Simulation[];
  /** Share of queries where the target outranked the competitors. */
  winRate: number;
  averageRank: number;
  answerability: number;
  /** 0-100 composite visibility score. */
  visibilityScore: number;
  bySource: Record<string, { found: number; total: number; avgRank: number }>;
  model: string;
  simulatedAt: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type RegistryName = 'official' | 'smithery' | 'mcp-so';

export interface RegistryTarget {
  name: RegistryName;
  label: string;
  url: string;
  /** Free tier limits. */
  limits: string;
  docs: string;
  authRequired: boolean;
}

export interface RegistrySubmission {
  id: string;
  serverName: string;
  name: RegistryName;
  status: 'pending' | 'submitted' | 'live' | 'rejected' | 'error' | 'dry-run';
  url?: string;
  submittedAt?: string;
  response?: unknown;
  error?: string;
  logs?: string[];
}

export interface RegistryStatus {
  name: RegistryName;
  label: string;
  state: 'unknown' | 'synced' | 'drifted' | 'missing' | 'error';
  listed: boolean;
  url?: string;
  version?: string;
  lastChecked?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Monitoring / alerting
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  source: 'uptime' | 'scan' | 'mcp' | 'registry' | 'billing' | 'verification';
  title: string;
  message: string;
  createdAt: string;
  delivered?: string[];
  resolved?: boolean;
}

export interface UptimeSample {
  checkedAt: string;
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
  region?: string;
}

export interface UptimeReport {
  target: string;
  samples: UptimeSample[];
  uptimeRatio: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalChecks: number;
  failedChecks: number;
  from: string;
  to: string;
}

export interface ErrorBucket {
  fingerprint: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  tool?: string;
}

// ---------------------------------------------------------------------------
// Products / schema.org (used by schema + mcp generators)
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  name: string;
  description: string;
  sku?: string;
  gtin?: string;
  mpn?: string;
  brand?: string;
  category?: string;
  price: number;
  currency: string;
  availability: 'InStock' | 'OutOfStock' | 'PreOrder' | 'BackOrder' | 'Discontinued';
  image?: string | string[];
  url?: string;
  rating?: { value: number; count: number };
  specs?: Record<string, string | number | boolean>;
  weight?: { value: number; unit: string };
  /** Untyped extras preserved through generation. */
  extra?: Record<string, unknown>;
}

export interface Offer {
  price: number;
  currency: string;
  availability: Product['availability'];
  priceValidUntil?: string;
  url?: string;
  seller?: string;
  shippingDetails?: {
    shippingRate?: number;
    shippingCurrency?: string;
    deliveryTime?: { min: number; max: number; unit: string };
  };
  warranty?: string;
}

export interface Service {
  name: string;
  description: string;
  provider: string;
  serviceType?: string;
  areaServed?: string | string[];
  providerMobility?: 'fixed' | 'mobile' | 'on_site';
  offers?: Offer[];
  url?: string;
  image?: string;
}

export interface Organization {
  name: string;
  legalName?: string;
  url: string;
  logo?: string;
  description?: string;
  email?: string;
  telephone?: string;
  address?: PostalAddress;
  sameAs?: string[];
  contactPoint?: ContactPoint[];
}

export interface PostalAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
  /** schema.org allows a raw address string in some profiles. */
  [key: string]: string | undefined;
}

export interface ContactPoint {
  '@type': 'ContactPoint';
  contactType: string;
  email?: string;
  telephone?: string;
  areaServed?: string;
  availableLanguage?: string | string[];
  url?: string;
  [key: string]: unknown;
}

export interface LocalBusiness {
  '@type': string;
  name: string;
  description?: string;
  url?: string;
  telephone?: string;
  email?: string;
  image?: string | string[];
  priceRange?: string;
  address: PostalAddress;
  geo?: { latitude: number; longitude: number };
  openingHoursSpecification?: OpeningHours[];
  sameAs?: string[];
}

export interface OpeningHours {
  '@type': 'OpeningHoursSpecification';
  dayOfWeek: string | string[];
  opens: string;
  closes: string;
}

// ---------------------------------------------------------------------------
// Accounts / billing
// ---------------------------------------------------------------------------

export type Plan = 'free' | 'starter' | 'business';

export interface User {
  id: string;
  email: string;
  name?: string;
  image?: string;
  plan: Plan;
  createdAt: string;
  stripeCustomerId?: string;
  polarCustomerId?: string;
}

export interface Site {
  id: string;
  userId: string;
  url: string;
  name: string;
  createdAt: string;
  /** Where the generated MCP server lives. */
  mcpServerUrl?: string;
  /** Verification token placed in a well-known file or meta tag. */
  verificationToken?: string;
  verifiedAt?: string;
  plan?: Plan;
}

export interface ScanRecord {
  id: string;
  siteId: string;
  url: string;
  score: number;
  grade: Grade;
  createdAt: string;
  result: ScanResult;
}

export interface MCPRegistryEntry {
  id: string;
  siteId: string;
  name: string;
  url: string;
  version: string;
  toolCount: number;
  rpcCalls: number;
  monthlyLimit: number;
  status: 'live' | 'down' | 'pending';
  createdAt: string;
  lastCheckedAt?: string;
}

export interface AgentEvent {
  id: string;
  siteId: string;
  ts: string;
  /** Which agent/tool made the call. */
  agent: string;
  tool: string;
  /** Estimated revenue attributed to this agent call, in cents. */
  revenueCents: number;
  durationMs: number;
  ok: boolean;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ScanRequest {
  url: string;
  /** Skip network calls to external registries (used in tests/free tier). */
  deep?: boolean;
  userId?: string;
  siteId?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface GenerateMcpRequest {
  userId: string;
  siteId?: string;
  serverName: string;
  source: DataSource;
  entities?: Product[];
  deploy?: boolean;
  target?: 'cloudflare' | 'smithery';
}

export interface PublishRequest {
  userId: string;
  siteId: string;
  /** Snippet style for injection. */
  platform: 'wordpress' | 'shopify' | 'next' | 'custom' | 'html';
  entities?: { organization?: Organization; products?: Product[]; services?: Service[]; localBusiness?: LocalBusiness };
}

export interface RegisterRequest {
  userId: string;
  siteId: string;
  serverName: string;
  serverUrl: string;
  targets?: RegistryName[];
  dryRun?: boolean;
}

export interface SimulateRequest {
  userId?: string;
  target: string;
  competitors?: string[];
  queries?: string[];
  /** Which simulated agent personas to run. */
  personas?: string[];
}

export interface MonitorRequest {
  target: string;
  lookbackHours?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical display names for each pillar. */
export const CHECK_TITLES: Record<CheckId, string> = {
  'structured-data': 'Structured data (schema.org)',
  'mcp-server': 'MCP server',
  'agent-content': 'Agent-readable content',
  pricing: 'Pricing transparency',
  availability: 'Availability signals',
  transactability: 'Transactability',
  auth: 'Machine authentication',
  'rate-limit': 'Rate limiting & docs',
};

/**
 * Points each check contributes at full pass. Totals to 100.
 * Ordered by how strongly the pillar predicts agent traffic.
 */
export const CHECK_MAX_POINTS: Record<CheckIdCounted, number> = {
  'structured-data': 20,
  'mcp-server': 20,
  'agent-content': 12,
  pricing: 14,
  availability: 10,
  transactability: 12,
  auth: 7,
  'rate-limit': 5,
};

export const CHECK_IDS: CheckIdCounted[] = [
  'structured-data',
  'mcp-server',
  'agent-content',
  'pricing',
  'availability',
  'transactability',
  'auth',
  'rate-limit',
];

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

/** Score -> letter grade boundaries (descending). */
export const GRADE_THRESHOLDS: ReadonlyArray<readonly [number, Grade]> = [
  [95, 'A+'],
  [85, 'A'],
  [70, 'B'],
  [55, 'C'],
  [40, 'D'],
  [0, 'F'],
];

export const PLAN_LIMITS: Record<Plan, { scansPerMonth: number; mcpServers: number; monitors: number; priceCents: number }> = {
  free: { scansPerMonth: 1, mcpServers: 0, monitors: 0, priceCents: 0 },
  starter: { scansPerMonth: 50, mcpServers: 1, monitors: 5, priceCents: 4900 },
  business: { scansPerMonth: 1000, mcpServers: 10, monitors: 50, priceCents: 14900 },
};