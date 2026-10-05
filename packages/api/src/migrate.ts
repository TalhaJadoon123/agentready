/**
 * Schema migration for Supabase.
 *
 * Applies SUPABASE_SCHEMA_SQL via PostgREST's RPC endpoint when possible, and
 * otherwise prints the exact SQL to paste into the dashboard. Supabase does not
 * expose DDL over REST by default, so the honest behaviour is: try, and if we
 * cannot, tell the user precisely what to run.
 */

import { config, errorMessage, hasApiKey, logger } from '@agentready/shared';
import { SUPABASE_SCHEMA_SQL } from './store.js';

export interface MigrationResult {
  applied: boolean;
  error?: string;
  /** The SQL to run manually, when we could not apply it. */
  sql: string;
}

/**
 * Apply the schema.
 *
 * Requires a Postgres function in your Supabase project that can execute DDL;
 * AgentReady creates one when it is missing.
 */
export async function applySupabaseSchema(): Promise<MigrationResult> {
  const cfg = config();
  const url = cfg.db.supabaseUrl;
  const key = cfg.db.supabaseServiceRoleKey;

  if (!hasApiKey(url) || !hasApiKey(key)) {
    return { applied: false, error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.', sql: SUPABASE_SCHEMA_SQL };
  }

  const rest = `${(url as string).replace(/\/$/, '')}/rest/v1`;

  try {
    // 1. Does the exec_sql helper exist? It lets us run DDL over PostgREST.
    const probe = await fetch(`${rest}/rpc/exec_sql`, {
      method: 'POST',
      headers: { apikey: key as string, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: 'select 1' }),
    });

    if (probe.status === 404) {
      // Helper missing. Tell the user exactly what to run once.
      const bootstrap = [
        '-- Run this ONCE in the Supabase SQL editor, then AUTO_MIGRATE will work.',
        'create or replace function exec_sql(sql text) returns void',
        'language plpgsql security definer as $$ begin execute sql; end; $$;',
      ].join('\n');

      return {
        applied: false,
        error: 'The exec_sql helper function does not exist in your Supabase project.',
        sql: `${bootstrap}\n\n${SUPABASE_SCHEMA_SQL}`,
      };
    }

    if (!probe.ok) {
      const text = await probe.text();
      return { applied: false, error: `exec_sql probe failed (HTTP ${probe.status}): ${text.slice(0, 200)}`, sql: SUPABASE_SCHEMA_SQL };
    }

    // 2. Run the real schema.
    const res = await fetch(`${rest}/rpc/exec_sql`, {
      method: 'POST',
      headers: { apikey: key as string, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: SUPABASE_SCHEMA_SQL }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { applied: false, error: `exec_sql failed (HTTP ${res.status}): ${text.slice(0, 300)}`, sql: SUPABASE_SCHEMA_SQL };
    }

    return { applied: true, sql: SUPABASE_SCHEMA_SQL };
  } catch (err) {
    return { applied: false, error: errorMessage(err), sql: SUPABASE_SCHEMA_SQL };
  }
}

/**
 * Verify the expected tables exist and are reachable.
 * Used by the health endpoint and by the CLI's `verify` command.
 */
export async function checkSchema(): Promise<{ ok: boolean; tables: string[]; missing: string[]; error?: string }> {
  const cfg = config();
  const url = cfg.db.supabaseUrl;
  const key = cfg.db.supabaseServiceRoleKey;

  if (!hasApiKey(url) || !hasApiKey(key)) {
    return { ok: true, tables: [], missing: [], error: 'Supabase is not configured; using the file store.' };
  }

  const expected = ['users', 'sites', 'scans', 'mcp_servers', 'agent_events'];
  const present: string[] = [];
  const missing: string[] = [];

  try {
    for (const table of expected) {
      const res = await fetch(`${(url as string).replace(/\/$/, '')}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: key as string, authorization: `Bearer ${key}`, prefer: 'count=exact' },
      });
      if (res.ok) present.push(table);
      else missing.push(table);
    }
    return { ok: missing.length === 0, tables: present, missing };
  } catch (err) {
    return { ok: false, tables: present, missing, error: errorMessage(err) };
  }
}

/** CLI entry point: `npm run db:migrate`. */
export async function main(): Promise<void> {
  const result = await applySupabaseSchema();
  if (result.applied) {
    logger.info('Schema applied successfully.');
    return;
  }
  logger.error(`Could not auto-apply the schema: ${result.error ?? 'unknown error'}`);
  logger.info('Run this SQL in the Supabase SQL editor:');
  logger.info(result.sql);
  process.exitCode = 1;
}

// Run when invoked directly.
if (typeof process.argv[1] !== 'undefined' && /migrate\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    logger.error(errorMessage(err));
    process.exitCode = 1;
  });
}