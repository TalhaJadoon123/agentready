/**
 * Alerting.
 *
 * Email via Resend's free tier (3,000/month) or useSend. When neither key is
 * configured, alerts are logged and returned rather than silently dropped —
 * a monitoring tool that cannot say anything when it fails is worse than none.
 */

import type { Alert, AlertSeverity, RegistryStatus, ScanResult, UptimeReport } from '@agentready/shared';
import { config, errorMessage, hasApiKey, logger, newId, pct, round } from '@agentready/shared';

/** Where an alert came from. */
export type AlertSource = Alert['source'];

export interface EmailTransport {
  send(opts: { to: string; subject: string; html: string; text: string }): Promise<{ id?: string }>;
}

/** Resend transport (free tier: 3,000 emails/month). */
export function createResendTransport(apiKey: string): EmailTransport {
  return {
    async send({ to, subject, html, text }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: config().email.from,
          to: [to],
          subject,
          html,
          text,
        }),
      });

      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${body.message ?? 'unknown error'}`);
      return { ...(body.id ? { id: body.id } : {}) };
    },
  };
}

/** Console transport — the default when no email key is set. */
export function createConsoleTransport(): EmailTransport {
  return {
    async send({ subject, text }) {
      logger.info(`[email:console] ${subject}`, { preview: text.slice(0, 200) });
      return {};
    },
  };
}

/** Pick the best available transport. */
export function defaultTransport(): EmailTransport {
  const cfg = config();
  if (cfg.email.provider === 'resend' && hasApiKey(cfg.auth.resendApiKey)) {
    return createResendTransport(cfg.auth.resendApiKey as string);
  }
  return createConsoleTransport();
}

export interface DispatchResult {
  alert: Alert;
  delivered: string[];
  errors: string[];
}

/** Build an alert object. */
export function buildAlert(
  severity: AlertSeverity,
  source: AlertSource,
  title: string,
  message: string,
): Alert {
  return {
    id: newId('alert'),
    severity,
    source,
    title,
    message,
    createdAt: new Date().toISOString(),
    delivered: [],
    resolved: false,
  };
}

/**
 * Send an alert.
 *
 * @param recipients Overrides the configured alert address.
 */
export async function dispatchAlert(
  alert: Alert,
  options: { recipients?: string[]; transport?: EmailTransport } = {},
): Promise<DispatchResult> {
  const cfg = config();
  const recipients = options.recipients ?? (cfg.email.alertEmail ? [cfg.email.alertEmail] : []);
  const transport = options.transport ?? defaultTransport();
  const errors: string[] = [];

  if (recipients.length === 0) {
    logger[alert.severity === 'critical' ? 'error' : 'warn']('Alert raised but no recipient configured', {
      id: alert.id,
      title: alert.title,
    });
    return { alert, delivered: [], errors: ['No alert recipient configured (set ALERT_EMAIL).'] };
  }

  const { html, text } = renderAlert(alert);

  for (const to of recipients) {
    try {
      await transport.send({ to, subject: `[AgentReady ${alert.severity.toUpperCase()}] ${alert.title}`, html, text });
      alert.delivered?.push(to);
    } catch (err) {
      errors.push(`${to}: ${errorMessage(err)}`);
    }
  }

  return { alert, delivered: alert.delivered ?? [], errors };
}

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: '#0b7285',
  warning: '#b26a00',
  critical: '#c92a2a',
};

/** Render an alert as HTML + plain text. */
export function renderAlert(alert: Alert): { html: string; text: string } {
  const color = SEVERITY_COLOR[alert.severity];
  const text = [
    `${alert.severity.toUpperCase()}: ${alert.title}`,
    '',
    alert.message,
    '',
    `Source: ${alert.source}`,
    `Raised: ${alert.createdAt}`,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8f9fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#212529">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;border-left:4px solid ${color};padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.1)">
    <div style="display:inline-block;background:${color};color:#fff;font-size:11px;font-weight:700;letter-spacing:.08em;padding:4px 10px;border-radius:4px;text-transform:uppercase">${alert.severity}</div>
    <h1 style="font-size:18px;margin:16px 0 8px">${escapeHtml(alert.title)}</h1>
    <p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:#495057">${escapeHtml(alert.message).replace(/\n/g, '<br>')}</p>
    <hr style="border:none;border-top:1px solid #dee2e6;margin:16px 0">
    <p style="font-size:12px;color:#868e96;margin:0">Source: ${escapeHtml(alert.source)} · ${escapeHtml(alert.createdAt)}</p>
    <p style="font-size:12px;margin:8px 0 0"><a href="https://agentready.dev/dashboard" style="color:#1c7ed6">View in AgentReady</a></p>
  </div>
</body></html>`;

  return { html, text };
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

// ---------------------------------------------------------------------------
// Alert rules
// ---------------------------------------------------------------------------

/** Score dropped by this much, or below this absolute value. */
export const SCORE_DROP_THRESHOLD = 10;

/** Raise an alert when a site's readiness score regressed. */
export function scoreRegressionAlert(previous: ScanResult, current: ScanResult): Alert | undefined {
  const drop = round(previous.score - current.score, 1);
  if (drop < SCORE_DROP_THRESHOLD && current.score >= 40) return undefined;

  return buildAlert(
    current.score < 40 ? 'critical' : 'warning',
    'scan',
    `Readiness score ${previous.score} -> ${current.score}`,
    [
      `${current.url} dropped ${drop} points since the last scan.`,
      '',
      'Checks that regressed:',
      ...current.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => `  - ${c.title}: ${c.points}/${c.maxPoints} — ${c.summary}`),
      '',
      `Run: agentready scan ${current.url}`,
    ].join('\n'),
  );
}

/** Raise an alert when the MCP server goes down or loses tools. */
export function mcpHealthAlert(input: {
  serverName: string;
  url: string;
  status: 'live' | 'down';
  toolCount: number;
  previousToolCount?: number;
  error?: string;
}): Alert | undefined {
  if (input.status === 'down') {
    return buildAlert(
      'critical',
      'mcp',
      `MCP server down: ${input.serverName}`,
      `${input.url} is not responding.\n\n${input.error ?? 'No error detail was returned.'}\n\nAgents cannot query this catalogue until it is back.`,
    );
  }

  if (input.previousToolCount !== undefined && input.toolCount < input.previousToolCount) {
    return buildAlert(
      'warning',
      'mcp',
      `MCP server lost tools: ${input.serverName}`,
      `${input.url} exposed ${input.toolCount} tool(s), down from ${input.previousToolCount}. A removed tool breaks every agent that called it.`,
    );
  }

  return undefined;
}

/** Raise an alert when a registry listing drifts or disappears. */
export function registryDriftAlert(statuses: RegistryStatus[]): Alert[] {
  const alerts: Alert[] = [];

  for (const status of statuses) {
    if (status.state === 'missing') {
      alerts.push(
        buildAlert(
          'warning',
          'registry',
          `Not listed in ${status.label}`,
          `The server is not present in ${status.label}. Agents browsing that registry cannot find it.${status.detail ? `\n\n${status.detail}` : ''}`,
        ),
      );
    } else if (status.state === 'drifted') {
      alerts.push(
        buildAlert(
          'warning',
          'registry',
          `Version drift in ${status.label}`,
          `${status.detail ?? 'The published version does not match the deployed version.'}`,
        ),
      );
    } else if (status.state === 'error') {
      alerts.push(
        buildAlert('warning', 'registry', `Cannot reach ${status.label}`, status.detail ?? 'Unknown error.'),
      );
    }
  }

  return alerts;
}

/** Raise an alert when uptime drops below the SLO. */
export function uptimeAlert(report: UptimeReport, thresholds: { warning?: number; critical?: number } = {}): Alert | undefined {
  const warning = thresholds.warning ?? 99;
  const critical = thresholds.critical ?? 95;

  if (report.totalChecks === 0) return undefined;
  if (report.uptimeRatio >= warning) return undefined;

  const severity: AlertSeverity = report.uptimeRatio < critical ? 'critical' : 'warning';
  const failures = report.samples.filter((s) => !s.ok);

  return buildAlert(
    severity,
    'uptime',
    `Uptime ${report.uptimeRatio}% on ${report.target}`,
    [
      `${report.totalChecks - report.failedChecks}/${report.totalChecks} checks passed over ${report.from} to ${report.to}.`,
      `p95 latency: ${report.p95LatencyMs}ms`,
      '',
      'Recent failures:',
      ...failures
        .slice(0, 5)
        .map((f) => `  ${f.checkedAt} ${f.error ?? `HTTP ${f.statusCode}`}`),
      '',
      `Uptime rate: ${pct(report.totalChecks - report.failedChecks, report.totalChecks)}%`,
    ].join('\n'),
  );
}

/** Raise an alert when agent verification drops. */
export function visibilityAlert(input: {
  target: string;
  previous: number;
  current: number;
  winRate?: number;
}): Alert | undefined {
  const drop = round(input.previous - input.current, 1);
  if (drop < 5) return undefined;

  return buildAlert(
    drop >= 20 ? 'critical' : 'warning',
    'verification',
    `Agent visibility down for ${new URL(input.target).hostname}`,
    [
      `Visibility score fell ${drop} points: ${input.previous} → ${input.current}.`,
      input.winRate !== undefined ? `Win rate is now ${input.winRate}%.` : '',
      '',
      'An agent querying your category is more likely to recommend a competitor.',
      `Run: agentready simulate ${input.target}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/**
 * Evaluate a set of possible alerts, keeping the highest severity per source.
 * Avoids alert storms when several checks fail at once.
 */
export function dedupeAlerts(alerts: Alert[]): Alert[] {
  const bySource = new Map<string, Alert>();
  const rank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

  for (const alert of alerts) {
    const existing = bySource.get(alert.source);
    if (!existing || rank[alert.severity] < rank[existing.severity]) {
      bySource.set(alert.source, alert);
    }
  }

  return [...bySource.values()];
}
