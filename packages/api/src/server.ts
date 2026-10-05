/**
 * AgentReady API server.
 *
 * Start it with:
 *   node --experimental-strip-types packages/api/src/server.ts
 * or, after `npm run build`:
 *   node packages/api/dist/server.js
 */

import { config, createLogger, errorMessage } from '@agentready/shared';
import { createServer, type App } from './http.js';
import { registerRoutes } from './routes.js';
import { createStore, SUPABASE_SCHEMA_SQL } from './store.js';
import { applySupabaseSchema } from './migrate.js';

export interface BuiltServer {
  app: App;
  store: ReturnType<typeof createStore>;
  close: () => Promise<void>;
}

/**
 * Wire up the app without listening. Tests use this to drive the server on an
 * ephemeral port.
 */
export async function buildServer(
  options: {
    devMode?: boolean;
    forceFile?: boolean;
    dbPath?: string;
    /**
     * Allow scanning private/loopback targets. Off by default.
     *
     * Propagated to the scanner via AGENTREADY_ALLOW_PRIVATE_FETCH, which is
     * the switch the SSRF guard actually reads. Exposed as an option so tests
     * can pin the behaviour rather than mutate process.env.
     */
    allowPrivateFetch?: boolean;
  } = {},
): Promise<BuiltServer> {
  if (options.allowPrivateFetch !== undefined) {
    process.env['AGENTREADY_ALLOW_PRIVATE_FETCH'] = String(options.allowPrivateFetch);
  }
  const cfg = config();
  const log = createLogger({ level: cfg.logLevel, scope: 'api' });

  const store = createStore({
    ...(options.forceFile ? { forceFile: true } : {}),
    ...(options.dbPath ? { path: options.dbPath } : {}),
  });

  await store.init();
  log.info(`Store ready (${store.kind})`);

  const app = createServer({
    bodyLimit: 2_000_000,
    cors: cfg.webOrigin,
  });

  registerRoutes(app, { store, ...(options.devMode ? { devMode: true } : {}) });

  return {
    app,
    store,
    close: async () => {
      await app.close();
      await store.close();
    },
  };
}

/** Boot the server and start listening. */
export async function startServer(): Promise<BuiltServer> {
  const cfg = config();
  const log = createLogger({ level: cfg.logLevel, scope: 'api' });

  // Optional: apply the SQL schema when Supabase is configured and the tables
  // are missing. A failure here is logged, not fatal — the store init already
  // verified connectivity.
  if (cfg.db.autoMigrate && storeUsesSupabase(cfg.db.supabaseUrl, cfg.db.supabaseServiceRoleKey)) {
    try {
      const result = await applySupabaseSchema();
      if (result.applied) log.info('Database schema applied');
      else if (result.error) log.warn(`Schema migration skipped: ${result.error}`);
    } catch (err) {
      log.warn(`Schema migration failed: ${errorMessage(err)}`);
    }
  }

  const server = await buildServer();
  const { port, url } = await server.app.listen(cfg.port);

  log.info(`AgentReady API listening on ${url}`);
  log.info(`Store: ${server.store.kind} | env: ${cfg.env}`);
  log.info(`Free tier: 1 scan/month. Paid: $49 starter, $149 business.`);

  // Graceful shutdown so a container stop does not drop in-flight requests.
  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

function storeUsesSupabase(url: string | undefined, key: string | undefined): boolean {
  return Boolean(url && key);
}

// Only auto-start when executed directly, so importing this module in tests
// does not bind a port.
const isDirectRun =
  typeof process.argv[1] !== 'undefined' &&
  /server\.(ts|js)$/.test(process.argv[1]);

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start AgentReady API:', errorMessage(err));
    process.exit(1);
  });
}

export { SUPABASE_SCHEMA_SQL };
export * from './http.js';
export * from './store.js';
export * from './routes.js';
export * from './auth.js';
export * from './migrate.js';