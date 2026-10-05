#!/usr/bin/env node
/**
 * `agentready` entry point.
 *
 * Prefers the compiled build; falls back to Node's native TypeScript stripping
 * so the CLI works from a fresh clone with no build step.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'dist', 'index.js');

if (existsSync(compiled)) {
  await import(new URL(`file://${compiled}`).href);
} else {
  const { spawnSync } = await import('node:child_process');
  const source = join(here, '..', 'src', 'index.ts');
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', source, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}