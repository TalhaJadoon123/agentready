/**
 * Pillar 3 — Agent-readable content.
 *
 * Agents do not scroll or skim. They fetch a page, get a wall of markup, and
 * decide whether it answers the question. We reward a machine-readable summary
 * (llms.txt), answer-shaped prose, clean headings, a canonical identity, and
 * descriptive meta — and punish JavaScript-only rendering and thin content.
 */

import { buildResult, partial } from './base.js';
import type { ScanContext } from '../context.js';

export async function checkAgentContent(ctx: ScanContext) {
  const { page } = ctx;

  const llmsTxt = ctx.wellKnown['/llms.txt'];
  const hasLlmsTxt = Boolean(llmsTxt?.ok && (llmsTxt.body ?? '').trim().length > 40);
  const llmsFull = ctx.wellKnown['/llms-full.txt'];

  const hasTitle = page.title.length >= 10 && page.title.length <= 120;
  const hasDescription = page.metaDescription.length >= 50;
  const hasCanonical = page.canonical.length > 0;
  const hasH1 = page.headings.some((h) => h.level === 1);
  const h2Count = page.headings.filter((h) => h.level === 2).length;

  // Answer-shaped content: question headings, or explicit Q&A phrasing.
  const questionHeadings = page.headings.filter((h) => /^(how|what|why|when|where|which|can|does|is|are)\b/i.test(h.text)).length;
  const faqSchema = ctx.page.jsonLd.some((n) => {
    const t = n['@type'];
    const types = Array.isArray(t) ? t : [t];
    return types.some((x) => typeof x === 'string' && /faq|question/i.test(x));
  });

  // Substantive prose. Below ~250 words an agent gets nothing useful.
  const substantive = page.wordCount >= 250;
  const strong = page.wordCount >= 800;

  // Client-rendered content is invisible to most fetch-based agents.
  const framework = detectFramework(page.meta['generator'] ?? '', ctx.html);
  const jsHeavy = framework === 'next' || framework === 'nuxt' || framework === 'gatsby';
  const textToHtmlRatio = ctx.html.length > 0 ? page.text.length / ctx.html.length : 0;
  const thin = textToHtmlRatio < 0.08;

  // Points: 4 llms.txt, 2 llms-full, 2 title, 1 description, 1 canonical,
  //         1 h1+h2 structure, 1 answer-shaped content.
  let points = 0;
  points += hasLlmsTxt ? 4 : 0;
  points += llmsFull?.ok ? 2 : 0;
  points += hasTitle ? 2 : 0;
  points += hasDescription ? 1 : 0;
  points += hasCanonical ? 1 : 0;
  points += hasH1 && h2Count >= 2 ? 1 : 0;
  points += questionHeadings > 0 || faqSchema ? 1 : 0;

  // Substantive content is a modifier, not a separate bucket: it scales the
  // content portion rather than dominating the score.
  if (strong) points += 1;
  else if (substantive) points += 0.5;

  const status = hasLlmsTxt && substantive && hasTitle ? 'pass' : hasTitle && (substantive || hasLlmsTxt) ? 'warn' : 'fail';

  const fixes: string[] = [];
  if (!hasLlmsTxt) {
    fixes.push(
      'Add an /llms.txt at your site root: a markdown summary of who you are, what you sell, and where the detail lives.',
    );
  }
  if (!substantive) {
    fixes.push(`Only ${page.wordCount} words of readable text. Agents need at least ~250 words of real prose to answer confidently.`);
  }
  if (thin) {
    fixes.push('Most of your HTML is script/style. Server-render your content so agents can read it without executing JS.');
  }
  if (!hasH1) fixes.push('Add exactly one <h1> that states what the page offers.');
  if (h2Count < 2) fixes.push('Break content into <h2> sections — agents use headings to build their outline.');
  if (!hasDescription) fixes.push('Write a meta description of 50-160 characters that answers "what is this page".');
  if (!hasCanonical) fixes.push('Set <link rel="canonical"> so agents do not index duplicates.');
  if (questionHeadings === 0 && !faqSchema) {
    fixes.push('Add a FAQ section with question-shaped headings and FAQPage schema — this is the most-cited format by agents.');
  }

  const summary = hasLlmsTxt
    ? `Site publishes /llms.txt for agents; ${page.wordCount} words of readable content.`
    : `No /llms.txt. ${page.wordCount} words of readable content${thin ? ', and text-to-markup ratio is very low.' : '.'}`;

  return buildResult(
    'agent-content',
    status,
    points,
    summary,
    fixes,
    {
      hasLlmsTxt,
      hasLlmsFull: Boolean(llmsFull?.ok),
      wordCount: page.wordCount,
      substantive,
      textToHtmlRatio: Math.round(textToHtmlRatio * 1000) / 1000,
      framework,
      jsHeavy,
      headingCount: page.headings.length,
      h1Count: page.headings.filter((h) => h.level === 1).length,
      h2Count,
      questionHeadings,
      faqSchema,
      hasTitle,
      hasDescription,
      hasCanonical,
      lang: page.lang,
      hreflangCount: page.hreflang.length,
    },
  );
}

/** Best-effort framework detection for the JS-rendering penalty. */
export function detectFramework(generator: string, html: string): string {
  const g = generator.toLowerCase();
  if (g.includes('next')) return 'next';
  if (g.includes('nuxt')) return 'nuxt';
  if (g.includes('gatsby')) return 'gatsby';
  if (/__NEXT_DATA__|_next\/static/.test(html)) return 'next';
  if (/__NUXT__|\/_nuxt\//.test(html)) return 'nuxt';
  if (/___gatsby/.test(html)) return 'gatsby';
  if (/<script[^>]+wp-content|wp-includes/.test(html)) return 'wordpress';
  if (/cdn\.shopify\.com|Shopify\.theme/.test(html)) return 'shopify';
  return 'unknown';
}