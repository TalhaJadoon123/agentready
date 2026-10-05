/**
 * Minimal structured logger. No dependency, no PII, JSON in production and
 * pretty in development.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<LogLevel, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  pretty?: boolean;
  /** Injectable sink for tests. */
  sink?: (line: string, level: LogLevel) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const pretty = opts.pretty ?? process.env.NODE_ENV !== 'production';
  const sink: LoggerOptions['sink'] =
    opts.sink ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
    const scope = opts.scope ?? 'agentready';
    const ts = new Date().toISOString();
    if (pretty) {
      const color = COLORS[lvl];
      const head = `${color}${lvl.toUpperCase().padEnd(5)}${RESET} ${ts} ${color}${scope}${RESET} ${msg}`;
      if (meta && Object.keys(meta).length > 0) {
        sink(`${head} ${JSON.stringify(meta)}`, lvl);
      } else {
        sink(head, lvl);
      }
    } else {
      sink(JSON.stringify({ ts, level: lvl, scope, msg, ...meta }), lvl);
    }
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (scope: string) => createLogger({ ...opts, scope: `${opts.scope ?? 'agentready'}:${scope}` }),
  };
}

export const logger: Logger = createLogger();

/** Turn an unknown thrown value into a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}