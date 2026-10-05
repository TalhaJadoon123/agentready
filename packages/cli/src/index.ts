/**
 * AgentReady CLI.
 *
 * Commands:
 *   agentready scan <url>            — score a site, print fixes
 *   agentready generate              — build an MCP server from a catalogue
 *   agentready publish               — emit schema.org snippets + llms.txt
 *   agentready register              — submit an MCP server to the registries
 *   agentready simulate              — replay agent queries against a site
 *   agentready verify                — uptime, registry status, alerts
 *
 * Zero runtime dependencies: everything is built on node:util parseArgs and
 * node:fs, so the CLI installs in milliseconds and runs anywhere Node does.
 */

import { parseArgs } from 'node:util';
import type { Product } from '@agentready/shared';
import {
  config,
  createLogger,
  errorMessage,
  formatCents,
  newId,
  normalizeUrl,
  originOf,
  serverSlug,
  truncate,
} from '@agentready/shared';
import { scanSite, formatScanReport, enrichTarget, describeEnrichment } from '@agentready/core';
import { buildSchema, inject, validateSchema, generateLlmsTxt } from '@agentready/schema';
import { generateMcpServer, deploy, loadRecords, DeployError } from '@agentready/mcp';
import { publishToAll, checkRegistryStatus, REGISTRY_TARGETS } from '@agentready/registry';
import { simulateAgentVisibility, formatSimulationReport, runBenchmark, formatBenchmark, monitorEndpoints, describeUptime, mcpHealthUrl } from '@agentready/verify';

const log = createLogger({ scope: 'agentready' });

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
};

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (text: string, code: string) => (color ? `\u001b[${code}m${text}${C.reset}` : text);

const OPTIONS = {
  help: { type: 'boolean', short: 'h', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  json: { type: 'boolean', default: false },
  // scan
  checks: { type: 'string', short: 'c' },
  timeout: { type: 'string' },
  out: { type: 'string', short: 'o' },
  // generate
  name: { type: 'string', short: 'n' },
  source: { type: 'string', short: 's' },
  file: { type: 'string', short: 'f' },
  api: { type: 'string' },
  mapping: { type: 'string', short: 'm' },
  site: { type: 'string' },
  version: { type: 'string' },
  deploy: { type: 'boolean', default: false },
  target: { type: 'string', short: 't' },
  'no-order': { type: 'boolean', default: false },
  // publish
  platform: { type: 'string', short: 'p', default: 'custom' },
  products: { type: 'string' },
  org: { type: 'string' },
  'out-dir': { type: 'string' },
  // register
  url: { type: 'string', short: 'u' },
  registries: { type: 'string', short: 'r' },
  'dry-run': { type: 'boolean', default: false },
  // simulate
  competitors: { type: 'string' },
  queries: { type: 'string', short: 'q' },
  personas: { type: 'string' },
  // verify
  server: { type: 'string' },
  samples: { type: 'string' },
  offline: { type: 'boolean', default: false },
} as const;

type OptionKey = keyof typeof OPTIONS;
type Values = Partial<Record<OptionKey, string | boolean>>;

function parse(argv: string[]): { command: string; positional: string[]; values: Values } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
  });
  const [command = 'help', ...rest] = positionals;
  return { command, positional: rest, values: values as Values };
}

/** Write a JSON payload to disk, creating parent directories. */
async function writeOut(path: string, content: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function flag(values: Values, key: OptionKey): boolean {
  return values[key] === true || values[key] === 'true';
}

function str(values: Values, key: OptionKey): string | undefined {
  const v = values[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

async function cmdScan(positional: string[], values: Values): Promise<number> {
  const url = positional[0] ?? str(values, 'url');
  if (!url) {
    log.error('Usage: agentready scan <url>');
    return 2;
  }

  const onlyChecks = str(values, 'checks')
    ?.split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const result = await scanSite(url, {
    ...(onlyChecks ? { onlyChecks: onlyChecks as never } : {}),
    ...(str(values, 'timeout') ? { timeoutMs: Number(str(values, 'timeout')) } : {}),
  });

  if (flag(values, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatScanReport(result, { verbose: flag(values, 'verbose'), color })}\n`);
  }

  const out = str(values, 'out');
  if (out) {
    await writeOut(out, JSON.stringify(result, null, 2));
    log.info(`Wrote ${out}`);
  }

  // Non-zero exit when the score is poor: this makes the command usable in CI.
  return result.score >= 50 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

async function cmdGenerate(positional: string[], values: Values): Promise<number> {
  const kind = (str(values, 'source') ?? 'csv') as 'csv' | 'json' | 'api' | 'scrape';
  const file = str(values, 'file') ?? str(values, 'api') ?? positional[0];
  const name = str(values, 'name') ?? (file ? file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') : undefined) ?? 'catalogue';

  if (!file) {
    log.error('Usage: agentready generate --source csv|json|api|scrape --file <path|url> [--name <server>]');
    return 2;
  }

  const location = kind === 'api' ? (str(values, 'api') ?? file) : file;
  let mapping: Record<string, string> = {};
  const mappingRaw = str(values, 'mapping');
  if (mappingRaw) {
    const asJson = mappingRaw.trim().startsWith('{');
    mapping = asJson ? (JSON.parse(mappingRaw) as Record<string, string>) : parseMappingCsv(mappingRaw);
  }

  const outDir = str(values, 'out-dir') ?? str(values, 'out') ?? './out/mcp';

  log.info(`Generating MCP server "${name}" from ${kind}:${truncate(location, 60)}`);

  let products: Product[] | undefined;
  if (flag(values, 'products')) {
    const path = str(values, 'products') as string;
    const { readFile } = await import('node:fs/promises');
    products = (JSON.parse(await readFile(path, 'utf8')) as Product[]);
  }

  const generated = await generateMcpServer({
    name,
    source: { kind, location, mapping },
    ...(products ? { products } : {}),
    ...(str(values, 'site') ? { siteUrl: str(values, 'site') } : {}),
    ...(str(values, 'version') ? { version: str(values, 'version') } : {}),
    ...(flag(values, 'no-order') ? { includeOrderTool: false } : {}),
  });

  const slug = serverSlug(generated.spec.name);
  await writeOut(`${outDir}/${slug}/worker.js`, generated.code);
  await writeOut(`${outDir}/${slug}/server.json`, JSON.stringify(generated.manifest, null, 2));
  await writeOut(`${outDir}/${slug}/mcp.json`, JSON.stringify(generated.manifest, null, 2));
  await writeOut(`${outDir}/${slug}/openapi.json`, JSON.stringify(generated.openapi, null, 2));

  log.info(`Generated ${generated.products.length} product(s), ${generated.toolNames.length} tool(s)`);
  for (const warning of generated.warnings) log.warn(warning);

  if (!flag(values, 'json')) {
    process.stdout.write('\n');
    process.stdout.write(`  MCP server: ${paint(generated.spec.name, C.bold)}\n`);
    process.stdout.write(`  Tools:      ${generated.toolNames.join(', ')}\n`);
    process.stdout.write(`  Output:     ${outDir}/${slug}/\n`);
    process.stdout.write(`    worker.js     the deployable Cloudflare Worker\n`);
    process.stdout.write(`    server.json   Official MCP Registry manifest\n`);
    process.stdout.write(`    openapi.json  REST description of the same tools\n`);
    process.stdout.write('\n');
  }

  if (flag(values, 'deploy')) {
    const target = (str(values, 'target') ?? 'local') as 'cloudflare' | 'smithery' | 'local';
    try {
      const result = await deploy(
        {
          spec: generated.spec,
          code: generated.code,
          manifest: generated.registryManifest,
          openapi: generated.openapi,
          target,
        },
        { workDir: `${outDir}/${slug}` },
      );
      log.info(`Deployed to ${result.provider}: ${result.url} (${result.status})`);
      for (const line of result.logs ?? []) process.stdout.write(`  ${line}\n`);
    } catch (err) {
      if (err instanceof DeployError) {
        log.error(err.message);
        if (err.hint) log.info(err.hint);
      } else {
        log.error(errorMessage(err));
      }
      return 1;
    }
  }

  return 0;
}

/** Parse `name=column,price=cost` into a mapping object. */
export function parseMappingCsv(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of input.split(',')) {
    const [key, value] = pair.split('=');
    if (key && value) out[key.trim()] = value.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function cmdPublish(positional: string[], values: Values): Promise<number> {
  const url = normalizeUrl(positional[0] ?? str(values, 'url') ?? '');
  if (!url) {
    log.error('Usage: agentready publish <url> --platform custom|wordpress|shopify|next [--products products.json]');
    return 2;
  }

  const platform = (str(values, 'platform') ?? 'custom') as 'wordpress' | 'shopify' | 'next' | 'custom';
  const outDir = str(values, 'out-dir') ?? str(values, 'out') ?? './out/publish';

  let products: Product[] = [];
  const productsPath = str(values, 'products');
  if (productsPath) {
    const { readFile } = await import('node:fs/promises');
    products = JSON.parse(await readFile(productsPath, 'utf8')) as Product[];
  }

  const orgName = str(values, 'org') ?? originOf(url).replace(/^www\./, '');
  const built = buildSchema({
    siteUrl: url,
    organization: { name: orgName, url, description: `About ${orgName}` },
    products,
  });

  const validation = validateSchema(built.document);
  const injection = inject(built.document, platform, { siteUrl: url });
  const llms = generateLlmsTxt({
    name: orgName,
    url,
    description: `About ${orgName}`,
    sections: [
      { title: 'Pricing', items: products.slice(0, 20).map((p) => `${p.name}: ${p.currency} ${p.price}`) },
      { title: 'Products', items: products.slice(0, 20).map((p) => p.name) },
    ],
  });

  await writeOut(`${outDir}/schema.jsonld`, JSON.stringify(built.document, null, 2));
  await writeOut(`${outDir}/snippet.html`, injection.snippet);
  await writeOut(`${outDir}/llms.txt`, llms);

  if (flag(values, 'json')) {
    process.stdout.write(`${JSON.stringify({ url, platform, built, validation, injection, llms }, null, 2)}\n`);
    return validation.valid ? 0 : 1;
  }

  process.stdout.write('\n');
  process.stdout.write(`  schema.org document\n`);
  process.stdout.write(`  ${paint(`${built.nodeCount} node(s)`, C.bold)} — ${Object.entries(built.types).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}\n`);
  process.stdout.write(`  Validation: ${validation.valid ? paint('valid', C.green) : paint(`${validation.errors} error(s)`, C.red)}`);
  if (!validation.valid) {
    process.stdout.write('\n');
    for (const issue of validation.issues.filter((i) => i.level === 'error').slice(0, 5)) {
      process.stdout.write(`    ${paint('error', C.red)} ${issue.message}\n`);
    }
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${paint('Where to paste it', C.bold)} (${platform} → ${injection.location})\n`);
  injection.instructions.forEach((line, i) => process.stdout.write(`    ${i + 1}. ${line}\n`));
  if (injection.warnings.length > 0) {
    process.stdout.write(`\n  ${paint('Watch out', C.yellow)}\n`);
    for (const w of injection.warnings) process.stdout.write(`    - ${w}\n`);
  }
  process.stdout.write(`\n  Wrote ${outDir}/{schema.jsonld,snippet.html,llms.txt}\n\n`);
  return validation.valid ? 0 : 1;
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

async function cmdRegister(positional: string[], values: Values): Promise<number> {
  const serverName = str(values, 'name') ?? positional[0];
  if (!serverName) {
    log.error('Usage: agentready register <server-name> --url <mcp-url> [--registries official,smithery,mcp-so]');
    return 2;
  }

  const serverUrl = str(values, 'url');
  if (!serverUrl) {
    log.error('--url is required: the public streamable-http endpoint, e.g. https://my-store-mcp.workers.dev');
    return 2;
  }

  const dryRun = flag(values, 'dry-run');
  const registries = str(values, 'registries')
    ?.split(',')
    .map((r) => r.trim())
    .filter(Boolean) as never[] | undefined;

  const manifestPath = `./out/mcp/${serverSlug(serverName)}/server.json`;
  let manifest: Record<string, unknown>;
  try {
    const { readFile } = await import('node:fs/promises');
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // Build a minimal manifest when the generated file is not on disk.
    const version = str(values, 'version') ?? '1.0.0';
    manifest = {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json',
      name: serverSlug(serverName),
      description: `${serverName} MCP server`,
      version,
      repository: { url: `https://github.com/${serverSlug(serverName)}/mcp-server`, source: 'website' },
      packages: [
        {
          registryType: 'mcp-publisher',
          registryBaseUrl: 'https://registry.modelcontextprotocol.io',
          identifier: { name: serverSlug(serverName), version },
          version,
          transport: { type: 'streamable-http', url: `${serverUrl.replace(/\/$/, '')}/mcp` },
        },
      ],
      remotes: [{ type: 'streamable-http', url: `${serverUrl.replace(/\/$/, '')}/mcp` }],
    };
  }

  log.info(dryRun ? 'Dry run: validating manifests only' : `Registering ${serverName} to ${registries?.join(', ') ?? 'all registries'}`);

  const result = await publishToAll({
    manifest,
    serverUrl,
    ...(registries ? { targets: registries } : {}),
    dryRun,
    siteUrl: str(values, 'site'),
  });

  process.stdout.write('\n');
  for (const submission of result.submissions) {
    const statusColor =
      submission.status === 'submitted' || submission.status === 'live'
        ? C.green
        : submission.status === 'error' || submission.status === 'rejected'
          ? C.red
          : C.yellow;
    process.stdout.write(`  ${submission.name.padEnd(10)} ${paint(submission.status, statusColor)}\n`);
    if (submission.url) process.stdout.write(`    ${submission.url}\n`);
    if (submission.error) process.stdout.write(`    ${paint(submission.error, C.red)}\n`);
    for (const line of submission.logs ?? []) process.stdout.write(`    ${paint(line, C.dim)}\n`);
    process.stdout.write('\n');
  }

  const failed = result.failed.length > 0;
  if (result.pending.length > 0) {
    log.info(`${result.pending.length} registry(ies) need a manual step — see the instructions above.`);
  }
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

async function cmdSimulate(positional: string[], values: Values): Promise<number> {
  const target = positional[0] ?? str(values, 'url');
  if (!target) {
    log.error('Usage: agentready simulate <url> [--competitors a.com,b.com] [--queries "q1" --queries "q2"]');
    return 2;
  }

  const competitors = str(values, 'competitors')
    ?.split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const queries = str(values, 'queries')
    ?.split('|')
    .map((q) => q.trim())
    .filter(Boolean);
  const personas = str(values, 'personas')
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean) as never[] | undefined;

  const cfg = config();
  if (!cfg.groq.apiKey) {
    log.warn('GROQ_API_KEY is not set — running in deterministic mode.');
    log.info('Ranking will be estimated from site structure rather than a live model.');
    log.info('Get a free key at https://console.groq.com/keys to enable real simulations.');
    process.stdout.write('\n');
  }

  const onProgress = flag(values, 'verbose')
    ? (done: number, total: number, query: string) => {
        process.stderr.write(`\r  [${done}/${total}] ${truncate(query, 70)}          `);
      }
    : undefined;

  if (competitors && competitors.length > 0) {
    const result = await runBenchmark({
      target,
      competitors,
      ...(queries ? { queries } : {}),
      ...(personas ? { personas } : {}),
      includeScan: true,
      ...(onProgress ? { onProgress } : {}),
    });
    if (onProgress) process.stderr.write('\r');
    if (flag(values, 'json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${formatBenchmark(result)}\n`);
    return result.rank === 1 ? 0 : 1;
  }

  const report = await simulateAgentVisibility({
    target,
    ...(queries ? { queries } : {}),
    ...(personas ? { personas } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
  if (onProgress) process.stderr.write('\r');
  if (flag(values, 'json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatSimulationReport(report)}\n`);
  return report.visibilityScore >= 50 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

async function cmdVerify(positional: string[], values: Values): Promise<number> {
  const target = positional[0] ?? str(values, 'url');
  const samples = Math.min(10, Math.max(1, Number(str(values, 'samples') ?? 3)));

  const endpoints: Record<string, string> = {};
  if (target) endpoints['site'] = target;
  // Probe the discovery manifest rather than /mcp, which would open an SSE
  // stream and look like a timeout.
  if (str(values, 'server')) endpoints['mcp'] = mcpHealthUrl(str(values, 'server') as string);

  if (Object.keys(endpoints).length === 0) {
    log.error('Usage: agentready verify <url> [--server <mcp-url>] [--samples 5]');
    return 2;
  }

  const uptime = await monitorEndpoints(endpoints, { samples });

  const registries = target ? await checkRegistryStatus({ serverName: originOf(target).replace(/^www\./, '') }) : [];

  if (flag(values, 'json')) {
    process.stdout.write(`${JSON.stringify({ uptime: uptime.results, registries }, null, 2)}\n`);
    return uptime.degraded.length > 0 ? 1 : 0;
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${paint('Uptime', C.bold)}\n`);
  for (const { name, url, report } of uptime.results) {
    const healthy = report.uptimeRatio >= 100;
    process.stdout.write(`    ${name.padEnd(6)} ${paint(healthy ? 'OK  ' : 'FAIL', healthy ? C.green : C.red)} ${describeUptime(report)}\n`);
    process.stdout.write(`           ${C.dim}${url}${C.reset}\n`);
  }

  if (registries.length > 0) {
    process.stdout.write(`\n  ${paint('Registries', C.bold)}\n`);
    for (const registry of registries) {
      const colorCode = registry.state === 'synced' ? C.green : registry.state === 'drifted' ? C.yellow : C.red;
      process.stdout.write(`    ${registry.label.padEnd(24)} ${paint(registry.state, colorCode)}  ${C.dim}${registry.detail ?? ''}${C.reset}\n`);
    }
  }

  process.stdout.write('\n');
  return uptime.degraded.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

// enrich ---------------------------------------------------------------

  async function cmdEnrich(positional: string[], values: Values): Promise<number> {
    const url = positional[0] ?? str(values, 'url');
    if (!url) {
      log.error('Usage: agentready enrich <url> [--offline]');
      log.info(
        'Reports what an agent can learn about a domain before fetching it, using four free\n' +
          'public sources: certificate transparency (crt.sh), DNS (Cloudflare DoH), the\n' +
          'Wayback Machine, and domain registration (RDAP).',
      );
      return 2;
    }

    const report = await enrichTarget(url, flag(values, 'offline') ? { offline: true } : {});

    if (flag(values, 'json')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }

    const lines = describeEnrichment(report);
    process.stdout.write('\n');
    process.stdout.write(`  ${paint(report.target, C.bold)}\n\n`);
    if (lines.length === 0) {
      process.stdout.write(`  ${paint('No enrichment data available.', C.dim)}\n\n`);
      return 0;
    }
    for (const line of lines) {
      process.stdout.write(`  ${line.startsWith('WARNING') ? paint(line, C.red) : line}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }

  function cmdHelp(): number {
  const b = (s: string) => paint(s, C.bold);
  const d = (s: string) => paint(s, C.dim);

  process.stdout.write(`
${b('agentready')} ${d('— SEO for agents. Be found by AI.')}

${b('USAGE')}
  agentready <command> [options]

${b('COMMANDS')}
  ${b('scan')} <url>                      Score agent-readiness out of 100 and list fixes
  ${b('generate')} --file <f>             Build an MCP server from CSV/JSON/API/scrape
  ${b('publish')} <url>                   Emit schema.org JSON-LD + llms.txt snippets
  ${b('register')} <name> --url <u>       Submit the server to MCP registries
  ${b('simulate')} <url>                  Replay agent queries; rank vs competitors
  ${b('verify')} <url>                    Uptime, registry status, health
  ${b('enrich')} <url>                    Public domain intelligence (CT logs, DNS, archive, RDAP)

${b('EXAMPLES')}
  ${d('# Score a site')}
  agentready scan example.com

  ${d('# Generate an MCP server from a CSV and deploy it to Cloudflare Workers')}
  agentready generate --source csv --file products.csv --name acme-store --deploy --target cloudflare

  ${d('# Generate schema.org snippets for Shopify')}
  agentready publish acme.com --platform shopify --products products.json

  ${d('# Register the server everywhere (dry run first!)')}
  agentready register acme-store --url https://acme-store-mcp.workers.dev --dry-run
  agentready register acme-store --url https://acme-store-mcp.workers.dev

  ${d('# Benchmark against two competitors')}
  agentready simulate acme.com --competitors rival.com,other.com

${b('COMMON OPTIONS')}
  -v, --verbose        More detail (and a progress line for simulate)
      --json           Machine-readable output
  -o, --out <file>     Write the result to a file
  -h, --help           This message

${b('PRICING')}
  Free     1 scan/month
  $49/mo   Starter   50 scans, 1 MCP server, 5 monitors
  $149/mo  Business  1000 scans, 10 MCP servers, 50 monitors

${b('FREE TIER KEYS (all optional)')} ${d('— everything degrades gracefully')}
  GROQ_API_KEY            agent simulation
  CLOUDFLARE_API_TOKEN    MCP hosting (100k req/day)
  SMITHERY_API_KEY        MCP hosting (25k RPC/mo)
  MCP_REGISTRY_GITHUB_TOKEN  automatic registry PRs

`);
  return 0;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // `--version` short-circuits before flag parsing.
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write('agentready 1.0.0\n');
    return 0;
  }

  const { command, positional, values } = parse(argv);

  if (values.help || command === 'help' || command === '--help') return cmdHelp();

  switch (command) {
    case 'scan':
      return cmdScan(positional, values);
    case 'generate':
      return cmdGenerate(positional, values);
    case 'publish':
      return cmdPublish(positional, values);
    case 'register':
      return cmdRegister(positional, values);
    case 'simulate':
      return cmdSimulate(positional, values);
    case 'verify':
      return cmdVerify(positional, values);
    case 'enrich':
      return cmdEnrich(positional, values);
    default:
      log.error(`Unknown command: ${command}`);
      return cmdHelp();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log.error(errorMessage(err));
    if (process.env.AGENTREADY_DEBUG) console.error(err);
    process.exitCode = 1;
  });

export { newId, formatCents };