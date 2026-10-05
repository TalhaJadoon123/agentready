/**
 * API routes.
 *
 * Shape follows the brief:
 *   POST /scan              — scan a site
 *   POST /generate/mcp     — generate an MCP server from a data source
 *   POST /publish           — produce schema.org snippets + llms.txt
 *   POST /register          — submit to the MCP registries
 *   POST /simulate          — simulate agent queries
 *   GET  /verify            — public verification status for a site
 *   GET  /monitor           — uptime + registry health
 */

import type {
  DataSource,
  LocalBusiness,
  Organization,
  Product,
  RegistryName,
  Service,
  Site,
} from '@agentready/shared';
import type { RegistryStatus } from '@agentready/shared';
import { config, normalizeUrl, originOf, scoreToGrade, truncate } from '@agentready/shared';
import { isRegistryName } from '@agentready/registry';
import { scanSite, enrichTarget, describeEnrichment } from '@agentready/core';
import { buildSchema, inject, validateSchema, generateLlmsTxt, generateServiceWithPlans } from '@agentready/schema';
import { generateMcpServer, deploy, DeployError } from '@agentready/mcp';
import { publishToAll, checkRegistryStatus } from '@agentready/registry';
import { simulateAgentVisibility, runBenchmark, monitorEndpoints, mcpHealthUrl } from '@agentready/verify';
import type { Request, App, Handler } from './http.js';
import { HttpError } from './http.js';
import type { Store, QuotaStatus } from './store.js';
import { authenticate, ensureUser, enforceScanQuota } from './auth.js';

// ---------------------------------------------------------------------------
// Validation helpers (no zod — these are the four shapes we accept)
// ---------------------------------------------------------------------------

function requireString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'invalid_request', `"${field}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(body: unknown, field: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalNumber(body: unknown, field: string): number | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function optionalArray(body: unknown, field: string): unknown[] {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return Array.isArray(value) ? value : [];
}

/** Validate the URL early so a typo does not turn into a confusing 500. */
function requireUrl(body: unknown, field = 'url'): string {
  const raw = requireString(body, field);
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, 'invalid_url', `"${raw}" is not a valid URL.`);
  }

  const host = url.hostname;
  // Require a real host: a dot (any TLD), or localhost / an IP for local testing.
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (!host.includes('.') && !isLocal && !isIp) {
    throw new HttpError(400, 'invalid_url', `"${raw}" is not a valid URL — "${host}" is not a hostname.`);
  }

  return normalizeUrl(raw);
}

/** Build a DataSource from the request body. */
function requireDataSource(body: unknown): DataSource {
  const source = (body as Record<string, unknown>)?.['source'] as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') {
    throw new HttpError(400, 'invalid_request', '"source" is required (CSV, JSON, API or scrape).');
  }

  const kind = source['kind'];
  if (kind !== 'csv' && kind !== 'json' && kind !== 'api' && kind !== 'scrape') {
    throw new HttpError(400, 'invalid_source', `source.kind must be one of: csv, json, api, scrape (got ${String(kind)}).`);
  }

  const location = source['location'];
  if (typeof location !== 'string' || location.trim() === '') {
    throw new HttpError(400, 'invalid_source', 'source.location is required (a file path or URL).');
  }

  const mapping =
    source['mapping'] && typeof source['mapping'] === 'object'
      ? (source['mapping'] as Record<string, string>)
      : {};

  return {
    kind,
    location: location.trim(),
    mapping,
    ...(source['options'] ? { options: source['options'] as Record<string, unknown> } : {}),
  };
}

function parseTargets(value: unknown): RegistryName[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const targets = list.map((v) => String(v).trim()).filter((v) => isRegistryName(v));
  return targets.length > 0 ? (targets as RegistryName[]) : (['official', 'smithery', 'mcp-so'] as RegistryName[]);
}

/** Coerce a loosely-shaped products array from a request body. */
function parseProducts(value: unknown): Product[] {
  const out: Product[] = [];
  for (const item of optionalArray({ products: value }, 'products')) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const name = typeof p['name'] === 'string' ? p['name'] : '';
    if (!name) continue;
    const price = Number(p['price']);
    out.push({
      id: String(p['id'] ?? name),
      name,
      description: typeof p['description'] === 'string' ? p['description'] : '',
      ...(p['sku'] ? { sku: String(p['sku']) } : {}),
      ...(p['brand'] ? { brand: String(p['brand']) } : {}),
      ...(p['category'] ? { category: String(p['category']) } : {}),
      price: Number.isFinite(price) ? price : 0,
      currency: typeof p['currency'] === 'string' ? p['currency'] : 'USD',
      availability:
        p['availability'] === 'OutOfStock' ||
        p['availability'] === 'PreOrder' ||
        p['availability'] === 'BackOrder' ||
        p['availability'] === 'Discontinued'
          ? p['availability']
          : 'InStock',
      ...(p['image'] ? { image: String(p['image']) } : {}),
      ...(p['url'] ? { url: String(p['url']) } : {}),
      ...(p['specs'] && typeof p['specs'] === 'object' ? { specs: p['specs'] as Record<string, string | number | boolean> } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface RouteOptions {
  store: Store;
  /** Skip auth and grant a business-plan dev principal. Tests use this. */
  devMode?: boolean;
}

export function registerRoutes(app: App, options: RouteOptions): void {
  const { store } = options;

  const principal = async (request: Request) => {
    const p = await authenticate(request, store, options.devMode ? { allowDev: true } : {});
    await ensureUser(store, p);
    return p;
  };

  // -- health / meta -------------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    version: '1.0.0',
    uptimeSeconds: Math.round(process.uptime?.() ?? 0),
    store: store.kind,
  }));

  app.get('/', async () => ({
    name: 'AgentReady API',
    version: '1.0.0',
    description: 'SEO for agents. Make your website discoverable and consumable by AI agents.',
    endpoints: [
      'POST /scan',
      'POST /generate/mcp',
      'POST /publish',
      'POST /register',
      'POST /simulate',
      'GET  /verify',
      'GET  /monitor',
    ],
  }));

  app.get('/config', async () => {
    const cfg = config();
    return {
      // Which integrations are usable. Deliberately no secret values.
      integrations: {
        groq: Boolean(cfg.groq.apiKey),
        supabase: Boolean(cfg.db.supabaseUrl && cfg.db.supabaseServiceRoleKey),
        cloudflare: Boolean(cfg.cloudflare.apiToken),
        smithery: Boolean(cfg.smithery.apiKey),
        officialRegistryToken: Boolean(cfg.registries.officialGithubToken),
        resend: Boolean(cfg.auth.resendApiKey),
        uptimeflare: Boolean(cfg.uptimeflare.apiKey),
        billing: cfg.billing.provider,
      },
      limits: {
        free: '1 scan/month',
        starter: '$49/mo — 50 scans, 1 MCP server, 5 monitors',
        business: '$149/mo — 1000 scans, 10 MCP servers, 50 monitors',
      },
    };
  });

  app.get('/quota', async (request) => {
    const p = await principal(request);
    return store.quotaFor(p.userId);
  });

  // -- POST /scan ----------------------------------------------------------

  app.post('/scan', async (request): Promise<unknown> => {
    const p = await principal(request);
    const body = request.body;

    // Quota: free plan gets exactly one scan per month.
    await enforceScanQuota(store, p);

    const url = requireUrl(body);
    const timeoutMs = optionalNumber(body, 'timeoutMs') ?? 15_000;

    let result;
    try {
      const onlyChecks = (body as Record<string, unknown> | undefined)?.['onlyChecks'];
      result = await scanSite(url, {
        timeoutMs,
        ...(Array.isArray(onlyChecks) ? { onlyChecks: onlyChecks as never } : {}),
      });
    } catch (err) {
      throw new HttpError(502, 'scan_failed', `Could not scan ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Persist when the caller owns a site record.
    let siteId = optionalString(body, 'siteId');
    if (!siteId) siteId = p.userId;

    const scan = await store.createScan({
      siteId,
      url: result.url,
      score: result.score,
      grade: result.grade ?? scoreToGrade(result.score),
      result,
    });

    return {
      scan: scan.result,
      scanId: scan.id,
      graded: { score: result.score, grade: scan.grade },
    };
  });

  app.get('/scan/:id', async (request) => {
    const record = await store.getScan(request.params.id ?? '');
    if (!record) throw new HttpError(404, 'not_found', 'No such scan.');
    return record;
  });

  // -- POST /generate/mcp --------------------------------------------------

  app.post('/generate/mcp', async (request): Promise<unknown> => {
    const p = await principal(request);
    const body = request.body;

    const serverName = requireString(body, 'serverName');
    const source = requireDataSource(body);
    const siteUrl = optionalString(body, 'siteUrl');
    const deploy_ = body && typeof body === 'object' ? (body as Record<string, unknown>)['deploy'] === true : false;
    const target = optionalString(body, 'target') ?? 'local';

    const entities = parseProducts(body && typeof body === 'object' ? (body as Record<string, unknown>)['products'] : undefined);

    let generated;
    try {
      generated = await generateMcpServer({
        name: serverName,
        source,
        ...(siteUrl ? { siteUrl } : {}),
        ...(entities.length > 0 ? { products: entities } : {}),
        ...(optionalString(body, 'description') ? { description: optionalString(body, 'description') as string } : {}),
        ...(optionalString(body, 'version') ? { version: optionalString(body, 'version') as string } : {}),
        ...(optionalString(body, 'publicUrl') ? { publicUrl: optionalString(body, 'publicUrl') as string } : {}),
      });
    } catch (err) {
      throw new HttpError(
        422,
        'generation_failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    let deployment;
    if (deploy_) {
      try {
        deployment = await deploy({
          spec: generated.spec,
          code: generated.code,
          // deploy() writes the discovery document the Worker serves at
          // /.well-known/mcp.json, so it wants `manifest`, not the registry shape.
          manifest: generated.manifest,
          openapi: generated.openapi,
          target: target as 'cloudflare' | 'smithery' | 'local',
        }, { workDir: './data/mcp-servers' });
      } catch (err) {
        if (err instanceof DeployError) {
          throw new HttpError(502, 'deploy_failed', err.message, { hint: err.hint });
        }
        throw err;
      }
    }

    // Record the server when the caller named a site.
    const siteId = optionalString(body, 'siteId');
    if (siteId && deployment?.status === 'live') {
      await store.createMcpServer({
        siteId,
        name: generated.spec.name,
        url: deployment.url,
        version: generated.spec.version,
        toolCount: generated.toolNames.length,
        rpcCalls: 0,
        monthlyLimit: 25_000,
        status: 'live',
      });
    }

    return {
      serverName: generated.spec.name,
      version: generated.spec.version,
      tools: generated.toolNames,
      toolDetails: generated.spec.tools.map((t) => ({ name: t.name, description: t.description })),
      productCount: generated.products.length,
      warnings: generated.warnings,
      // Two documents, two audiences:
      //   discovery       — /.well-known/mcp.json, what a client fetches to connect
      //   registryManifest — server.json, what the MCP Registry accepts
      manifest: generated.manifest,
      registryManifest: generated.registryManifest,
      openapi: generated.openapi,
      ...(deployment ? { deployment } : {}),
      // The worker source is large; include it only when explicitly asked.
      ...(body && typeof body === 'object' && (body as Record<string, unknown>)['includeCode'] === true
        ? { code: generated.code }
        : {}),
    };
  });

  // -- POST /publish -------------------------------------------------------

  app.post('/publish', async (request): Promise<unknown> => {
    await principal(request);
    const body = request.body;

    const siteUrl = requireUrl(body);
    const platformRaw = optionalString(body, 'platform') ?? 'custom';
    const platform = (['wordpress', 'shopify', 'next', 'custom', 'html'].includes(platformRaw)
      ? platformRaw
      : 'custom') as 'wordpress' | 'shopify' | 'next' | 'custom' | 'html';

    const entities = (body as Record<string, unknown>)['entities'] as
      | { organization?: Organization; products?: Product[]; services?: Service[]; localBusiness?: LocalBusiness; faq?: Array<{ question: string; answer: string }> }
      | undefined;

    const built = buildSchema({
      siteUrl,
      ...(entities?.organization ? { organization: entities.organization } : {}),
      products: parseProducts(entities?.products),
      ...(entities?.services ? { services: entities.services } : {}),
      ...(entities?.localBusiness ? { localBusiness: entities.localBusiness } : {}),
      ...(entities?.faq ? { faq: entities.faq } : {}),
    });

    const validation = validateSchema(built.document);
    const injection = inject(built.document, platform, { siteUrl });

    const organizationName = entities?.organization?.name ?? originOf(siteUrl).replace(/^www\./, '');
    const llms = generateLlmsTxt({
      name: organizationName,
      url: siteUrl,
      description: entities?.organization?.description ?? `About ${organizationName}`,
      contact: entities?.organization?.email,
      sections: [
        { title: 'Pricing', items: parseProducts(entities?.products).slice(0, 10).map((p) => `${p.name}: ${p.currency} ${p.price}`) },
        { title: 'Products', items: parseProducts(entities?.products).slice(0, 10).map((p) => p.name) },
      ],
    });

    return {
      platform,
      location: injection.location,
      schema: {
        document: built.document,
        nodeCount: built.nodeCount,
        types: built.types,
        skipped: built.skipped,
        validation,
      },
      snippet: injection.snippet,
      instructions: injection.instructions,
      warnings: injection.warnings,
      llmsTxt: llms,
    };
  });

  // -- POST /register ------------------------------------------------------

  app.post('/register', async (request): Promise<unknown> => {
    await principal(request);
    const body = request.body;

    const serverName = requireString(body, 'serverName');
    const serverUrl = requireUrl(body, 'serverUrl');
    const targets = parseTargets(body && typeof body === 'object' ? (body as Record<string, unknown>)['targets'] : undefined);
    const dryRun = body && typeof body === 'object' ? (body as Record<string, unknown>)['dryRun'] === true : false;

    // Build a manifest from the server metadata we were given.
    const version = optionalString(body, 'version') ?? '1.0.0';
    const description = optionalString(body, 'description') ?? `${serverName} MCP server`;
    const toolNames = optionalArray(body && typeof body === 'object' ? (body as Record<string, unknown>)['tools'] : undefined, 'tools').map(String);

    const manifest = {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json',
      name: serverName,
      description,
      version,
      repository: { url: optionalString(body, 'repositoryUrl') ?? `https://github.com/${serverName}/mcp-server`, source: 'website' },
      packages: [
        {
          registryType: 'mcp-publisher',
          registryBaseUrl: 'https://registry.modelcontextprotocol.io',
          identifier: { name: serverName, version },
          version,
          transport: { type: 'streamable-http', url: `${serverUrl.replace(/\/$/, '')}/mcp` },
        },
      ],
      remotes: [{ type: 'streamable-http', url: `${serverUrl.replace(/\/$/, '')}/mcp` }],
    };

    const result = await publishToAll({
      manifest,
      serverUrl,
      targets,
      dryRun,
      siteUrl: optionalString(body, 'siteUrl'),
      toolNames,
    });

    return {
      serverName,
      serverUrl,
      dryRun,
      manifest,
      submissions: result.submissions.map((s) => ({
        registry: s.name,
        status: s.status,
        url: s.url,
        error: s.error,
        logs: s.logs,
      })),
      summary: {
        live: result.live,
        pending: result.pending,
        failed: result.failed,
      },
    };
  });

  // -- POST /simulate ------------------------------------------------------

  app.post('/simulate', async (request): Promise<unknown> => {
    await principal(request);
    const body = request.body;

    const target = requireUrl(body);
    const competitors = optionalArray(body, 'competitors').map((c) => requireUrl({ url: c }, 'url'));
    const queries = optionalArray(body, 'queries').map(String);
    const personas = optionalArray(body, 'personas').map(String) as never[];

    if (competitors.length > 0) {
      // A benchmark: rank against competitors.
      const benchmark = await runBenchmark({
        target,
        competitors,
        ...(queries.length > 0 ? { queries } : {}),
        ...(personas.length > 0 ? { personas } : {}),
        includeScan: true,
      });
      return {
        mode: 'benchmark',
        target: benchmark.target,
        rank: benchmark.rank,
        total: benchmark.total,
        rows: benchmark.rows,
        wins: benchmark.wins,
        losses: benchmark.losses,
        report: benchmark.report,
      };
    }

    const report = await simulateAgentVisibility({
      target,
      ...(queries.length > 0 ? { queries } : {}),
      ...(personas.length > 0 ? { personas } : {}),
    });

    return { mode: 'simulate', ...report };
  });

  // -- GET /verify ---------------------------------------------------------

  app.get('/verify', async (request): Promise<unknown> => {
    const target = request.query['url'] ?? request.query['site'];
    if (!target) throw new HttpError(400, 'invalid_request', 'Provide ?url=https://your-site.com');

    const url = requireUrl({ url: target });
    const origin = originOf(url);

    // Resolve the site by URL. Looking up "the first site of some user" would
    // let one customer publish a verification page for another's score.
    const [site] = (await store.listAllSites()).filter((s) => originOf(s.url) === origin);
    const latest = site ? await store.latestScan(site.id) : undefined;

    // Live registry check for the site's MCP server, if it has one.
    let registries: RegistryStatus[] = [];
    const mcpUrl = site?.mcpServerUrl ?? optionalString(request.query as Record<string, unknown>, 'mcpUrl');
    if (mcpUrl) {
      const name =
        optionalString(request.query as Record<string, unknown>, 'serverName') ??
        originOf(mcpUrl).replace(/^www\./, '').split('.')[0] ??
        'server';
      registries = await checkRegistryStatus({ serverName: name });
    }

    const score = latest?.score;
    const grade = latest?.grade ?? (score !== undefined ? scoreToGrade(score) : undefined);

    return {
      verified: Boolean(latest),
      url,
      score,
      grade,
      lastScanAt: latest?.createdAt,
      checks: latest?.result.checks.map((c) => ({ id: c.id, title: c.title, status: c.status, points: c.points, maxPoints: c.maxPoints })),
      topFixes: latest?.result.gaps.slice(0, 3).map((g) => ({ title: truncate(g.title, 120), severity: g.severity, effortMinutes: g.effortMinutes })),
      registries,
      recommendations: latest?.result.recommendations ?? [],
    };
  });

  // -- GET /monitor --------------------------------------------------------

  app.get('/monitor', async (request): Promise<unknown> => {
    await principal(request);

    const target = request.query['url'];
    const serverUrl = request.query['server'];
    const samples = Math.min(10, Math.max(1, Number(request.query['samples'] ?? 3)));

    const endpoints: Record<string, string> = {};
    if (target) endpoints['site'] = requireUrl({ url: target });
    // Probe /.well-known/mcp.json, not /mcp — a GET on /mcp opens an SSE
    // stream and every probe would look like a timeout.
    if (serverUrl) endpoints['mcp'] = mcpHealthUrl(requireUrl({ url: serverUrl }));

    if (Object.keys(endpoints).length === 0) {
      throw new HttpError(400, 'invalid_request', 'Provide ?url= and/or ?server= to monitor.');
    }

    const uptime = await monitorEndpoints(endpoints, { samples });

    const registries = target
      ? await checkRegistryStatus({ serverName: originOf(requireUrl({ url: target })).replace(/^www\./, '') })
      : [];

    return {
      uptime: uptime.results.map((r) => ({
        name: r.name,
        url: r.url,
        uptimeRatio: r.report.uptimeRatio,
        avgLatencyMs: r.report.avgLatencyMs,
        p95LatencyMs: r.report.p95LatencyMs,
        totalChecks: r.report.totalChecks,
        failedChecks: r.report.failedChecks,
      })),
      degraded: uptime.degraded.map((d) => ({ name: d.name, url: d.url, reason: d.reason })),
      healthy: uptime.healthy,
      registries,
      checkedAt: new Date().toISOString(),
    };
  });

  // -- GET /enrich -------------------------------------------------------

  /**
   * What an agent can learn about a domain before it ever fetches it:
   * certificate transparency, DNS, archive history and registration age.
   *
   * All four sources are free and key-less. Any that is unreachable is
   * reported in `unavailable` rather than silently omitted.
   */
  app.get('/enrich', async (request): Promise<unknown> => {
    const target = request.query['url'];
    if (!target) throw new HttpError(400, 'invalid_request', 'Provide ?url=https://your-site.com');

    const url = requireUrl({ url: target });
    const offline = request.query['offline'] === 'true';

    const report = await enrichTarget(url, offline ? { offline: true } : {});
    return { ...report, summary: describeEnrichment(report) };
  });

  // -- sites ---------------------------------------------------------------

  app.get('/sites', async (request): Promise<unknown> => {
    const p = await principal(request);
    return store.listSites(p.userId);
  });

  app.post('/sites', async (request): Promise<unknown> => {
    const p = await principal(request);
    const body = request.body;
    const url = requireUrl(body);
    const name = optionalString(body, 'name') ?? originOf(url).replace(/^www\./, '');

    const site: Site = await store.createSite({ userId: p.userId, url, name });
    return site;
  });

  app.get('/sites/:id/scans', async (request): Promise<unknown> => {
    const limit = Math.min(100, Math.max(1, Number(request.query['limit'] ?? 20)));
    const scans = await store.listScans(request.params.id ?? '', limit);
    return scans.map((s) => ({ id: s.id, url: s.url, score: s.score, grade: s.grade, createdAt: s.createdAt }));
  });

  // -- dashboard aggregate -------------------------------------------------

  app.get('/dashboard', async (request): Promise<unknown> => {
    const p = await principal(request);
    const sites = await store.listSites(p.userId);

    const quota: QuotaStatus = await store.quotaFor(p.userId);

    // Aggregate every site the user owns.
    let latestScore = 0;
    let totalScans = 0;
    let mcpToolCount = 0;
    let rpcCalls = 0;

    for (const site of sites) {
      const scans = await store.listScans(site.id, 100);
      totalScans += scans.length;
      if (scans[0]) latestScore = Math.max(latestScore, scans[0].score);
      const servers = await store.listMcpServers(site.id);
      for (const s of servers) {
        mcpToolCount += s.toolCount;
        rpcCalls += s.rpcCalls;
      }
    }

    const mcpServers = (await Promise.all(sites.map((s) => store.listMcpServers(s.id)))).flat();

    return {
      plan: p.plan,
      quota,
      score: latestScore,
      grade: scoreToGrade(latestScore),
      sites: sites.length,
      totalScans,
      mcpServers: mcpServers.map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        status: s.status,
        toolCount: s.toolCount,
        rpcCalls: s.rpcCalls,
        monthlyLimit: s.monthlyLimit,
      })),
      mcpToolCount,
      rpcCalls,
    };
  });

  // -- 404 -----------------------------------------------------------------

  app.setNotFoundHandler(async (request) => {
    throw new HttpError(404, 'not_found', `No route for ${request.method} ${request.path}`);
  });
}