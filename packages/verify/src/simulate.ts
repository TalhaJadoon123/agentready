/**
 * Agent simulation.
 *
 * The question this answers: "if a customer asked an AI assistant for
 * something you sell, would you show up, and would the answer be good enough
 * to act on?"
 *
 * Method: for each query, we give the model a fixed, clearly-labelled corpus
 * built only from the target site plus (optionally) competitor sites, and ask
 * it to answer as a shopping assistant. It must cite which source it used.
 * We then score rank and answerability from the citation.
 *
 * This is a simulation, not a real A/B against ChatGPT — and it is stated as
 * such everywhere it surfaces, because a marketing tool that pretends to
 * measure real agent traffic would be lying.
 */

import type { Simulation, SimulationReport } from '@agentready/shared';
import { config, clamp, mean, normalizeUrl, originOf, round, truncate, pct, errorMessage } from '@agentready/shared';
import { groqChat, GroqNotConfiguredError, isGroqConfigured, type GroqOptions } from './groq.js';
import { buildCorpus } from './corpus.js';
import { siteName, normalizeName } from './names.js';

/**
 * Agent personas. Each represents a different way an assistant is used, and
 * they fail in different ways — a chatbot-style persona cares about price,
 * a coding agent cares about API access.
 */
export const PERSONAS = {
  shopping: {
    name: 'shopping',
    label: 'Shopping assistant',
    system: [
      'You are a shopping assistant. A customer asks you for a product recommendation.',
      'Answer using ONLY the provided site extracts. Never invent products, prices, or availability.',
      'Cite the source site for each product you recommend.',
      'If the extracts do not contain a suitable product, say so plainly and explain what is missing.',
    ].join(' '),
  },
  research: {
    name: 'research',
    label: 'Research agent',
    system: [
      'You are a research agent comparing options for a buyer.',
      'Answer using ONLY the provided site extracts.',
      'Compare the options on price, availability and specification. Be explicit about trade-offs.',
      'Cite the source site for every claim.',
    ].join(' '),
  },
  procurement: {
    name: 'procurement',
    label: 'Procurement agent',
    system: [
      'You are a procurement agent helping a business buyer evaluate a supplier.',
      'Answer using ONLY the provided site extracts.',
      'Focus on machine-readable facts: pricing, availability, delivery, whether an API or MCP endpoint exists.',
      'Cite the source site for every claim, and state clearly if the data is insufficient to decide.',
    ].join(' '),
  },
  developer: {
    name: 'developer',
    label: 'Developer agent',
    system: [
      'You are a developer agent evaluating whether a site is programmatically usable.',
      'Answer using ONLY the provided site extracts.',
      'Report whether an MCP server, OpenAPI spec, pricing endpoint and machine auth exist, and what the rate limits are.',
      'Cite the source site for every claim.',
    ].join(' '),
  },
} as const;

export type PersonaName = keyof typeof PERSONAS;

/** Default query set. Generic enough to work for any catalogue. */
export const DEFAULT_QUERIES = [
  'What products do you sell and how much do they cost?',
  'What is currently in stock?',
  'Which product is cheapest and what does it include?',
  'Can I buy this online and how does payment work?',
  'Do you have an API or MCP server I can query programmatically?',
  'What is your most popular product?',
  'How fast is delivery and what does shipping cost?',
  'What are the specifications of your best-selling item?',
];

/** Turn a target URL + language into plausible agent queries. */
export async function generateQueries(input: {
  target: string;
  siteName?: string;
  language?: string;
  max?: number;
  groq?: GroqOptions;
}): Promise<string[]> {
  // `siteName` here is the imported helper; the caller's label is `label`.
  const { target, siteName: label, language = 'English', max = 8 } = input;

  if (!isGroqConfigured(input.groq?.apiKey)) return DEFAULT_QUERIES.slice(0, max);

  const name = label ?? siteName(target);

  try {
    const res = await groqChat(
      [
        {
          role: 'system',
          content:
            'You write realistic queries that a customer would type into an AI shopping assistant when they want to buy something. Return ONLY a JSON array of strings. No prose, no markdown fence.',
        },
        {
          role: 'user',
          content: `A customer is shopping at "${name}" (${normalizeUrl(target)}).
Write ${max} distinct queries in ${language} covering: general browsing, price, availability, specifications, ordering and payment, delivery, and programmatic/API access.
Vary the phrasing: some short and keyword-like, some full natural sentences.`,
        },
      ],
      { ...input.groq, temperature: 0.9, maxTokens: 600 },
    );

    const parsed = parseStringArray(res.text);
    return parsed.length > 0 ? parsed.slice(0, max) : DEFAULT_QUERIES.slice(0, max);
  } catch {
    // Query generation is a nice-to-have. Falling back keeps the report useful.
    return DEFAULT_QUERIES.slice(0, max);
  }
}

/** Pull a JSON string array out of a model response, fences and all. */
export function parseStringArray(raw: string): string[] {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.map(String).map((s) => s.trim()).filter(Boolean);
  } catch {
    /* try line extraction */
  }
  return cleaned
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["']|["'],?$/g, '').trim())
    .filter((l) => l.length > 8 && l.length < 200);
}

export interface SimulateInput {
  target: string;
  competitors?: string[];
  /** Explicit query list; generated from the target when omitted. */
  queries?: string[];
  personas?: PersonaName[];
  siteName?: string;
  /** Fetch each site's live content to build the corpus. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  groq?: GroqOptions;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, query: string) => void;
}

/** The instructions a persona sees, wrapped for one run. */
function personaPrompt(persona: PersonaName): string {
  return PERSONAS[persona]?.system ?? PERSONAS.shopping.system;
}

/**
 * Simulate agent queries against a target site.
 *
 * Without a Groq key this runs in `deterministic` mode: it still builds the
 * corpus and scores answerability from the site's own content, but it cannot
 * answer arbitrary queries, so the report says so explicitly rather than
 * inventing rankings.
 */
export async function simulateAgentVisibility(input: SimulateInput): Promise<SimulationReport> {
  const started = Date.now();
  const target = normalizeUrl(input.target);
  const competitors = (input.competitors ?? []).map(normalizeUrl);
  const personas = input.personas ?? (['shopping', 'procurement'] as PersonaName[]);
  const deterministic = !isGroqConfigured(input.groq?.apiKey);

  // 1. Build the corpus the model is allowed to answer from.
  const sites = [
    { url: target, name: input.siteName ?? siteName(target) },
    ...competitors.map((c) => ({ url: c, name: siteName(c) })),
  ];

  const corpora = await Promise.all(
    sites.map((s) =>
      buildCorpus(s, {
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    ),
  );

  const corpusByName = new Map(corpora.map((c) => [c.name, c]));

  // 2. Resolve the query set.
  let queries = input.queries ?? [];
  if (queries.length === 0) {
    queries = deterministic
      ? DEFAULT_QUERIES
      : await generateQueries({
          target,
          ...(input.siteName ? { siteName: input.siteName } : {}),
          max: Math.max(6, Math.min(12, personas.length * 4)),
          ...(input.groq ? { groq: input.groq } : {}),
        });
  }

  const model = deterministic ? 'deterministic' : (config().groq.model);
  const simulations: Simulation[] = [];
  const total = queries.length * personas.length;
  let done = 0;

  // 3. Run every (query, persona) pair.
  for (const query of queries) {
    for (const persona of personas) {
      const prompt = personaPrompt(persona);
      const label = `${personas.length > 1 ? `[${persona}] ` : ''}${query}`;
      let sim: Simulation;

      if (deterministic) {
        sim = deterministicSimulation(query, corpora, target, competitors);
      } else {
        try {
          const res = await groqChat(
            [
              { role: 'system', content: prompt },
              {
                role: 'user',
                content: buildPrompt(query, corpora),
              },
            ],
            {
              temperature: 0.3,
              maxTokens: 900,
              ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
              ...(input.groq ?? {}),
              ...(input.signal ? { signal: input.signal } : {}),
            },
          );
          sim = scoreSimulation(query, res.text, target, competitors, { latencyMs: res.latencyMs, tokensUsed: res.tokensUsed, model: res.model });
        } catch (err) {
          sim = {
            query: label,
            results: [],
            source: 'none',
            rank: 0,
            found: false,
            answerability: 0,
            error: errorMessage(err),
          };
        }
      }

      sim.query = label;
      simulations.push(sim);
      done++;
      input.onProgress?.(done, total, label);
    }
  }

  return buildReport({
    target,
    competitors,
    simulations,
    model,
    simulatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    deterministic,
  });
}

/** Assemble the prompt: the question, then the labelled site extracts. */
export function buildPrompt(query: string, corpora: Array<{ name: string; url: string; content: string }>): string {
  const extracts = corpora
    .filter((c) => c.content.trim().length > 0)
    .map(
      (c) =>
        `=== SITE: ${c.name} ===\nURL: ${c.url}\n${c.content}`,
    )
    .join('\n\n');

  return [
    `CUSTOMER QUERY: ${query}`,
    '',
    extracts || '(no site content was retrieved)',
    '',
    'Answer the query using only the site extracts above.',
    '',
    'Finish your answer with exactly two lines:',
    'SOURCES: <comma-separated site names you used, from the SITE: labels above>',
    'ANSWERABILITY: <0-100, how confident you are this answer is correct and actionable>',
  ].join('\n');
}

/** Parse `SOURCES:` and `ANSWERABILITY:` out of a model response. */
export function parseResponseMeta(text: string): { sources: string[]; answerability: number } {
  const sourceLine = /^SOURCES:\s*(.+)$/im.exec(text);
  const sources = sourceLine
    ? (sourceLine[1] as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const answerabilityLine = /^ANSWERABILITY:\s*(\d{1,3})/im.exec(text);
  const answerability = answerabilityLine ? clamp(Number(answerabilityLine[1]), 0, 100) : 50;

  return { sources, answerability };
}

/**
 * Turn a model response into a Simulation by matching cited site names to the
 * target and competitors.
 */
export function scoreSimulation(
  query: string,
  text: string,
  target: string,
  competitors: string[],
  meta: { latencyMs?: number; tokensUsed?: number; model?: string } = {},
): Simulation {
  const { sources, answerability } = parseResponseMeta(text);
  const targetName = siteName(target);

  const found = sources.some((s) => normalizeName(s) === normalizeName(targetName));
  // Rank 1 = target cited first. Not cited = 0.
  const index = sources.findIndex((s) => normalizeName(s) === normalizeName(targetName));
  const rank = found ? index + 1 : 0;

  // An answer that cites nobody is unanswerable regardless of confidence.
  const effectiveAnswerability = sources.length === 0 ? 0 : answerability;

  const results = [
    { source: targetName, cited: found, rank },
    ...competitors.map((c, i) => {
      const name = siteName(c);
      const idx = sources.findIndex((s) => normalizeName(s) === normalizeName(name));
      return { source: name, cited: idx > -1, rank: idx > -1 ? idx + 1 : 0, _i: i };
    }),
  ];

  return {
    query,
    results,
    source: sources[0] ?? 'none',
    rank,
    found,
    answerability: round(effectiveAnswerability, 1),
    ...(meta.latencyMs !== undefined ? { latencyMs: meta.latencyMs } : {}),
    ...(meta.tokensUsed !== undefined ? { tokensUsed: meta.tokensUsed } : {}),
    ...(meta.model ? { model: meta.model } : {}),
  };
}

/**
 * The no-API-key path.
 *
 * Scores answerability from the target's own corpus: if the site exposes
 * structured prices, availability and product content, an agent can answer.
 * We report `rank: 0` and `found: false` for ranking questions because we
 * genuinely do not know the answer without asking a model — and a report that
 * guesses is worse than one that admits the limit.
 */
export function deterministicSimulation(
  query: string,
  corpora: Array<{ name: string; url: string; content: string; signals: Record<string, unknown> }>,
  target: string,
  competitors: string[],
): Simulation {
  const targetName = siteName(target);
  const own = corpora.find((c) => normalizeName(c.name) === normalizeName(targetName));
  const content = own?.content ?? '';

  // Structural answerability: the signals that let an agent answer this query.
  const signals = (own?.signals ?? {}) as {
    productCount?: number;
    hasPrices?: number;
    hasAvailability?: number;
    hasMcp?: number;
    wordCount?: number;
    hasStructuredData?: number;
  };

  let score = 0;
  if (signals.hasStructuredData) score += 20;
  if (signals.productCount && signals.productCount > 0) score += 15;
  if (signals.hasPrices) score += 20;
  if (signals.hasAvailability) score += 15;
  if (signals.hasMcp) score += 15;
  if (signals.wordCount && signals.wordCount > 250) score += 15;

  const answerability = round(clamp(score, 0, 100), 1);

  return {
    query,
    results: [
      { source: targetName, cited: answerability >= 50, rank: answerability >= 50 ? 1 : 0 },
      ...competitors.map((c) => {
        const name = siteName(c);
        const rival = corpora.find((x) => normalizeName(x.name) === normalizeName(name));
        const rivalSignals = (rival?.signals ?? {}) as { hasPrices?: number };
        const rivalScore = rivalSignals.hasPrices ? 70 : 30;
        return { source: name, cited: rivalScore > answerability, rank: rivalScore > answerability ? 1 : 0 };
      }),
    ],
    source: answerability >= 50 ? targetName : 'none',
    rank: answerability >= 50 ? 1 : 0,
    found: answerability >= 50,
    answerability,
    // Deliberately no `error`: this is the documented no-API-key path, and the
    // report's `model` field already says "deterministic". Reporting every
    // query as errored would cry wolf and train people to ignore real errors.
  };
}



/** Aggregate simulations into a report. */
export function buildReport(input: {
  target: string;
  competitors: string[];
  simulations: Simulation[];
  model: string;
  simulatedAt: string;
  durationMs: number;
  deterministic?: boolean;
}): SimulationReport {
  const { simulations } = input;
  const targetName = siteName(input.target);

  const foundCount = simulations.filter((s) => s.found).length;
  const ranked = simulations.filter((s) => s.rank > 0);
  const averageRank = ranked.length > 0 ? mean(ranked.map((s) => s.rank)) : 0;
  const answerability = simulations.length > 0 ? mean(simulations.map((s) => s.answerability)) : 0;
  const winRate = simulations.length > 0 ? (foundCount / simulations.length) * 100 : 0;

  // Per-source breakdown, including the target.
  const allNames = [targetName, ...input.competitors.map((c) => siteName(c))];
  const bySource: SimulationReport['bySource'] = {};
  for (const name of allNames) {
    const key = normalizeName(name);
    const matching = simulations.filter((s) =>
      s.results.some((r) => normalizeName(String((r as { source: string }).source)) === key),
    );
    const withRank = matching.filter((s) => s.rank > 0);
    bySource[name] = {
      found: matching.filter((s) =>
        s.results.some(
          (r) => normalizeName(String((r as { source: string }).source)) === key && (r as { cited?: boolean }).cited,
        ),
      ).length,
      total: simulations.length,
      avgRank: withRank.length > 0 ? round(mean(withRank.map((s) => s.rank)), 2) : 0,
    };
  }

  // Visibility score: how often the target wins (50), how well it ranks (30),
  // and how answerable its answers are (20).
  const rankScore = ranked.length > 0 ? averageRank <= 1 ? 30 : averageRank <= 2 ? 22 : averageRank <= 3 ? 14 : 6 : 0;
  const visibilityScore = round(clamp(winRate * 0.5 + rankScore + answerability * 0.2, 0, 100), 1);

  return {
    target: input.target,
    competitors: input.competitors,
    queries: simulations,
    winRate: round(winRate, 1),
    averageRank: round(averageRank, 2),
    answerability: round(answerability, 1),
    visibilityScore,
    bySource,
    model: input.deterministic ? 'deterministic (no GROQ_API_KEY)' : input.model,
    simulatedAt: input.simulatedAt,
    durationMs: input.durationMs,
  };
}

/** Human-readable summary for the CLI and email reports. */
export function formatSimulationReport(report: SimulationReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  Agent Visibility: ${report.visibilityScore}/100`);
  lines.push(`  ${report.target}`);
  lines.push('');
  lines.push(`  Queries run        ${report.queries.length}`);
  lines.push(`  Target found       ${pct(report.queries.filter((q) => q.found).length, report.queries.length)}%`);
  lines.push(`  Average rank       ${report.averageRank > 0 ? report.averageRank.toFixed(2) : 'not ranked'}`);
  lines.push(`  Answerability      ${report.answerability}%`);
  lines.push(`  Model              ${report.model}`);
  lines.push('');
  lines.push('  Per source');
  for (const [name, stats] of Object.entries(report.bySource)) {
    lines.push(`    ${name.padEnd(28)} cited in ${pct(stats.found, stats.total)}% of queries`);
  }
  const errors = report.queries.filter((q) => q.error);
  if (errors.length > 0) {
    lines.push('');
    lines.push(`  ${errors.length} quer${errors.length === 1 ? 'y' : 'ies'} errored.`);
    lines.push(`    ${truncate(errors[0]?.error ?? '', 90)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Re-export so callers can catch the specific "no key" failure. */
export { GroqNotConfiguredError } from './groq.js';