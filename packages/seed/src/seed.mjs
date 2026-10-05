/**
 * Seed script.
 *
 * Boots the demo site (with its live MCP server), then drives the real
 * AgentReady pipeline against it: scan -> generate -> publish -> register
 * (dry-run) -> simulate. Every artifact lands in ./out/seed so you can inspect
 * exactly what a customer would receive.
 *
 * Run: node packages/seed/src/seed.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scanSite, formatScanReport } from '../../core/dist/index.js';
import { buildSchema, inject, validateSchema, generateLlmsTxt } from '../../schema/dist/index.js';
import { generateMcpServer, deploy } from '../../mcp/dist/index.js';
import { publishToAll, checkRegistryStatus } from '../../registry/dist/index.js';
import { simulateAgentVisibility, formatSimulationReport } from '../../verify/dist/index.js';

const OUT = join(process.cwd(), 'out', 'seed');
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 8790);
const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`;

const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`  ${msg}`);

async function writeJson(name, value) {
  const target = join(OUT, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2), 'utf8');
  return target;
}

async function writeText(name, value) {
  const target = join(OUT, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value, 'utf8');
  return target;
}

async function main() {
  log('\nAgentReady seed');
  log('===============\n');

  // 0. Start the demo site.
  log('[0/6] starting the demo site');
  const { start, server } = await import('./demo-site.mjs');
  await start(DEMO_PORT);
  ok(`demo site on ${DEMO_ORIGIN}`);
  ok(`mcp endpoint ${DEMO_ORIGIN}/mcp`);

  try {
    // 1. Scan it. This should score high — it is the reference implementation.
    log('\n[1/6] scanning the demo site');
    const scan = await scanSite(DEMO_ORIGIN);
    ok(formatScanReport(scan, { color: false }));
    await writeJson('scan.json', scan);

    // 2. Generate an MCP server from the same catalogue.
    log('[2/6] generating an MCP server from the catalogue');
    const { PRODUCTS } = await import('./catalogue.mjs');
    const products = PRODUCTS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      sku: p.sku,
      category: p.category,
      price: p.price,
      currency: 'USD',
      availability: p.availability,
      specs: p.specs,
      ...(p.rating ? { rating: p.rating } : {}),
      url: `${DEMO_ORIGIN}/products/${p.id}`,
    }));

    const generated = await generateMcpServer({
      name: 'northwind-supply',
      description: 'Northwind Supply field equipment catalogue, exposed for AI agents.',
      siteUrl: DEMO_ORIGIN,
      publicUrl: `${DEMO_ORIGIN}/mcp`,
      products,
      source: { kind: 'json', location: 'packages/seed/src/catalogue.mjs', mapping: {} },
    });
    ok(`tools: ${generated.toolNames.join(', ')}`);
    ok(`products: ${generated.products.length}`);
    await writeJson('mcp/server.json', generated.registryManifest);
    await writeJson('mcp/mcp.json', generated.manifest);
    await writeJson('mcp/openapi.json', generated.openapi);
    await writeText('mcp/worker.js', generated.code);

    // 3. Publish: schema.org + llms.txt.
    log('\n[3/6] generating schema.org markup');
    const built = buildSchema({
      siteUrl: DEMO_ORIGIN,
      organization: {
        name: 'Northwind Supply',
        url: DEMO_ORIGIN,
        description: 'Durable field equipment with public pricing and a machine-readable API.',
        email: 'api@northwind.example',
      },
      products,
    });
    const validation = validateSchema(built.document);
    ok(`${built.nodeCount} nodes: ${Object.entries(built.types).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    ok(`valid: ${validation.valid}${validation.errors ? ` (${validation.errors} errors)` : ''}`);
    if (!validation.valid) {
      for (const issue of validation.issues.filter((i) => i.level === 'error').slice(0, 5)) {
        ok(`  error: ${issue.message}`);
      }
    }
    const injection = inject(built.document, 'next', { siteUrl: DEMO_ORIGIN });
    await writeJson('schema.jsonld', built.document);
    await writeText('snippet.html', injection.snippet);
    await writeText(
      'llms.txt',
      generateLlmsTxt({
        name: 'Northwind Supply',
        url: DEMO_ORIGIN,
        description: 'Durable field equipment.',
        sections: [
          { title: 'Products', items: products.slice(0, 10).map((p) => `${p.name}: $${p.price} (${p.availability})`) },
          { title: 'For agents', items: [`MCP server: ${DEMO_ORIGIN}/mcp`] },
        ],
      }),
    );

    // 4. Register (dry run — we are not going to publish to public registries
    //    from a seed script without the operator asking for it).
    log('\n[4/6] registry dry run');
    const registration = await publishToAll({
      manifest: generated.registryManifest,
      serverUrl: `${DEMO_ORIGIN}/mcp`,
      targets: ['official', 'smithery', 'mcp-so'],
      dryRun: true,
      siteUrl: DEMO_ORIGIN,
      toolNames: generated.toolNames,
    });
    for (const submission of registration.submissions) {
      ok(`${submission.name.padEnd(10)} ${submission.status}${submission.error ? ` — ${submission.error}` : ''}`);
    }
    await writeJson('register-dryrun.json', registration);

    // 5. Registry status lookup.
    log('\n[5/6] checking registry listings');
    const statuses = await checkRegistryStatus({ serverName: generated.spec.name });
    for (const status of statuses) {
      ok(`${status.label.padEnd(24)} ${status.state} — ${status.detail ?? ''}`);
    }

    // 6. Simulate agent queries.
    log('\n[6/6] simulating agent queries');
    const report = await simulateAgentVisibility({
      target: DEMO_ORIGIN,
      queries: [
        'What products do you sell and how much do they cost?',
        'What is currently in stock?',
        'Which product is cheapest?',
        'Can I buy a laptop and how does payment work?',
      ],
      personas: ['shopping'],
    });
    ok(formatSimulationReport(report));
    await writeJson('simulate.json', report);

    // 7. Deploy locally so the worker is genuinely servable.
    log('\n[bonus] writing a local deployment of the generated worker');
    const deployment = await deploy(
      {
        spec: generated.spec,
        code: generated.code,
        manifest: generated.manifest,
        openapi: generated.openapi,
        target: 'local',
        dryRun: false,
      },
      { workDir: join(OUT, 'mcp'), port: 8791 },
    );
    ok(`${deployment.url} (${deployment.status})`);

    log(`\nAll artifacts written to ${OUT}`);
    log('\nNext:');
    log(`  node packages/api/dist/server.js              # API on :8787`);
    log(`  agentready scan ${DEMO_ORIGIN}                # score the demo site yourself`);
    log(`  agentready verify ${DEMO_ORIGIN} --server ${DEMO_ORIGIN}/mcp\n`);
  } finally {
    server.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nSeed failed:', err);
    process.exit(1);
  });
