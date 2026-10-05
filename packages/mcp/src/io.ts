/** Small IO helpers. Split out so the loaders stay testable and pure-ish. */

import { readFile as fsReadFile } from 'node:fs/promises';

/** Read a local file as UTF-8. */
export async function readFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf8');
}

/**
 * Fetch remote text.
 *
 * No retry here on purpose — Cloudflare Workers and Smithery both lack a
 * filesystem, and retry storms against a free-tier API help nobody.
 */
export async function fetchText(url: string, fetchImpl?: typeof fetch): Promise<string | undefined> {
  try {
    const res = await (fetchImpl ?? fetch)(url, {
      headers: {
        accept: 'application/json, text/csv, text/html;q=0.9, */*;q=0.8',
        'user-agent': 'AgentReady/1.0 (+https://agentready.dev)',
      },
    });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}